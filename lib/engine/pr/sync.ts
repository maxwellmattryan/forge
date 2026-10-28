// Syncing a job with its PR on GitHub: the state it leaves the job in, CI reworks and re-runs,
// reopening deferred PRs, the human delta and pr-feedback.md.
import fs from 'node:fs';
import path from 'node:path';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { isForemanActor, jobDir, leaseStatus, loadJob, logEvent, logHumanEvent, readEvents, setJob } from '#core/job/store.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import type { Config, HumanDelta, Job, JobChange, JobEvent, JobPr } from '#core/types.ts';
import { now } from '#core/utils.ts';
import { git } from '#integrations/git/runner.ts';
import { RUN_ID, checksText, safePrNumber } from '#integrations/github/pull-requests.ts';
import type { GitHub, PrSnapshot } from '#integrations/github/types.ts';
import { decides, enqueuePrFeedbackGate, foremanEnabled, reservedFor } from '../pipeline/moves/foreman-gates.ts';
import { moveJob } from '../pipeline/moves/apply.ts';
import { memberRepos } from '../project/job-repos.ts';
import { isLinkedJob } from '../project/repo-order.ts';
import type { PrStateKey, RepoKey } from '../project/repo-order.ts';
import { deferralStatus, pendingDeferral, readDeferrals } from '../release/interim.ts';
import { deltaSummary, fetchCommit, isSha, measureHumanDelta, shouldMeasureDelta } from './delta.ts';
import { findPr } from './adopt.ts';
import { ciFeedback, ownRepo, rerunRuns } from './ci.ts';
import { feedbackSince, writeFeedback } from './feedback.ts';
import { linkSiblingsQuietly, syncMemberPrs } from './members.ts';
import type { MemberSync } from './members.ts';

/** What syncTransition decides: the job change, whether it routes to integrate, and the integrateFor to keep. */
export interface SyncTransition {
  change: Pick<JobChange, 'stage' | 'state' | 'waitingOn' | 'reason' | 'note'>;
  integrate: boolean;
  integrateFor: string | null;
}

/** A member PR as syncTransition weighs it: this call's state, null when it could not be read. */
export type MemberPrState = Pick<MemberSync, 'repo' | 'number' | 'state' | 'newlyClosed'>;

/**
 * The state a sync leaves a job in. `pr` is the merged record (job.pr plus what GitHub just said),
 * `job.pr` the previous one. A PR job routes to integrate only from a state sync itself parks in,
 * on a head Forge pushed and has not routed before, and with no live session driving it, so no
 * one else's commits or session are ever acted on. `ownerLive` runs last: it may spawn `ps`.
 * `members` (a linked job's non-verify-only member PRs, as this sync read them) holds a merged root
 * job open until every member PR merged too.
 */
export function syncTransition(
  job: Pick<Job, 'stage' | 'state' | 'waitingOn' | 'pr'> & { reason?: string | null },
  pr: JobPr,
  config: Pick<Config, 'pr'>,
  opts: { route: boolean; ownerLive: () => boolean; members?: MemberPrState[]; reopen?: boolean },
): SyncTransition {
  const members = opts.members ?? [];
  const t = rootTransition(job, pr, config, opts, members);
  const closed = members.filter((m) => m.newlyClosed).map((m) => `repo ${m.repo} PR #${m.number ?? '?'} was closed without merging`);
  if (!closed.length) return t;
  const note = [t.change.note, ...closed].filter(Boolean).join('; ');
  return { ...t, change: { ...t.change, note } };
}

/** Why a merged root job still waits: the first member PR that has not merged. */
function memberWait(m: MemberPrState): string {
  if (m.number === null) return `PR merged; waiting on repo ${m.repo} (no PR)`;
  if (m.state === null) return `PR merged; waiting on repo ${m.repo} (state unknown)`;
  return `PR merged; waiting on repo ${m.repo} PR #${m.number}${m.state === 'CLOSED' ? ' (closed without merging)' : ''}`;
}

const shelved = (job: Pick<Job, 'state' | 'waitingOn'>): boolean => job.state === 'waiting' && job.waitingOn === 'shelved';

function rootTransition(
  job: Pick<Job, 'stage' | 'state' | 'waitingOn' | 'pr'> & { reason?: string | null },
  pr: JobPr,
  config: Pick<Config, 'pr'>,
  opts: { route: boolean; ownerLive: () => boolean; reopen?: boolean },
  members: MemberPrState[],
): SyncTransition {
  const prev: Partial<JobPr> = job.pr ?? {};
  // gh output: only a real sha is compared or stored.
  const head = isSha(pr.headOid) ? pr.headOid : null;
  const kept = head !== null && prev.integrateFor === head ? head : null;
  const stay = (change: SyncTransition['change'] = {}): SyncTransition => ({ change, integrate: false, integrateFor: kept });
  // Before the merged-root wait below: a deferred PR whose dependencies merged opens now.
  if (opts.reopen && reopenable(job, opts)) return stay(REOPEN_CHANGE);
  if (pr.state === 'MERGED') {
    if (!members.length) return stay(job.state !== 'done' ? { stage: 'done', state: 'done', reason: 'PR merged' } : {});
    // A member whose sync failed counts as not merged: done is final, so it waits for an answer.
    const open = members.find((m) => m.state !== 'MERGED');
    if (!open) return stay(job.state !== 'done' ? { stage: 'done', state: 'done', reason: 'all PRs merged' } : {});
    if (['running', 'done', 'cancelled'].includes(job.state) || shelved(job)) return stay();
    const reason = memberWait(open);
    if (job.stage === 'pr' && job.state === 'waiting' && job.waitingOn === 'pr-review' && job.reason === reason) return stay();
    return stay({ stage: 'pr', state: 'waiting', waitingOn: 'pr-review', reason });
  }
  if (pr.state === 'CLOSED') return stay(!['cancelled', 'done'].includes(job.state) ? { state: 'cancelled', reason: 'PR closed without merging' } : {});
  // A person set it aside: only their merge or close on GitHub (above) moves it, never an update, a park or a reopen.
  if (shelved(job)) return stay();
  // A cancel or a failure keeps stage pr, and only a person reopens the job: parking it on pr-review
  // again would hand forge pr merge a job a human stopped.
  if (pr.state !== 'OPEN' || job.stage !== 'pr' || job.state === 'cancelled' || job.state === 'failed') return stay();
  const policy = config.pr.conflicts;
  const conflicting = pr.mergeable === 'CONFLICTING';
  const behindBy = typeof pr.behindBy === 'number' && Number.isSafeInteger(pr.behindBy) && pr.behindBy > 0 ? pr.behindBy : 0;
  const parked = job.state === 'waiting' && (job.waitingOn === 'pr-review' || job.waitingOn === 'conflicts');
  // Updating a branch that is only behind needs no conflict decision, so it routes under every policy.
  const trigger = conflicting ? policy === 'fix' : behindBy > 0;
  if (opts.route && parked && trigger && head !== null && head === prev.pushedSha && prev.integrateFor !== head && !opts.ownerLive()) {
    const n = Number.isSafeInteger(pr.number) ? pr.number : '?';
    const reason = conflicting ? `forge sync: PR #${n} conflicts with its base (pr.conflicts: fix)` : `forge sync: PR #${n} is ${behindBy} commit${behindBy === 1 ? '' : 's'} behind its base`;
    return { change: { stage: 'integrate', state: 'running', waitingOn: null, reason }, integrate: true, integrateFor: head };
  }
  if (job.state === 'running') return stay();
  if (conflicting && policy === 'defer')
    return stay({ state: 'waiting', waitingOn: 'pr-review', ...(prev.conflicts !== true ? { note: 'conflicts with base deferred by pr.conflicts' } : {}) });
  return stay({ state: 'waiting', waitingOn: conflicting ? 'conflicts' : 'pr-review' });
}

/** How every CI rework cap reason starts; prReviewTell keys on it. */
const CI_CAP_PREFIX = 'CI rework cap:';

/** Consecutive CI reworks: the foreman's `rework` events with a `ciHead` since a person's latest event. */
function ciReworkStreak(events: JobEvent[]): number {
  let n = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'human') continue;
    if (!isForemanActor(e)) break;
    if (e.action === 'rework' && typeof e.ciHead === 'string') n++;
  }
  return n;
}

/** How every CI re-run park reason starts; startCiRework's reserved check and prReviewTell key on it. */
const CI_RERUN_PREFIX = 'CI re-run:';

/** Why a re-run head waits for a person: its re-run finished red, or nothing could be re-run. */
type CiRerunCause = 'still-failing' | 'not-rerun';

/** The re-run park reason: Forge's fixed text around CHECK_NAME names, a PR number and a short sha, so step's CI_RERUN_REASON holds it. */
function ciRerunReason(cause: CiRerunCause, failing: { names: string[]; more: number }, n: number | string, head: string): string {
  const at = `on PR #${n} at ${head.slice(0, 12)}`;
  return cause === 'still-failing'
    ? `${CI_RERUN_PREFIX} ${checksText(failing)} still failing ${at} after a CI rework with no new commit and one re-run. Local verify passes. A human decides`
    : `${CI_RERUN_PREFIX} ${checksText(failing)} failing ${at} after a CI rework with no new commit, and Forge could not re-run them. Local verify passes. A human decides`;
}

const parkedOnReview = (j:Pick<Job, 'stage' | 'state' | 'waitingOn'>) => j.stage === 'pr' && j.state === 'waiting' && j.waitingOn === 'pr-review';
const latestFor = (events: JobEvent[], type: string, head: string): JobEvent | undefined => events.findLast((e) => e.type === type && e.head === head);
/** An event's ids, read defensively: events.jsonl is agent-appendable, and anything else counts as none, which leans toward parking. */
const runIds = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && RUN_ID.test(x)) : []);

/**
 * The CI re-run for `head`, a red head the foreman already reworked (its round ended with no new
 * commit; startCiRework checked the rest). Once per head, with no gate, rework or resume, so a check
 * that keeps failing can't make Forge loop:
 * - checks still pending: wait;
 * - a `ci-rerun-failed` for this head: park again with its cause (a person's action earns no second re-run);
 * - a `ci-rerun` for this head (sync's own or a person's): wait while a failing check is still one of the
 *   jobs it re-ran (GitHub has not replaced them yet), else park with `still-failing`;
 * - else re-run through rerunRuns (the PR's own repo, on this head and completed, at most 5) and log
 *   `ci-rerun`; when none is accepted, park with `not-rerun`.
 * `job` is the CLI's record after this sync; `pr` the snapshot this sync read.
 */
async function ciRerun(
  root: string,
  github: GitHub,
  slug: string,
  job: Job,
  head: string,
  pr: Pick<PrSnapshot, 'failingChecks' | 'failingRuns'>,
  events: JobEvent[],
): Promise<'rerun' | 'waiting' | 'held'> {
  if (job.pr?.checks?.pending !== 0) return 'waiting';
  const failed = latestFor(events, 'ci-rerun-failed', head);
  if (failed) return parkRerun(root, job, head, failed.cause === 'not-rerun' ? 'not-rerun' : 'still-failing', pr.failingChecks);
  const rerun = latestFor(events, 'ci-rerun', head);
  if (rerun) {
    const jobs = new Set(runIds(rerun.jobs));
    return pr.failingRuns.some((r) => jobs.has(r.job)) ? 'waiting' : parkRerun(root, job, head, 'still-failing', pr.failingChecks);
  }
  // A run GitHub can't show or re-run is skipped; none accepted parks below.
  const r = rerunRuns(root, github, slug, head, pr.failingRuns);
  if (r.runs.length) {
    logEvent(root, job.id, 'ci-rerun', { head, runs: r.runs, jobs: r.jobs, checks: pr.failingChecks.names });
    return 'rerun';
  }
  // A concurrent sync may have re-run this head during the gh calls above: its re-run stands.
  if (latestFor(readEvents(root, job.id), 'ci-rerun', head)) return 'rerun';
  return parkRerun(root, job, head, 'not-rerun', pr.failingChecks);
}

/** Writes the reason only (waitingOn stays pr-review, as at the CI rework cap) while the job is parked at `head`; `ci-rerun-failed` once per head. */
function parkRerun(root: string, job: Job, head: string, cause: CiRerunCause, failing: { names: string[]; more: number }): 'held' {
  const reason = ciRerunReason(cause, failing, safePrNumber(job.pr?.number) ?? '?', head);
  let here = false;
  setJob(root, job.id, {
    derive: (j) => {
      if (!parkedOnReview(j) || j.pr?.headOid !== head) return null;
      here = true;
      return j.reason === reason ? null : { reason };
    },
  });
  // Moved under us: the next sync that finds it parked at this head records it.
  if (here && !latestFor(readEvents(root, job.id), 'ci-rerun-failed', head)) logEvent(root, job.id, 'ci-rerun-failed', { head, cause, checks: failing.names });
  return 'held';
}

/**
 * Failing checks on a parked PR the foreman would decide are a rework, not a judgement: sync records
 * it as the foreman's and queues the job's session, so no office turn sits between a red check and
 * the fix. Once per PR head; a reserved match goes through the gate.
 * Any head counts, a GitHub "Update branch" included: `forge job round` pulls it into the worktree.
 * A head the foreman already reworked (the round ended with no new commit) goes to ciRerun instead:
 * one re-run of its failed checks, then a park for a person, and never a gate. That comes
 * before the cap: a re-run is not a rework. A head a person re-ran waits while GitHub still lists a
 * job they re-ran, so a sync racing their re-run starts nothing.
 * After `pr.maxCiReworks` in a row with no person's event between, a red head starts nothing: the
 * reason says so, a `ci-rework-capped` event is logged once per head, and the caller queues no gate.
 * A job in a mandate gets the rework only when `narrow` finds its mandate delegating `pr-feedback`; else
 * (or with no `narrow`, failing closed) the caller queues the gate, which a gate run hands off.
 * `job` is the CLI's record (moveJob's `after`), so a session clearing `mandate` in job.json changes nothing.
 * `pr` is this sync's snapshot. Only `false` leaves the caller to queue the pr-feedback gate.
 */
async function startCiRework(
  root: string,
  config: Config,
  job: Job,
  github: GitHub,
  slug: string,
  pr: Pick<PrSnapshot, 'failingChecks' | 'failingRuns'>,
  narrow?: (job: Job) => string | null,
): Promise<'started' | 'capped' | 'rerun' | 'waiting' | 'held' | false> {
  if (config.daemon?.enabled !== true || !foremanEnabled(config) || !decides(config).includes('pr-feedback')) return false;
  if (job.mandate != null && (!narrow || narrow(job) !== null)) return false;
  const head = job.pr?.headOid;
  if (job.pr?.checks?.state !== 'failing' || typeof head !== 'string' || !isSha(head)) return false;
  const parked = parkedOnReview;
  // The cap's and the re-run park's reasons name CI, which the default foreman.reserved lists; they are
  // Forge's fixed text, so they must not hold the rework a person's reset allows again, or send a
  // re-run head to the gate.
  const own = typeof job.reason === 'string' && (job.reason.startsWith(CI_CAP_PREFIX) || job.reason.startsWith(CI_RERUN_PREFIX));
  const judged = own ? { ...job, reason: null } : job;
  if (!parked(job) || reservedFor(root, config, judged, 'pr-feedback', [], { action: 'rework' }) !== null) return false;
  const events = readEvents(root, job.id);
  if (events.some((e) => e.type === 'human' && e.action === 'rework' && e.ciHead === head)) return ciRerun(root, github, slug, job, head, pr, events);
  // A person re-ran this head (forge pr rerun, the dashboard) and GitHub still lists a job it re-ran: their
  // re-run is in flight, so no rework and no gate yet.
  const rerun = latestFor(events, 'ci-rerun', head);
  if (rerun) {
    const jobs = new Set(runIds(rerun.jobs));
    if (pr.failingRuns.some((r) => jobs.has(r.job))) return 'waiting';
  }
  const failing = pr.failingChecks;
  const n = safePrNumber(job.pr?.number) ?? '?';
  const max = Number.isInteger(config.pr?.maxCiReworks) && config.pr.maxCiReworks >= 0 ? config.pr.maxCiReworks : 3;
  const count = ciReworkStreak(events);
  if (count >= max) {
    if (events.some((e) => e.type === 'ci-rework-capped' && e.head === head)) return 'capped';
    const reason = `${CI_CAP_PREFIX} ${count} CI reworks in a row, checks still failing on PR #${n}: ${checksText(failing)}. A human decides`;
    let capped = false;
    setJob(root, job.id, {
      derive: (j) => {
        if (!parked(j) || j.pr?.headOid !== head) return null;
        capped = true;
        return { reason };
      },
    });
    // Moved under us: still at the cap, so still no gate; the next sync records it if it parks again.
    if (!capped) return 'capped';
    logEvent(root, job.id, 'ci-rework-capped', { head, count, max, checks: failing.names });
    return 'capped';
  }
  let started = false;
  await moveJob(root, config, job.id, {
    derive: (j) => {
      if (!parked(j) || j.pr?.headOid !== head || leaseStatus(j).status === 'live') return null;
      started = true;
      // Not "CI": the default foreman.reserved lists it, and reservedFor reads this reason at the next head.
      return { stage: 'build', state: 'running', waitingOn: null, reason: `forge sync: checks failing on PR #${n}` };
    },
  });
  if (!started) return false;
  fs.writeFileSync(path.join(jobDir(root, job.id), 'feedback.md'), ciFeedback(n, head));
  logHumanEvent(root, job.id, 'human', { action: 'rework', note: `checks failing on PR #${n} at ${head.slice(0, 12)}`, ciHead: head }, FOREMAN_ACTOR);
  if (!listRequests(root, { status: 'pending' }).some((r) => r.type === 'resume' && r.job === job.id))
    enqueue(root, config, { type: 'resume', job: job.id, text: 'forge sync: checks are failing on the PR; fix them', from: 'sync' });
  return 'started';
}

const REOPEN_REASON = 'forge sync: dependencies merged: open the deferred PRs';
const REOPEN_CHANGE = { state: 'running', waitingOn: null, reason: REOPEN_REASON } as const;

/** A job sync may move to reopen its deferred PRs: parked on pr-review, routing on, and no live session driving it. */
function reopenable(job: Pick<Job, 'state' | 'waitingOn'>, opts: { route: boolean; ownerLive: () => boolean }): boolean {
  return opts.route && job.state === 'waiting' && job.waitingOn === 'pr-review' && !opts.ownerLive();
}

/**
 * Whether the latest open attempt deferred PRs that can all open now: each sequential deferral's
 * dependencies MERGED in this sync's answers (`states`), and each canary published.
 */
function deferredOpenable(root: string, id: string, states: (k: RepoKey) => PrStateKey | undefined): boolean {
  const events = readEvents(root, id);
  const pending = pendingDeferral(events);
  return pending !== null && deferralStatus(readDeferrals(pending.deferred), states, events).openable;
}

/** What `forge pr sync` returns: `integrate` only when this sync moved the job to integrate, `reopen` when it resumed a job to open its deferred PRs. */
export interface SyncResult {
  id: string;
  pr: JobPr | null;
  integrate?: true;
  reopen?: true;
}

/**
 * Reconciles a job with reality on GitHub: merged/closed state, mergeability, how far behind
 * base it is, CI status and outstanding human feedback. This is what lets a later session
 * pick a job back up with an accurate picture.
 * `route: false` (mergePr) syncs without ever moving the job to integrate.
 */
export async function syncPr(root: string, config: Config, github: GitHub, id: string, opts: SyncOptions = {}): Promise<SyncResult> {
  return (await syncPrDetailed(root, config, github, id, opts)).result;
}

/**
 * `narrow` is the job's mandate refusal for `pr-feedback` (lib/office/foreman/policy.ts mandateRefusal), passed in
 * because engine code can't import lib/office/; a job in a mandate gets no CI rework without it.
 */
export interface SyncOptions {
  route?: boolean;
  narrow?: (job: Job) => string | null;
}

/**
 * syncPr, plus each non-verify-only member PR as this call read it and the base branch GitHub says the
 * root PR targets (null when it read none): mergePr decides on these, never on job.json.
 */
export async function syncPrDetailed(
  root: string,
  config: Config,
  github: GitHub,
  id: string,
  opts: SyncOptions = {},
): Promise<{ result: SyncResult; members: Map<string, MemberSync>; baseRef: string | null }> {
  const route = opts.route !== false;
  github.require();
  // Member PRs first: a failure there never stops the root sync, and counts as not merged.
  const members = isLinkedJob(loadJob(root, id)) ? syncMemberPrs(root, config, github, id) : new Map<string, MemberSync>();
  let job = loadJob(root, id);
  const memberState = (k: RepoKey): PrStateKey | undefined => (k === null ? undefined : members.get(k)?.state);
  if (!job.pr?.number) {
    const found = findPr(root, config, github, id);
    if (!found) {
      // The root was deferred, so it has no PR: its dependencies' merges still reopen it.
      let reopen = false;
      if (route && deferredOpenable(root, id, memberState)) {
        await moveJob(root, config, id, {
          derive: (j) => {
            if (!reopenable(j, { route, ownerLive: () => leaseStatus(j).status === 'live' })) return null;
            reopen = true;
            return { ...REOPEN_CHANGE };
          },
        });
        if (reopen) enqueueReopen(root, config, id);
      }
      return { result: reopen ? { id, pr: null, reopen: true } : { id, pr: null }, members, baseRef: null };
    }
    job = loadJob(root, id);
  }
  // Every non-verify-only member the job has now, read or not: one missing from this sync is unknown.
  const memberStates: MemberPrState[] = memberRepos(job)
    .filter((m) => !m.verifyOnly)
    .map((m) => {
      const r = members.get(m.repo);
      return r ? { repo: r.repo, number: r.number, state: r.state, newlyClosed: r.newlyClosed } : { repo: m.repo, number: safePrNumber(m.pr?.number), state: null, newlyClosed: false };
    });
  const slug = github.repoSlug(root, config);
  // findPr recorded the PR it found. The snapshot holds checked values only; an unusable number, url
  // or state keeps the stored one.
  const stored = job.pr!;
  const pr = github.view(root, slug, stored.number);
  const number = pr.number ?? stored.number;
  git(root, ['fetch', config.git.remote, '--prune'], { write: true, allowFail: true });
  // Refs reach git argv: the parser nulled any that fails SAFE_REF, and then nothing is counted.
  const behind =
    pr.headRefName !== null && pr.baseRefName !== null
      ? git(root, ['rev-list', '--count', `${config.git.remote}/${pr.headRefName}..${config.git.remote}/${pr.baseRefName}`], { allowFail: true })
      : null;
  const feedback = github.feedback(root, slug, number);
  const fresh = {
    number,
    url: pr.url ?? stored.url,
    state: pr.state ?? stored.state,
    isDraft: pr.isDraft,
    // Absent, as before, when GitHub gave nothing usable: undefined drops the key from job.json.
    mergeable: pr.mergeable ?? undefined,
    mergeState: pr.mergeState ?? undefined,
    headOid: pr.headOid,
    reviewDecision: pr.reviewDecision,
    checks: pr.checks,
    behindBy: behind?.ok ? Number(behind.stdout.trim()) : null,
    conflicts: pr.mergeable === 'CONFLICTING',
    unresolvedThreads: feedback.threads.length,
    changesRequested: feedback.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length,
    // Why the PR waits, for the dashboard's PR row: what fails (and how much of it Forge could re-run), and new feedback.
    failingChecks: { names: pr.failingChecks.names, more: pr.failingChecks.more, actions: pr.failingRuns.filter((r) => ownRepo(r.slug, slug)).length },
    feedbackSinceRound: feedbackSince(feedback, roundBoundary(readEvents(root, id))),
    mergedAt: pr.mergedAt,
    lastSyncedAt: now(),
  };
  writeFeedback(root, id, fresh, feedback, config.tracker.github.comments);
  const measured = shouldMeasureDelta(pr.state ?? undefined, job.pr?.humanDelta);
  const humanDelta = measured ? measureOnMerge(root, config, job, pr.headOid) : job.pr?.humanDelta;
  let synced: JobPr | null = null;
  let integrate = false;
  let reopen = false;
  const reopenReady = route && deferredOpenable(root, id, (k) => (k === null ? pr.state : memberState(k)));
  // Decided inside the job lock, from the job as stored then: a session that claimed it during the
  // network calls above is the owner this judges, so sync never flips a job someone else drives.
  // The move's effects: a merged or closed PR's environment goes (never undoing the state change), a
  // park on a class the foreman decides queues its gate (from mergePr too), and the tracker mirrors.
  const { job: after } = await moveJob(root, config, id, {
    derive: (j) => {
      const merged: JobPr = { ...j.pr, ...fresh, ...(humanDelta ? { humanDelta } : {}) };
      const t = syncTransition(j, merged, config, { route, ownerLive: () => leaseStatus(j).status === 'live', members: memberStates, reopen: reopenReady });
      const { integrateFor: _previous, ...rest } = merged;
      synced = t.integrateFor ? { ...rest, integrateFor: t.integrateFor } : rest;
      integrate = t.integrate;
      reopen = t.change.reason === REOPEN_REASON;
      return { ...t.change, owned: { pr: synced } };
    },
  });
  const prev: Partial<JobPr> = job.pr ?? {};
  logEvent(root, id, 'pr-synced', {
    state: pr.state,
    checks: pr.checks.state,
    behindBy: fresh.behindBy,
    conflicts: fresh.conflicts,
    unresolvedThreads: fresh.unresolvedThreads,
    newFeedback: fresh.unresolvedThreads > (prev.unresolvedThreads ?? 0) || fresh.changesRequested > (prev.changesRequested ?? 0),
    // measured: measureOnMerge set humanDelta.
    humanDelta: measured ? deltaSummary(humanDelta!) : undefined,
    integrate: integrate || undefined,
  });
  // The pool spawns the job's session, which claims it and runs the step loop. A fixed text: no PR
  // title, branch or body reaches a daemon session through it.
  if (integrate && config.daemon?.enabled === true && !listRequests(root, { status: 'pending' }).some((r) => r.type === 'resume' && r.job === id))
    enqueue(root, config, { type: 'resume', job: id, text: 'forge sync moved this job to integrate', from: 'sync' });
  if (reopen) enqueueReopen(root, config, id);
  // After the root PR's state is recorded, so a merged or closed PR is never edited.
  if (isLinkedJob(job)) linkSiblingsQuietly(root, config, github, id);
  // Feedback on a PR waiting for review: a CI rework or the pr-feedback gate. Never from mergePr.
  if (route) {
    // At the CI rework cap, and on a head the foreman already reworked (a re-run, a wait or a park), no
    // gate is queued either, so the foreman can't rework that head again through the office.
    if ((await startCiRework(root, config, after, github, slug, pr, opts.narrow)) === false) enqueuePrFeedbackGate(root, config, after, feedback.trusted);
  }
  return { result: integrate ? { id, pr: synced, integrate: true } : reopen ? { id, pr: synced, reopen: true } : { id, pr: synced }, members, baseRef: pr.baseRefName };
}

/** When the job last acted on its PR: the latest round, PR open or PR update, or null when it has none. Feedback after it is new. */
function roundBoundary(events: JobEvent[]): string | null {
  const e = events.findLast((x) => (x.type === 'round' || x.type === 'pr-opened' || x.type === 'pr-updated') && typeof x.ts === 'string');
  return e ? e.ts : null;
}

/** The pool spawns the job's session to open the deferred PRs. A fixed text, as for integrate. */
function enqueueReopen(root: string, config: Config, id: string): void {
  if (config.daemon?.enabled === true && !listRequests(root, { status: 'pending' }).some((r) => r.type === 'resume' && r.job === id))
    enqueue(root, config, { type: 'resume', job: id, text: 'forge sync reopened this job to open its deferred PRs', from: 'sync' });
}

function measureOnMerge(root: string, config: Config, job: Job, head: string | null): HumanDelta {
  const base = job.pr?.pushedSha ?? null;
  if (base) fetchCommit(root, config.git.remote, head);
  const d = measureHumanDelta(root, base, head);
  const attempts = (job.pr?.humanDelta?.attempts ?? 0) + 1;
  return { ...d, base, head, measuredAt: now(), ...(d.reason === 'missing commits' ? { attempts } : {}) };
}
