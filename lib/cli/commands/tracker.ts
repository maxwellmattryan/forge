// Tracker commands, starting jobs from tracker refs, and `forge sync` (PRs + trackers for every job).
import { DEP_REASON, claimRespectingDeps, refreshDependencyWait, retargetPlan, unmetDependencies } from '#engine/pipeline/moves/deps.ts';
import { createJob, isActive, leaseStatus, listJobs, loadJob, logEvent, readEvents, claimJob } from '#core/job/store.ts';
import { approvedBy, escalationApproval } from '#engine/pr/body.ts';
import { deferredMergeDue } from '#engine/pr/merge.ts';
import { continueQueued, releaseOverlapWaits } from '#engine/pipeline/moves/merge-queue.ts';
import { retargetPr } from '#engine/pr/open.ts';
import { syncPr } from '#engine/pr/sync.ts';
import { ghGitHub } from '#integrations/github/pull-requests.ts';
import { measureOutcomes } from '#engine/evals/outcome.ts';
import { queueScores } from '#engine/evals/scoring.ts';
import { refreshRequest } from '#engine/trackers/request-refresh.ts';
import { listRequests } from '#core/job/requests.ts';
import { checkRepoBudget, isRepoHold, repoBudgetBlock } from '#engine/metrics/repo-budget.ts';
import { applyRetention } from '#engine/ops/retention.ts';
import { queueRetro } from '#engine/evals/retro.ts';
import { mirrorJob, moveJob } from '#engine/pipeline/moves/apply.ts';
import { searchTerms } from '#core/job/issue-link.ts';
import { checkIssueRef, isSafeUrl, nativeRef, nativeRefs, parseIssueRef, primaryIssue, sameIssue } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { memberClone, memberConfig, recordJobRepo } from '#engine/project/job-repos.ts';
import { memberCheck, readLocalConfig } from '#engine/project/member-repos.ts';
import { clampLimit, publicHits, searchTracker } from '#engine/trackers/link.ts';
import { loadTracker, memberTracker } from '#engine/trackers/load.ts';
import { memberIssues } from '#engine/trackers/mirror.ts';
import { memberForRef, memberTrackerConfig, memberTrackers, qualify, type MemberTracker } from '#engine/project/member-trackers.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, applyTriage, prepareTriage } from '#engine/trackers/triage.ts';
import { dashRunning, reconcile, type ReconcileResult } from '#office/reconcile.ts';
import { mandateRefusal } from '#office/foreman/policy.ts';
import { jobMandateScoring } from '#office/mandates/store.ts';
import { ForgeError } from '#core/errors.ts';
import { removeWorktree } from '#engine/workspace/worktree.ts';
import { bodyFrom, list, num, req, str, usageError } from './args.ts';
import type { Config, Job, JobPr, Tracker, TrackerItem } from '#core/types.ts';
import type { HelpGroup } from '../types.ts';

const TRACKER_EXITS: [1 | 5, string][] = [
  [1, 'the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found)'],
  [5, 'gh failed (GitHub tracker)'],
];
const BODY: [string, string][] = [['--body B', 'the text'], ['--body-file F', "read the text from F (- for stdin); in a daemon session F must be inside the session job's folder or worktree"]];

const TRACKER: HelpGroup = {
  name: 'tracker',
  summary: 'the configured issue tracker (tracker.kind): items, claims, comments; under github a <ref> is an issue in this repo (12, #12 or owner/repo#12)',
  commands: [
    {
      command: 'tracker list',
      args: '[--ready] [--limit N]',
      summary: 'tracker items, without bodies',
      flags: [
        ['--ready', 'only items ready to start'],
        ['--limit N', 'at most N items (0: no limit)'],
      ],
      exits: TRACKER_EXITS,
    },
    { command: 'tracker get', args: '<ref>', summary: 'one tracker item', exits: TRACKER_EXITS },
    {
      command: 'tracker search',
      args: '<query> [--limit N] [--job <id>]',
      summary: 'search the tracker',
      flags: [
        ['--limit N', 'at most N items (default 5, at most 20)'],
        ['--job <id>', "search for the words of a job's title"],
      ],
      exits: TRACKER_EXITS,
      docs: ['Linking jobs to issues', 'docs/TRACKERS.md#linking-jobs-to-issues'],
      common: true,
    },
    { command: 'tracker claim', args: '<ref> <job>', summary: 'mark an item as taken by a job', exits: TRACKER_EXITS },
    { command: 'tracker update', args: '<ref> <job>', summary: "mirror a job's status to its item", exits: TRACKER_EXITS },
    { command: 'tracker comment', args: '<ref> [--body B | --body-file F]', summary: 'comment on an item', flags: BODY, exits: TRACKER_EXITS },
    {
      command: 'tracker create',
      args: '--title T [--body B | --body-file F] [--label L]... [--parent REF]',
      summary: 'create an item',
      flags: [['--title T', 'the title (required)'], ...BODY, ['--label L', 'a label (repeatable, or comma-separated)'], ['--parent REF', 'the parent item']],
      exits: TRACKER_EXITS,
    },
    { command: 'tracker close', args: '<ref> [--reason R]', summary: 'close an item', flags: [['--reason R', 'why, where the tracker records one']], exits: TRACKER_EXITS },
    {
      command: 'tracker triage',
      args: '[--limit N] [--all] | --apply <batch>',
      summary: 'readiness triage: write a batch of ready and needs-info items for the forge:triage agent, then apply its verdicts (a templated comment and the needs-info mark, or the mark cleared)',
      flags: [
        ['--limit N', `at most N ready and N needs-info items (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT})`],
        ['--all', 'also judge items unchanged since their last triage'],
        ['--apply <batch>', "apply the batch's verdicts.json"],
      ],
      exits: TRACKER_EXITS,
      docs: ['Readiness triage', 'docs/TRACKERS.md#readiness-triage'],
      common: true,
    },
  ],
};

export const HELP: HelpGroup[] = [
  {
    name: 'next',
    summary: 'take the next piece of work',
    commands: [
      {
        command: 'next',
        args: '[--claim --session S] [--force] [--limit N]',
        summary: "resume a queued unowned job (with --claim --session), else the next ready tracker item whose job is not blocked, skipping needs-info items (with --claim, start its job): the root tracker's first, then each member repo's tracker (config repos), whose items carry repo and an owner/name#N ref; a member that can't be read is listed in skippedRepos; while the repo budget holds new work it starts nothing and prints {held: true, repoBudget}",
        flags: [
          ['--claim', 'claim the work instead of only showing it'],
          ['--session S', 'the session claiming it'],
          ['--force', "don't skip items whose job waits on dependencies"],
          ['--limit N', 'read at most N ready items (default 20)'],
        ],
        exits: [
          [1, 'the tracker failed'],
          [3, 'the tracker claim was lost to another job'],
          [5, 'gh failed (GitHub tracker)'],
        ],
      },
    ],
  },
  {
    name: 'sync',
    summary: 'reconcile PRs and trackers for all jobs',
    commands: [{ command: 'sync', args: '', summary: "reconcile PRs and trackers for every job, measure merged jobs' outcomes (revert, follow-up bugs, churn; at most 10 per run), queue a post-merge judge score run for sampled merged jobs and every merged job of a mandate that scores all (scoring.sample, the mandate's scoring term; at most 5 per run), retarget stacked PRs, release dependency waits and the merge queue's holds, and finish umbrella jobs; a job's failure is reported in its result. Then the reconciler's pass, unless a running forge dash owns it: `reconcile` lists the running jobs it resumed or escalated for having nothing to drive them, the requests it requeued and the stale resume requests it closed" }],
  },
  TRACKER,
];

/** The result is printed as JSON. */
export async function trackerCmd(root: string, config: Config, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<unknown> {
  const tracker = await loadTracker(root, config);
  const ctx = { root, config };
  switch (sub) {
    case 'list': {
      // 0 keeps meaning no limit.
      const limit = num(flags.limit, '--limit', { integer: true });
      return tracker.list(ctx, { ready: Boolean(flags.ready), limit: limit || undefined }).map(({ body: _b, ...i }) => i);
    }
    case 'get':
      return tracker.get(ctx, req(rest[0], 'ref'));
    case 'claim':
      return tracker.claim(ctx, req(rest[0], 'ref'), loadJob(root, req(rest[1], 'job id')));
    case 'update':
      tracker.update(ctx, req(rest[0], 'ref'), loadJob(root, req(rest[1], 'job id')));
      return { ok: true };
    case 'comment':
      tracker.comment(ctx, req(rest[0], 'ref'), bodyFrom(flags, root, config));
      return { ok: true };
    case 'create':
      return tracker.create(ctx, { title: req(flags.title, '--title'), body: bodyFrom(flags, root, config), labels: list(flags.label), parentRef: flags.parent ?? null });
    case 'close':
      tracker.close(ctx, req(rest[0], 'ref'), { reason: flags.reason });
      return { ok: true };
    case 'triage': {
      if (flags.apply !== undefined) {
        if (flags.all !== undefined) throw new ForgeError('--all and --apply are separate calls', 'usage');
        return applyTriage(root, config, tracker, req(str(flags.apply, '--apply'), '--apply <batch>'));
      }
      const limit = num(flags.limit, '--limit', { integer: true });
      return prepareTriage(root, config, tracker, { limit: Math.min(MAX_LIMIT, Math.max(1, limit ?? DEFAULT_LIMIT)), all: Boolean(flags.all) });
    }
    case 'search': {
      let query = rest.join(' ').trim();
      if (!query && typeof flags.job === 'string') query = searchTerms(loadJob(root, flags.job).title).join(' ');
      const r = searchTracker(root, config, tracker, req(query, 'query (or --job <id>)'), clampLimit(flags.limit));
      return { tracker: r.tracker, query: r.query, items: publicHits(r.items) };
    }
    default:
      throw usageError(TRACKER);
  }
}

/**
 * Queued jobs nobody drives, oldest first: active, not eval, not an umbrella, dependencies done,
 * no resume hand-off pending or in progress, and no live lease.
 */
function resumeCandidates(root: string): Job[] {
  const handedOff = new Set(listRequests(root).filter((r) => r.type === 'resume' && (r.status === 'pending' || r.status === 'in-progress') && r.job).map((r) => r.job));
  return listJobs(root)
    .filter((j) => isActive(j) && j.state === 'queued' && j.kind !== 'eval' && !j.children?.length && !handedOff.has(j.id) && !unmetDependencies(root, j).length)
    .filter((j) => leaseStatus(j).status !== 'live')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

/** Claims the first resumable job for `session`, or null. A claim lost to a race moves on. */
function resumeQueued(root: string, session: string): Job | null {
  for (const candidate of resumeCandidates(root)) {
    try {
      return claimRespectingDeps(root, candidate.id, session, false).job;
    } catch (e) {
      if (e instanceof ForgeError && (e.exitCode === 3 || e.exitCode === 4)) continue;
      throw e;
    }
  }
  return null;
}

type Blocked = { ref: string; id: string; waitingOn: string[] };
/** A member repo whose tracker `next` could not read: its clone failed doctor's check, or the tracker threw. */
type Skipped = { repo: string; reason: string };
/** A ready item; a member repo's carries `repo` and an `owner/name#N` ref. */
type ReadyItem = TrackerItem & { repo?: string };

/**
 * Ready tracker items, minus those whose active job waits on dependencies (listed as `blocked`):
 * the root tracker's first, then each member repo tracker's in config order. A member that can't
 * be read is listed in `skipped` instead; the root tracker's failure still throws.
 */
function readyItems(root: string, config: Config, tracker: Tracker, flags: Record<string, any>, limit: number): { ready: ReadyItem[]; blocked: Blocked[]; skipped: Skipped[] } {
  // A custom adapter may return needs-info items in a ready list; triage asked for more first.
  const items = tracker.list({ root, config }, { ready: true, limit }).filter((i) => !i.needsInfo);
  const blocked: Blocked[] = [];
  // --force skips nothing. Otherwise an item is blocked when the active job it would resume
  // (the same match startFromRef uses) has unmet dependencies.
  const slug = localRepoSlug(root, config);
  const active = flags.force ? [] : listJobs(root).filter((j) => isActive(j) && j.issues.length);
  const ready: ReadyItem[] = items.filter((i) => {
    // unmet is empty unless a job was found.
    const job = active.find((j) => nativeRefs(j, config.tracker.kind, slug).includes(String(i.ref)));
    const unmet = job ? unmetDependencies(root, job) : [];
    if (unmet.length) blocked.push({ ref: i.ref, id: job!.id, waitingOn: unmet.map((u) => u.id) });
    return !unmet.length;
  });
  const skipped: Skipped[] = [];
  const members = memberTrackers(root, config);
  // Read once for every member: doctor's check takes the parsed file.
  const local = members.length ? readLocalConfig(root) : null;
  for (const m of members) {
    const skip = (reason: string) => skipped.push({ repo: m.name, reason: reason.slice(0, 300) });
    const check = memberCheck(root, config, memberConfig(config, m.name), local!);
    if (!check.ok) {
      skip(check.detail);
      continue;
    }
    let listed: TrackerItem[];
    try {
      listed = memberTracker().list({ root, config: memberTrackerConfig(config, m.slug) }, { ready: true, limit });
    } catch (e) {
      skip((e as Error).message);
      continue;
    }
    for (const i of listed) {
      if (i.needsInfo) continue;
      const ref = qualify(m.slug, i.ref);
      const job = active.find((j) => j.issues.some((x) => sameIssue(x, { tracker: 'github', ref }, slug)));
      const unmet = job ? unmetDependencies(root, job) : [];
      if (unmet.length) blocked.push({ ref, id: job!.id, waitingOn: unmet.map((u) => u.id) });
      else ready.push({ ...i, ref, repo: m.name });
    }
  }
  return { ready, blocked, skipped };
}

/** `forge next --claim` and `forge job from-ref`. The result is printed as JSON. */
export async function nextCmd(root: string, config: Config, flags: Record<string, any>): Promise<unknown> {
  // A session asking for work first resumes a queued job nobody drives, before it creates one.
  // --force never applies here: it would take a live owner's job or a blocked one.
  // Validated before resumeQueued claims anything: a bad --limit after a claim would only reach the
  // tracker-error catch below.
  const limit = num(flags.limit, '--limit', { integer: true }) ?? 20;
  const sessionFlag = str(flags.session, '--session');
  const session = flags.claim && sessionFlag ? sessionFlag : null;
  // Over the cap nothing starts: creating a job would claim a tracker item for work that can't run.
  const status = checkRepoBudget(root, config);
  if (status.held) return { held: true, repoBudget: repoBudgetBlock(status) };
  const warn = status.reason ? { repoBudget: repoBudgetBlock(status) } : {};
  const warned = (id: string) => {
    if (status.reason) logEvent(root, id, 'repo-budget-warn', { reason: status.reason });
  };
  const claimed = session ? resumeQueued(root, session) : null;
  // A queued job's issue may have been edited since intake; its title can change with it.
  const refresh = claimed ? await refreshRequest(root, config, claimed.id, 'claim') : null;
  const resumed = claimed && refresh?.refreshed ? loadJob(root, claimed.id) : claimed;
  if (resumed) {
    warned(resumed.id);
    let blocked: Blocked[] = [];
    let skipped: Skipped[] = [];
    // The job is already claimed, so a tracker hiccup only costs the `blocked` report; it is
    // recorded on the job, as mirrorToTracker records its own.
    try {
      ({ blocked, skipped } = readyItems(root, config, await loadTracker(root, config), flags, limit));
    } catch (e) {
      logEvent(root, resumed.id, 'tracker-error', { error: (e as Error).message.slice(0, 300) });
    }
    return {
      id: resumed.id,
      ref: primaryIssue(resumed)?.ref ?? null,
      title: resumed.title,
      branch: resumed.branch,
      stage: resumed.stage,
      state: resumed.state,
      resumed: true,
      ...(refresh?.refreshed ? { requestRefreshed: true } : {}),
      ...(blocked.length ? { blocked } : {}),
      ...warn,
      ...(skipped.length ? { skippedRepos: skipped } : {}),
    };
  }
  const tracker = await loadTracker(root, config);
  const { ready, blocked, skipped } = readyItems(root, config, tracker, flags, limit);
  const extra = { ...(blocked.length ? { blocked } : {}) };
  const skips = skipped.length ? { skippedRepos: skipped } : {};
  const item = ready[0];
  if (!item) return { item: null, ...extra, ...warn, ...skips };
  if (!flags.claim) return { item, more: ready.length - 1, ...extra, ...warn, ...skips };
  const started = await startFromRef(root, config, tracker, item.ref, flags);
  if (!('existing' in started)) warned(started.id);
  return { ...started, ...(session ? { resumed: false } : {}), ...extra, ...warn, ...skips };
}

// What checkIssueRef refuses outright; a ref carrying one never takes the member path either.
const CONTROL = /[\x00-\x1f\x7f\u2028\u2029]/;

type Started = { id: string; existing: true; stage: Job['stage']; state: Job['state'] } | { id: string; ref: string; title: string; branch: Job['branch']; repo?: string };

/** How startFromRef creates a job: its split mode, and the mandate it works under (forge office start). */
export type StartOpts = { splitMode?: 'never'; mandate?: string | null };

/** Starts (or finds) the job for a tracker item and claims the item for it. */
export async function startFromRef(root: string, config: Config, tracker: Tracker, ref: string, flags: Record<string, any>, opts: StartOpts = {}): Promise<Started> {
  const session = str(flags.session, '--session');
  const ctx = { root, config };
  const kind = config.tracker.kind;
  const slug = localRepoSlug(root, config);
  // A member repo's issue, whatever the root's tracker: only a slug a human configured matches.
  const member = typeof ref === 'string' && !CONTROL.test(ref) ? memberForRef(root, config, ref.trim()) : null;
  if (member) return startFromMemberRef(root, config, member, slug, flags, opts);
  const checked = checkIssueRef(ref, { tracker: kind, slug });
  if ('error' in checked) throw new ForgeError(checked.error);
  // Only this repo's and its members' issues: a foreign one would be read, claimed and closed in a repo Forge doesn't own.
  const native = nativeRef({ tracker: kind, ref: checked.ref }, kind, slug);
  if (native === null) {
    const members = memberTrackers(root, config).map((m) => m.slug);
    throw new ForgeError(`from-ref takes an issue in ${slug ?? 'this repo'}${members.length ? ` or a member repo's tracker (${members.join(', ')})` : ''}`);
  }
  const item = tracker.get(ctx, native);
  if (!item) throw new ForgeError(`no ${tracker.name} item "${native}"`);
  const itemRef = String(item.ref);
  // An existing job keeps its own split mode: from-ref only names the mode of the job it creates.
  const existing = listJobs(root).find((j) => isActive(j) && nativeRefs(j, kind, slug).includes(itemRef));
  if (existing) return { id: existing.id, existing: true, stage: existing.stage, state: existing.state };
  const stored = kind === 'github' ? (parseIssueRef(itemRef, { tracker: kind, slug }) ?? itemRef) : itemRef;
  const issues = [{ tracker: kind, ref: stored, url: typeof item.url === 'string' ? item.url : null }];
  const job = createJob(root, config, { title: item.title, issues, body: item.body ?? '', splitMode: opts.splitMode, origin: 'issue', mandate: opts.mandate ?? null });
  const claim = tracker.claim(ctx, item.ref, job);
  if (!claim.ok) {
    await moveJob(root, config, job.id, { state: 'cancelled', reason: `tracker claim failed: ${claim.reason}` }, { mirror: false });
    throw new ForgeError(`could not claim ${ref}: ${claim.reason}`, 3);
  }
  if (session) claimJob(root, job.id, session, false);
  return { id: job.id, ref: item.ref, title: item.title, branch: job.branch };
}

/**
 * startFromRef for a member repo's issue. The member comes from human-owned config, so intake may
 * add it, but only to the job it creates here: an issue an active job already carries returns that
 * job untouched. Doctor's check on the member's clone runs before anything is created or claimed.
 */
async function startFromMemberRef(
  root: string,
  config: Config,
  member: MemberTracker & { n: string },
  slug: string | null,
  flags: Record<string, any>,
  opts: StartOpts,
): Promise<Started> {
  const session = str(flags.session, '--session');
  const ref = qualify(member.slug, member.n);
  const existing = listJobs(root).find((j) => isActive(j) && j.issues.some((x) => sameIssue(x, { tracker: 'github', ref }, slug)));
  if (existing) return { id: existing.id, existing: true, stage: existing.stage, state: existing.state };
  memberClone(root, config, member.name);
  const tracker = memberTracker();
  const ctx = { root, config: memberTrackerConfig(config, member.slug) };
  // Only the digits reach gh as the issue argument; -R is the configured slug.
  const item = tracker.get(ctx, member.n);
  if (!item) throw new ForgeError(`no github item "${ref}"`);
  const job = createJob(root, config, { title: item.title, issues: [{ tracker: 'github', ref, url: isSafeUrl(item.url) ? item.url : null }], body: item.body ?? '', splitMode: opts.splitMode, origin: 'issue', mandate: opts.mandate ?? null });
  recordJobRepo(root, config, job.id, member.name, false);
  const claim = tracker.claim(ctx, member.n, loadJob(root, job.id));
  if (!claim.ok) {
    await moveJob(root, config, job.id, { state: 'cancelled', reason: `tracker claim failed: ${claim.reason}` }, { mirror: false });
    throw new ForgeError(`could not claim ${ref}: ${claim.reason}`, 3);
  }
  if (session) claimJob(root, job.id, session, false);
  return { id: job.id, ref, title: item.title, branch: job.branch, repo: member.name };
}

/**
 * Once, when sync first sees the merge: names on each issue, in its own repo, the person who
 * approved the job's escalation. A member issue cites the PR as `<root slug>#N`, since a bare `#N`
 * links to the member's own PR N. The event it logs stops a second post; it is logged only when
 * every post succeeded, so a retry re-posts rather than skipping an issue. A failure is logged and
 * never fails the sync.
 */
export async function commentApproval(root: string, config: Config, job: Job): Promise<void> {
  if (job.kind === 'eval') return;
  const slug = localRepoSlug(root, config);
  const refs = nativeRefs(job, config.tracker.kind, slug);
  // A member issue needs the root slug to cite the root's PR; without one it gets no comment.
  const members = slug ? memberIssues(root, config, job, slug) : [];
  if (!refs.length && !members.length) return;
  const events = readEvents(root, job.id);
  if (events.some((e) => e.type === 'tracker-approval-comment')) return;
  const approval = escalationApproval(events);
  if (!approval) return;
  const merged = events.findLast((e) => e.type === 'pr-merged');
  const method = typeof merged?.method === 'string' ? merged.method : config.merge.method;
  const number = job.pr?.number;
  const by = approvedBy(approval);
  const posted: string[] = [];
  let ok = true;
  const failed = (e: unknown) => {
    ok = false;
    logEvent(root, job.id, 'tracker-error', { error: (e as Error).message.slice(0, 300) });
  };
  if (refs.length) {
    try {
      const tracker = await loadTracker(root, config);
      for (const ref of refs) {
        tracker.comment({ root, config }, ref, `Merged in #${number} (${method}). Escalation approved by ${by}.`);
        posted.push(ref);
      }
    } catch (e) {
      failed(e);
    }
  }
  for (const { member } of members) {
    try {
      memberTracker().comment({ root, config: memberTrackerConfig(config, member.slug) }, member.n, `Merged in ${slug}#${number} (${method}). Escalation approved by ${by}.`);
      posted.push(qualify(member.slug, member.n));
    } catch (e) {
      failed(e);
    }
  }
  if (ok && posted.length) logEvent(root, job.id, 'tracker-approval-comment', { refs: posted, pr: number ?? null });
}

/**
 * `forge sync`: PRs and trackers for every job, then stacked-branch retargets, dependency waits and
 * umbrella jobs. `integrating` lists the jobs this sync moved to integrate.
 */
export async function syncAll(
  root: string,
  config: Config,
): Promise<{
  synced: number;
  results: Record<string, unknown>[];
  requests: number;
  integrating: string[];
  outcomes?: { measured: number; finalized: string[] };
  scoring?: { queued: string[]; held: string[] };
  retro?: { queued: string };
  retention?: { archived: string[]; logs: string[] };
  reconcile: ReconcileResult | 'skipped (forge dash owns it)' | { error: string };
}> {
  const results: Record<string, unknown>[] = [];
  const integrating: string[] = [];
  for (const job of listJobs(root).filter((j) => j.kind !== 'eval')) {
    const watch = isActive(job) ? job.pr?.number || job.stage === 'pr' : job.pr?.state === 'OPEN';
    if (!watch || !config.pr.enabled) continue;
    try {
      const before: Partial<JobPr> = job.pr ?? {};
      const r = await syncPr(root, config, ghGitHub, job.id, { narrow: (j) => mandateRefusal(root, config, j, 'pr-feedback') });
      if (r.integrate) integrating.push(job.id);
      const after = loadJob(root, job.id);
      if (r.pr?.state === 'MERGED' && before.state !== 'MERGED') await commentApproval(root, config, after);
      let cleaned = false;
      if (after.state === 'done' && config.worktrees.cleanup === 'on-merge' && after.worktree) {
        try {
          await removeWorktree(root, job.id, { deleteBranch: true });
          cleaned = true;
        } catch {}
      }
      const mergeDeferred = deferredMergeDue(root, config, after, r.pr?.state);
      results.push({
        id: job.id,
        pr: r.pr?.number ?? null,
        state: r.pr?.state ?? null,
        merged: r.pr?.state === 'MERGED' && before.state !== 'MERGED',
        conflicts: r.pr?.conflicts ?? false,
        behindBy: r.pr?.behindBy ?? null,
        checks: r.pr?.checks?.state ?? null,
        mergeDeferred,
        newFeedback: (r.pr?.unresolvedThreads ?? 0) > (before.unresolvedThreads ?? 0) || (r.pr?.changesRequested ?? 0) > (before.changesRequested ?? 0),
        cleaned, ...(mergeDeferred ? await continueQueued(root, config, ghGitHub, job.id) : {}),
      });
    } catch (e) {
      results.push({ id: job.id, error: (e as Error).message.slice(0, 300) });
    }
  }
  // After the PR loop, so a PR ahead that this sync saw merge, close or go red frees the jobs queued behind it.
  try {
    results.push(...(await releaseOverlapWaits(root, config)));
  } catch (e) {
    results.push({ mergeQueue: 'error', error: (e as Error).message.slice(0, 300) });
  }
  // After the PR loop, so a merge this sync recorded is measured in the same run.
  let outcomes: { measured: number; finalized: string[] } | null = null;
  if (config.pr.enabled) {
    try {
      const o = measureOutcomes(root, config);
      if (o.measured.length) outcomes = { measured: o.measured.length, finalized: o.finalized };
    } catch (e) {
      results.push({ outcomes: 'error', error: (e as Error).message.slice(0, 300) });
    }
  }
  // After the outcome pass, so a job's outcome merge time is there for a PR with none of its own.
  let scoring: { queued: string[]; held: string[] } | null = null;
  if (config.pr.enabled) {
    try {
      const s = queueScores(root, config, { mandateScoring: (j) => jobMandateScoring(root, j) });
      if (s.queued.length || s.held.length) scoring = s;
    } catch (e) {
      results.push({ scoring: 'error', error: (e as Error).message.slice(0, 300) });
    }
  }
  // Both passes are local git and job state, so they run even with PRs disabled.
  for (const p of retargetPlan(root, config)) {
    try {
      retargetPr(root, config, ghGitHub, p.id, p.to, p.dependency);
      results.push({ id: p.id, retargeted: { from: p.from, to: p.to, dependency: p.dependency } });
    } catch (e) {
      results.push({ id: p.id, error: (e as Error).message.slice(0, 300) });
    }
  }
  for (const job of listJobs(root).filter((j) => isActive(j) && j.kind !== 'eval' && j.state === 'waiting' && String(j.reason ?? '').startsWith(DEP_REASON))) {
    try {
      if (!refreshDependencyWait(root, job.id).released) continue;
      results.push({ id: job.id, unblocked: true });
      await mirrorJob(root, config, loadJob(root, job.id));
    } catch (e) {
      results.push({ id: job.id, error: (e as Error).message.slice(0, 300) });
    }
  }
  for (const job of listJobs(root).filter((j) => isActive(j) && j.children?.length)) {
    const kids = job.children.map((c) => {
      try {
        return loadJob(root, c);
      } catch {
        return null;
      }
    }).filter(Boolean);
    // filter(Boolean) above dropped the children that failed to load.
    if (kids.length && kids.every((k) => ['done', 'cancelled'].includes(k!.state))) {
      await moveJob(root, config, job.id, { stage: 'done', state: 'done', reason: 'all child jobs finished' });
      results.push({ id: job.id, umbrellaDone: true });
    }
  }
  // A new UTC month (or a raised cap) frees repo budget holds here as well as at the next start.
  const repoHeld = listJobs(root).filter((j) => isActive(j) && isRepoHold(j)).map((j) => j.id);
  if (repoHeld.length) {
    const still = new Set(checkRepoBudget(root, config).heldJobs);
    for (const id of repoHeld) if (!still.has(id)) results.push({ id, repoBudgetReleased: true });
  }
  // Before retention, so a retro job retention would archive still holds the cadence back this pass.
  let retro: { queued: string } | null = null;
  try {
    const queued = queueRetro(root, config);
    if (queued) retro = { queued };
  } catch (e) {
    results.push({ retro: 'error', error: (e as Error).message.slice(0, 300) });
  }
  // The human's retention policy runs in any session, daemon ones included: they set it, not a request.
  const retention = applyRetention(root, config, 'policy');
  const reconciled = await syncReconcile(root, config);
  // Counted last, so it includes the resumes sync and the reconciler queued.
  return {
    synced: results.length,
    results,
    requests: listRequests(root, { status: 'pending' }).length,
    integrating,
    ...(outcomes ? { outcomes } : {}),
    ...(scoring ? { scoring } : {}),
    ...(retro ? { retro } : {}),
    ...(retention ? { retention } : {}),
    reconcile: reconciled,
  };
}

/**
 * The reconciler's pass without `forge dash` (lib/office/reconcile.ts): a running dash reconciles on its own
 * timer with its sessions' facts, so sync leaves it to the dash whenever a live process holds its lock.
 * Read, never taken: a dash starting that instant must not find it held. A failed pass is reported,
 * not thrown, since every other sync step has already run.
 */
async function syncReconcile(root: string, config: Config): Promise<ReconcileResult | 'skipped (forge dash owns it)' | { error: string }> {
  if (dashRunning(root)) return 'skipped (forge dash owns it)';
  try {
    return await reconcile(root, config);
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
}
