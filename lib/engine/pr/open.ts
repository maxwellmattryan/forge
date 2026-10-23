// Opening a job's PRs: the checks before anything leaves the machine, interim deferrals and drafts,
// the pushes and the PRs, and retargeting a stacked PR.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, loadJob, logEvent, readEvents, setJob } from '#core/job/store.ts';
import { prLinkNote } from '#core/job/issue-link.ts';
import type { Config, Job, JobRepoPr } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { PR_STATES, assertJobPr, createPr, editPrBase, repoSlug, requireGh, safePrNumber, viewPr } from '#integrations/github/pull-requests.ts';
import { queueNotify } from '#office/notify.ts';
import { memberEntry, memberRepos } from '../project/job-repos.ts';
import { unpromotedDownstream } from '../project/downstream.ts';
import { jobRepoOrder } from '../project/repo-order.ts';
import type { PrStateKey, RepoKey } from '../project/repo-order.ts';
import { checkBranch, logEscalated, protectedApproved, refusalText } from '../guard/protected.ts';
import type { MemberBranch } from '../guard/protected.ts';
import { attributionForbidden, scrubBranch } from '../guard/attribution.ts';
import { logSecrets, refusalMessage, refuseSecrets, scanBranch, secretMode, secretsBlock, textUnit } from '../guard/secrets.ts';
import { verifiedHead } from '../verify/gate.ts';
import { FULL_SHA, heldConsumers, releaseGates, repoLabel, resolveInterim } from '../release/interim.ts';
import type { Deferral } from '../release/interim.ts';
import { interimStatus } from '../release/interim-apply.ts';
import { findPr } from './adopt.ts';
import { prText } from './body.ts';
import { pullPrHead, pushBranch, refreshBase } from './branch.ts';
import { checkMemberPr, linkSiblingsQuietly, memberSlug, openMemberPr, recordMemberPr } from './members.ts';
import type { MemberPrResult } from './members.ts';

export function openPr(
  root: string,
  config: Config,
  id: string,
  opts: { title?: string; draft?: boolean; force?: boolean } = {},
): { number: number | null; url: string | null; created: boolean; unlinked?: true; repos?: MemberPrResult[]; deferred?: Deferral[] } {
  const job = loadJob(root, id);
  // job.json is session-writable: a downstream consumer becomes a pushed repo only through a promotion event.
  const unpromoted = unpromotedDownstream(job, readEvents(root, id));
  if (unpromoted.length) throw new ForgeError(`repo ${unpromoted.join(', ')} joined job ${id} as a downstream consumer and was never promoted, so forge pr open won't push it; propose it (forge job repo propose ${id} <repo> --reason "…") for a human to approve`);
  requireGh();
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree`);
  // A PR branch moved on GitHub (an "Update branch", a person's push) would reject the push as
  // non-fast-forward. Merge it in rather than force over it, and send the job back through verify for
  // the merged HEAD: step PR2b re-verifies after a pr-head-pulled event.
  const pulled = pullPrHead(root, config, job);
  if (pulled?.pulled === 'conflicts')
    throw new ForgeError(`PR branch ${job.branch} moved on ${config.git.remote} (${pulled.head.slice(0, 12)}) and conflicts with ${id}'s HEAD; the merge was aborted, so resolve it in the worktree and run forge verify ${id}`, 'failed');
  if (pulled && pulled.pulled !== 'none')
    throw new ForgeError(`PR branch ${job.branch} moved on ${config.git.remote}: merged ${pulled.head.slice(0, 12)} into the worktree (${pulled.pulled}); verify the merged HEAD, then open again`, 'failed', `forge verify ${id}`);
  // Checked before the attribution scrub, which rewrites shas: the question is whether the
  // commits as the builder left them were verified.
  const evidence = verifiedHead(root, id);
  if (!evidence.verified) {
    const last = evidence.last ? `last verify: round ${evidence.last.round} attempt ${evidence.last.attempt}, ${evidence.last.ok ? 'PASS' : 'FAIL'} on ${String(evidence.last.sha).slice(0, 12)}` : `no verify run in round ${Number(job.round)}`;
    // With job repos the root HEAD can match while a member's does not: name what moved.
    const repoNote = evidence.heads && evidence.last?.ok && evidence.last.sha === evidence.head ? `, but a job repo HEAD is not the one it checked` : '';
    if (!opts.force) throw new ForgeError(`HEAD ${evidence.head.slice(0, 12)} of ${id} is not verified (${last}${repoNote}); run: forge verify ${id}, or pass --force`);
    logEvent(root, id, 'pr-unverified', { head: evidence.head, last: evidence.last });
  }
  // Before any gh call or push, and even for a PR that already exists: the scan is the last point
  // where nothing has left the machine yet.
  const text = prText(root, config, job, opts.title);
  refuseSecrets(root, config, [textUnit('(pr title)', text.title), textUnit('(pr body)', text.body)], { what: 'the PR title or body', id, gate: 'pr' });
  // The commits are scanned here too, verified or not: this is the real exit, a HEAD verified by a
  // Forge without the scanner was never scanned, and --force skips verify altogether.
  const mode = secretMode(config);
  refreshBase(job, config, mode);
  const scan = scanBranch(root, config, job, { staged: false, head: evidence.head });
  logSecrets(root, id, 'pr', scan, { blocked: mode === 'block' });
  if (mode === 'block' && scan.error) throw new ForgeError(`secret scan of ${id}'s commits could not finish (${scan.error}); forge pr open won't push an unscanned branch`, 'secret_found', `forge secrets scan ${id}`);
  if (secretsBlock(scan.findings, mode)) throw new ForgeError(refusalMessage(`the commits of ${id}`, scan.findings), 'secret_found', `forge secrets scan ${id}`);
  // With interim edges, a member whose PR already merged (a sequential dependency, say) is never
  // pushed or checked again. Other jobs keep checking every member, as before interim strategies.
  const skipMerged = resolveInterim(config, job).edges.length > 0;
  const open = memberRepos(job).filter((m) => !m.verifyOnly && !(skipMerged && m.pr?.state === 'MERGED'));
  // Every member is checked before anything is pushed, then opened before the root PR, so a member
  // failure leaves no root PR behind.
  const plans = open.map((m) => checkMemberPr(root, config, job, m.repo, text.title, mode, evidence.heads?.[m.repo]));
  // After checkMemberPr, which refreshes each member's base from its push remote and pushes nothing:
  // a member's remote-tracking base is writable from its worktree, and checked stale it would hide
  // the member's protected paths behind an empty diff, as the root's refresh above prevents for it.
  refuseProtected(root, config, job, evidence.head, plans.map((p) => ({ repo: p.repo, worktree: p.worktree, base: p.base, head: p.checked })));
  // From here on only the checked commit is used, never HEAD: a commit made in the worktree after
  // the checks (a stale session, a process the builder left behind) must not ride along.
  const checked = evidence.head;
  if (!FULL_SHA.test(checked)) throw new ForgeError(`HEAD of ${id} is not a commit id`);
  const slug = repoSlug(root, config);
  const ahead = git(job.worktree!, ['rev-list', '--count', `${config.git.remote}/${job.base}..${checked}`, '--'], { allowFail: true });
  if (ahead.ok && ahead.stdout.trim() === '0') throw new ForgeError(`branch ${job.branch} has no commits ahead of ${job.base}`);
  // Interim strategies, judged against the checked commits before anything is pushed.
  // A merged member is not re-checked, but a consumer may still pin it: its HEAD now stands in.
  const heads = new Map<RepoKey, string>([[null, checked], ...Object.entries(evidence.heads ?? {}), ...plans.map((p): [RepoKey, string] => [p.repo, p.checked])]);
  const interim = interimOpenPlan(root, config, job, heads);
  const isDeferred = (k: RepoKey) => interim.deferred.some((d) => d.repo === k);
  plans.sort((a, b) => interim.order.indexOf(a.repo) - interim.order.indexOf(b.repo));
  let rootPushed: string | null = null;
  const pushRoot = (): string => {
    if (rootPushed !== null) return rootPushed;
    let pushedSha = checked;
    let rewritten = false;
    if (attributionForbidden(config)) {
      const remoteBase = `${config.git.remote}/${job.base}`;
      // createJob always sets base and branch; so below.
      const base = git(job.worktree!, ['rev-parse', '--verify', '--quiet', remoteBase], { allowFail: true }).ok ? remoteBase : job.base!;
      // Rewrites messages only, from the checked commit: every tree stays the one that was checked.
      const scrub = scrubBranch(job.worktree!, base, checked, historyEnv());
      if (scrub.rewritten) {
        rewritten = true;
        pushedSha = scrub.sha;
        logEvent(root, id, 'attribution-scrubbed', { rewritten: scrub.rewritten, commits: scrub.commits });
      }
    }
    // The exact sha GitHub gets, so the merge-time head pin compares against what was checked.
    pushBranch(job, config, pushedSha, { force: rewritten });
    rootPushed = pushedSha;
    return pushedSha;
  };
  const rootMerged = job.pr?.state === 'MERGED';
  // A consumer pins the root's sha (git-ref), so the root's branch exists before any member's.
  if (interim.rootFirst && !rootMerged && !isDeferred(null)) pushRoot();
  const memberResults = plans.filter((p) => !isDeferred(p.repo)).map((p) => openMemberPr(root, config, job, p, text.title, interim.drafts.has(p.repo) ? true : opts.draft));
  const repos = memberRepos(job).length ? { repos: memberResults } : {};
  const deferred = interim.deferred.length ? { deferred: interim.deferred } : {};
  const logDeferred = () => {
    if (interim.deferred.length) logEvent(root, id, 'pr-deferred', { deferred: interim.deferred });
  };
  if (isDeferred(null) || rootMerged) {
    logDeferred();
    linkSiblingsQuietly(root, config, id);
    const pr = rootMerged ? { number: job.pr!.number, url: job.pr!.url } : { number: null, url: null };
    return { ...pr, created: false, ...prLinkNote(job, config), ...repos, ...deferred };
  }
  const pushedSha = pushRoot();
  const existing = findPr(root, config, id);
  if (existing && existing.state === 'OPEN') {
    setJob(root, id, { owned: { 'pr.pushedSha': pushedSha } });
    logEvent(root, id, 'pr-updated', { number: existing.number });
    logDeferred();
    linkSiblingsQuietly(root, config, id);
    return { number: existing.number, url: existing.url, created: false, ...prLinkNote(job, config), ...repos, ...deferred };
  }
  const bodyFile = path.join(jobDir(root, id), 'pr-body.md');
  fs.writeFileSync(bodyFile, text.body);
  // A consumer on a local edge has nothing CI can resolve, and one on a sequential edge waits for the
  // dependency's release: its PR is held as a draft.
  const isDraft = interim.drafts.has(null) || Boolean(opts.draft ?? config.pr.draft);
  const url = createPr(job.worktree!, { slug, base: job.base!, head: job.branch!, title: text.title, bodyFile, draft: isDraft, labels: config.pr.labels ?? [], reviewers: config.pr.reviewers ?? [] });
  const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
  setJob(root, id, { owned: { pr: { number, url, state: 'OPEN', isDraft, openedAt: now(), lastSyncedAt: now(), pushedSha } } });
  logEvent(root, id, 'pr-opened', { number, url });
  logDeferred();
  queueNotify(root, ['pr-opened'], { job: job.id, reason: 'pr-opened' });
  linkSiblingsQuietly(root, config, id);
  return { number, url, created: true, ...prLinkNote(job, config), ...repos, ...deferred };
}

/** What interim strategies make of one `pr open`: interimOpenPlan. */
interface InterimOpenPlan {
  /** The job's PR repos, dependencies first: members open in this order. */
  order: RepoKey[];
  deferred: Deferral[];
  /** Consumers on a local edge, and on a sequential edge whose release is unrecorded: their PR is created as a draft. */
  drafts: Set<RepoKey>;
  /** The root is the dependency of a git-ref or canary edge: its branch is pushed before any member's. */
  rootFirst: boolean;
}

/**
 * Refuses a `blocked` edge, and a git-ref or canary pin that is stale against the checked commits
 * (`interim_stale`), then works out which repos wait: a sequential consumer until its dependency's
 * PR merged (asked of GitHub now), a canary consumer until the version is published, and every repo
 * that depends on a waiting one through a sequential, git-ref or canary edge.
 */
function interimOpenPlan(root: string, config: Config, job: Job, heads: Map<RepoKey, string>): InterimOpenPlan {
  const { edges } = interimStatus(root, config, job, heads);
  const { order } = jobRepoOrder(config, job);
  const blocked = edges.find((e) => e.state === 'blocked');
  if (blocked) throw new ForgeError(`interim ${blocked.strategy}: ${repoLabel(blocked.consumer)} on ${repoLabel(blocked.dependency)} can't be pinned: ${blocked.detail}`);
  const stale = edges.find((e) => e.state === 'stale');
  if (stale)
    throw new ForgeError(
      `interim ${stale.strategy}: ${stale.detail.replace(/; run: .*$/, '')}; the checked commits don't ${stale.release ? 'name the released version' : 'carry the pin'}`,
      'interim_stale',
      `forge verify ${job.id}`,
    );
  const merged = new Map<RepoKey, boolean>();
  const isMerged = (k: RepoKey): boolean => {
    if (!merged.has(k)) merged.set(k, freshMerged(root, config, job, k));
    return merged.get(k)!;
  };
  const deferred: Deferral[] = [];
  for (const repo of order) {
    const mine = edges.filter((e) => e.consumer === repo);
    let d: Deferral | null = null;
    const waiting = mine.find((e) => e.strategy === 'sequential' && !isMerged(e.dependency));
    if (waiting) d = { repo, why: 'sequential', waitingOn: mine.filter((e) => e.strategy === 'sequential' && !isMerged(e.dependency)).map((e) => e.dependency) };
    const canary = !d && mine.find((e) => e.strategy === 'canary' && e.state === 'waiting');
    if (canary && canary.canary) d = { repo, why: 'canary', waitingOn: [canary.dependency], version: canary.canary.version, name: canary.canary.name };
    // A repo built on a waiting one through a pin or a merge order waits for the same thing.
    const via = !d && mine.find((e) => e.strategy !== 'local' && deferred.some((x) => x.repo === e.dependency));
    if (via) d = { ...deferred.find((x) => x.repo === via.dependency)!, repo };
    if (d) deferred.push(d);
  }
  const held = heldConsumers(releaseGates(edges, readEvents(root, job.id), job));
  const drafts = new Set(edges.filter((e) => e.strategy === 'local' || (e.strategy === 'sequential' && held.has(e.consumer))).map((e) => e.consumer));
  const rootFirst = edges.some((e) => e.dependency === null && (e.strategy === 'git-ref' || e.strategy === 'canary'));
  return { order, deferred, drafts, rootFirst };
}

/**
 * Whether a job repo's PR is MERGED according to GitHub now (a recorded state is writable). No PR
 * counts as not merged; so does one that is not the job's own, or any gh failure. When the record
 * says MERGED and GitHub disagrees, GitHub wins and the record is corrected (`pr-state-corrected`):
 * otherwise step would see a merged dependency, run pr open (PR7), and pr open would defer again,
 * forever. A record GitHub can't confirm either way stops pr open instead.
 */
function freshMerged(root: string, config: Config, job: Job, key: RepoKey): boolean {
  const pr = key === null ? job.pr : memberEntry(job, key)?.pr;
  const number = safePrNumber(pr?.number);
  if (number === null) return false;
  let live: PrStateKey | null = null;
  try {
    const slug = key === null ? repoSlug(root, config) : memberSlug(config, key);
    const view = viewPr(root, slug, number, 'state,headRefName,baseRefName');
    assertJobPr(view, job.branch, key === null ? job.base : (memberEntry(job, key)?.base ?? null), `PR #${number} in ${slug}`);
    live = PR_STATES.has(view?.state) ? (view.state as PrStateKey) : null;
  } catch {}
  if (pr?.state === 'MERGED' && live !== 'MERGED') {
    if (live === null) throw new ForgeError(`${repoLabel(key)}'s PR #${number} is recorded MERGED, but GitHub can't confirm its state; run: forge pr sync ${job.id}`, 'external');
    if (key === null) setJob(root, job.id, { owned: { 'pr.state': live } });
    else recordMemberPr(root, job.id, key, (prev) => ({ ...(prev ?? {}), state: live }) as JobRepoPr);
    logEvent(root, job.id, 'pr-state-corrected', { repo: key, number, recorded: 'MERGED', live });
  }
  return live === 'MERGED';
}

/**
 * The protected-paths re-check before anything leaves the machine, `--force` or not. The set is
 * recomputed from the branch (a hand-cleared job.json flag changes nothing), a refuse path stops the
 * open, and escalate paths stop it until a human approved their current content at a PP1 park.
 */
function refuseProtected(root: string, config: Config, job: Job, head: string, members: MemberBranch[]): void {
  const id = job.id;
  const c = checkBranch(root, config, job, head, 'pr', members);
  if (c.error) throw new ForgeError(`can't check ${id}'s protected paths (${c.error}); forge pr open won't push a branch it can't check`, 'protected_path');
  if (c.refused.length) throw new ForgeError(refusalText('forge pr open', c.refused), 'protected_path');
  if (c.escalated.length && !protectedApproved(c.flag, readEvents(root, id))) {
    logEscalated(root, id, 'pr', c.escalated, head, true);
    throw new ForgeError(`protected paths need a human approval: ${c.escalated.length} paths; /forge approve ${id}`, 'protected_path');
  }
}

/**
 * Moves a stacked job back onto a normal base once its dependency merged. The open PR is
 * retargeted first; `job.base` changes only when that worked, so a failed call retries on the
 * next sync.
 */
export function retargetPr(
  root: string,
  config: Config,
  id: string,
  base: string,
  dependency?: string,
): { from: string | null; to: string; pr: number | null } {
  const job = loadJob(root, id);
  const from = job.base;
  const number = config.pr.enabled && job.pr?.number && job.pr.state === 'OPEN' ? job.pr.number : null;
  if (number) {
    requireGh();
    editPrBase(root, repoSlug(root, config), number, base);
  }
  setJob(root, id, { owned: { base } });
  logEvent(root, id, 'retargeted', { from, to: base, dependency, pr: number });
  return { from, to: base, pr: number };
}
