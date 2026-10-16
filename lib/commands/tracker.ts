// Tracker commands, starting jobs from tracker refs, and `forge sync` (PRs + trackers for every job).
import { daemonClaimOpts, ownerStatusWithProof } from '../daemon-owner.ts';
import { DEP_REASON, claimRespectingDeps, refreshDependencyWait, retargetPlan, unmetDependencies } from '../deps.ts';
import { createJob, isActive, listJobs, loadJob, logEvent, readEvents, setJob, claimJob } from '../jobs.ts';
import * as pr from '../pr.ts';
import { listRequests } from '../requests.ts';
import { searchTerms } from '../issue-link.ts';
import { clampLimit, publicHits, searchTracker } from '../tracker-link.ts';
import { loadTracker } from '../trackers/index.ts';
import { DEFAULT_LIMIT, MAX_LIMIT, applyTriage, prepareTriage } from '../triage.ts';
import { ForgeError } from '../util.ts';
import * as wt from '../worktree.ts';
import { bodyFrom, list, num, req, str, usageError } from './args.ts';
import type { Config, HelpGroup, Job, JobPr, Tracker, TrackerItem } from '../types.ts';

const TRACKER_EXITS: [1 | 5, string][] = [
  [1, 'the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found)'],
  [5, 'gh failed (GitHub tracker)'],
];
const BODY: [string, string][] = [
  ['--body B', 'the text'],
  ['--body-file F', 'read the text from F (- for stdin)'],
];

const TRACKER: HelpGroup = {
  name: 'tracker',
  summary: 'the configured issue tracker (tracker.kind): items, claims, comments',
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
      readme: true,
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
      readme: true,
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
        summary: 'resume a queued unowned job (with --claim --session), else the next ready tracker item whose job is not blocked, skipping needs-info items (with --claim, start its job)',
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
    commands: [{ command: 'sync', args: '', summary: "reconcile PRs and trackers for every job, retarget stacked PRs, release dependency waits and finish umbrella jobs; a job's failure is reported in its result" }],
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
      tracker.comment(ctx, req(rest[0], 'ref'), bodyFrom(flags));
      return { ok: true };
    case 'create':
      return tracker.create(ctx, { title: req(flags.title, '--title'), body: bodyFrom(flags), labels: list(flags.label), parentRef: flags.parent ?? null });
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
 * no resume hand-off pending or in progress, and an owner that is absent, stale or provably dead.
 */
function resumeCandidates(root: string): Job[] {
  const handedOff = new Set(listRequests(root).filter((r) => r.type === 'resume' && (r.status === 'pending' || r.status === 'in-progress') && r.job).map((r) => r.job));
  return listJobs(root)
    .filter((j) => isActive(j) && j.state === 'queued' && j.kind !== 'eval' && !j.children?.length && !handedOff.has(j.id) && !unmetDependencies(root, j).length)
    .filter((j) => ownerStatusWithProof(root, j, { env: process.env }).status !== 'live')
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
}

/** Claims the first resumable job for `session`, or null. A claim lost to a race moves on. */
function resumeQueued(root: string, session: string): Job | null {
  for (const candidate of resumeCandidates(root)) {
    try {
      return claimRespectingDeps(root, candidate.id, session, false, daemonClaimOpts(root, candidate.id)).job;
    } catch (e) {
      if (e instanceof ForgeError && (e.exitCode === 3 || e.exitCode === 4)) continue;
      throw e;
    }
  }
  return null;
}

/** Ready tracker items, minus those whose active job waits on dependencies (listed as `blocked`). */
function readyItems(root: string, config: Config, tracker: Tracker, flags: Record<string, any>, limit: number): { ready: TrackerItem[]; blocked: { ref: string; id: string; waitingOn: string[] }[] } {
  // A custom adapter may return needs-info items in a ready list; triage asked for more first.
  const items = tracker.list({ root, config }, { ready: true, limit }).filter((i) => !i.needsInfo);
  const blocked: { ref: string; id: string; waitingOn: string[] }[] = [];
  // --force skips nothing. Otherwise an item is blocked when the active job it would resume
  // (the same match startFromRef uses) has unmet dependencies.
  const active = flags.force ? [] : listJobs(root).filter((j) => isActive(j) && j.source);
  const ready = items.filter((i) => {
    // active holds only jobs with a source, and unmet is empty unless a job was found.
    const job = active.find((j) => String(j.source!.ref) === String(i.ref));
    const unmet = job ? unmetDependencies(root, job) : [];
    if (unmet.length) blocked.push({ ref: i.ref, id: job!.id, waitingOn: unmet.map((u) => u.id) });
    return !unmet.length;
  });
  return { ready, blocked };
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
  const resumed = session ? resumeQueued(root, session) : null;
  if (resumed) {
    let blocked: { ref: string; id: string; waitingOn: string[] }[] = [];
    // The job is already claimed, so a tracker hiccup only costs the `blocked` report; it is
    // recorded on the job, as mirrorToTracker records its own.
    try {
      blocked = readyItems(root, config, await loadTracker(root, config), flags, limit).blocked;
    } catch (e) {
      logEvent(root, resumed.id, 'tracker-error', { error: (e as Error).message.slice(0, 300) });
    }
    return { id: resumed.id, ref: resumed.source?.ref ?? null, title: resumed.title, branch: resumed.branch, stage: resumed.stage, state: resumed.state, resumed: true, ...(blocked.length ? { blocked } : {}) };
  }
  const tracker = await loadTracker(root, config);
  const { ready, blocked } = readyItems(root, config, tracker, flags, limit);
  const extra = blocked.length ? { blocked } : {};
  const item = ready[0];
  if (!item) return { item: null, ...extra };
  if (!flags.claim) return { item, more: ready.length - 1, ...extra };
  return { ...(await startFromRef(root, config, tracker, item.ref, flags)), ...(session ? { resumed: false } : {}), ...extra };
}

/** Starts (or finds) the job for a tracker item and claims the item for it. */
export async function startFromRef(
  root: string,
  config: Config,
  tracker: Tracker,
  ref: string,
  flags: Record<string, any>,
  opts: { splitMode?: 'never' } = {},
): Promise<{ id: string; existing: true; stage: Job['stage']; state: Job['state'] } | { id: string; ref: string; title: string; branch: Job['branch'] }> {
  const session = str(flags.session, '--session');
  const ctx = { root, config };
  const item = tracker.get(ctx, ref);
  if (!item) throw new ForgeError(`no ${tracker.name} item "${ref}"`);
  // An existing job keeps its own split mode: from-ref only names the mode of the job it creates.
  const existing = listJobs(root).find((j) => isActive(j) && j.source && String(j.source.ref) === String(ref));
  if (existing) return { id: existing.id, existing: true, stage: existing.stage, state: existing.state };
  const job = createJob(root, config, { title: item.title, ref: item.ref, url: item.url ?? undefined, tracker: tracker.name, body: item.body ?? '', splitMode: opts.splitMode });
  const claim = tracker.claim(ctx, item.ref, job);
  if (!claim.ok) {
    setJob(root, job.id, { state: 'cancelled', reason: `tracker claim failed: ${claim.reason}` });
    throw new ForgeError(`could not claim ${ref}: ${claim.reason}`, 3);
  }
  if (session) claimJob(root, job.id, session, false, daemonClaimOpts(root, job.id));
  return { id: job.id, ref: item.ref, title: item.title, branch: job.branch };
}

/** Best-effort: tracker hiccups must never block the pipeline. */
export async function mirrorToTracker(root: string, config: Config, job: Job): Promise<void> {
  if (!job.source?.ref || job.kind === 'eval' || job.source.tracker !== config.tracker.kind) return;
  try {
    const tracker = await loadTracker(root, config);
    tracker.update({ root, config }, String(job.source.ref), job);
  } catch (e) {
    logEvent(root, job.id, 'tracker-error', { error: (e as Error).message.slice(0, 300) });
  }
}

const MERGE_EVENTS = new Set(['pr-merged', 'pr-auto-merge', 'pr-merge-deferred', 'pr-merge-refused', 'pr-merge-failed']);

/** A deferred merge has no GitHub-side queue, so sync surfaces it for the orchestrator to retry. */
function lastMergeEvent(root: string, id: string): string | null {
  return readEvents(root, id).filter((e) => MERGE_EVENTS.has(e.type)).pop()?.type ?? null;
}

/**
 * `forge sync`: PRs and trackers for every job, then stacked-branch retargets, dependency waits and
 * umbrella jobs. `integrating` lists the jobs this sync moved to integrate.
 */
export async function syncAll(root: string, config: Config): Promise<{ synced: number; results: Record<string, unknown>[]; requests: number; integrating: string[] }> {
  const results: Record<string, unknown>[] = [];
  const integrating: string[] = [];
  for (const job of listJobs(root).filter((j) => j.kind !== 'eval')) {
    const watch = isActive(job) ? job.pr?.number || job.stage === 'pr' : job.pr?.state === 'OPEN';
    if (!watch || !config.pr.enabled) continue;
    try {
      const before: Partial<JobPr> = job.pr ?? {};
      const r = pr.syncPr(root, config, job.id);
      if (r.integrate) integrating.push(job.id);
      const after = loadJob(root, job.id);
      await mirrorToTracker(root, config, after);
      let cleaned = false;
      if (after.state === 'done' && config.worktrees.cleanup === 'on-merge' && after.worktree) {
        try {
          wt.removeWorktree(root, job.id, { deleteBranch: true });
          cleaned = true;
        } catch {}
      }
      results.push({
        id: job.id,
        pr: r.pr?.number ?? null,
        state: r.pr?.state ?? null,
        merged: r.pr?.state === 'MERGED' && before.state !== 'MERGED',
        conflicts: r.pr?.conflicts ?? false,
        behindBy: r.pr?.behindBy ?? null,
        checks: r.pr?.checks?.state ?? null,
        mergeDeferred: r.pr?.state === 'OPEN' && lastMergeEvent(root, job.id) === 'pr-merge-deferred',
        newFeedback: (r.pr?.unresolvedThreads ?? 0) > (before.unresolvedThreads ?? 0) || (r.pr?.changesRequested ?? 0) > (before.changesRequested ?? 0),
        cleaned,
      });
    } catch (e) {
      results.push({ id: job.id, error: (e as Error).message.slice(0, 300) });
    }
  }
  // Both passes are local git and job state, so they run even with PRs disabled.
  for (const p of retargetPlan(root, config)) {
    try {
      pr.retargetPr(root, config, p.id, p.to, p.dependency);
      results.push({ id: p.id, retargeted: { from: p.from, to: p.to, dependency: p.dependency } });
    } catch (e) {
      results.push({ id: p.id, error: (e as Error).message.slice(0, 300) });
    }
  }
  for (const job of listJobs(root).filter((j) => isActive(j) && j.kind !== 'eval' && j.state === 'waiting' && String(j.reason ?? '').startsWith(DEP_REASON))) {
    try {
      if (!refreshDependencyWait(root, job.id).released) continue;
      results.push({ id: job.id, unblocked: true });
      await mirrorToTracker(root, config, loadJob(root, job.id));
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
      setJob(root, job.id, { stage: 'done', state: 'done', reason: 'all child jobs finished' });
      results.push({ id: job.id, umbrellaDone: true });
    }
  }
  // Counted last, so it includes the resumes sync queued for the jobs it routed.
  return { synced: results.length, results, requests: listRequests(root, { status: 'pending' }).length, integrating };
}
