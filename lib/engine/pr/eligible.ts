// Whether a job's PR may merge without a person: the recorded decision, not superseded and bound to
// its head, recomputed protected paths and the escalate floor. mergePr asks autoMergeGate before any
// merge without --now, whoever calls it; `forge job step` asks decisionCurrent before PR4, and forge
// sync's deferral hint asks decisionSuperseded. decision.md is never read here: only the `decision`
// event `forge job decision` recorded once per approver run counts. Step also asks reviewCurrent in
// decide and pr: a commit after the review panel sends the job back to review.
import { autoMerge } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { reviewedRepoNames } from '#core/job/lens.ts';
import { listRequests } from '#core/job/requests.ts';
import { isMap } from '#core/shape.ts';
import type { Config, ForgeRequest, Job, JobEvent, ProtectedHit } from '#core/types.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { branchFloor } from '../guard/floor.ts';
import { branchHits, clean, prefixHits, protectedApproved, refusalText } from '../guard/protected.ts';
import { integrationTouched, resolveBase } from '../pipeline/scope.ts';
import { after, stageOf } from '../pipeline/step/facts.ts';
import { memberClone, memberEntry, memberRepos, trustedMemberWorktree } from '../project/job-repos.ts';
import { roundRuns, runsSince } from '../verify/record.ts';
import { remoteBaseTip } from './branch.ts';

/** A full commit id (SHA-1 or SHA-256): every head is checked against it before it reaches git. */
export const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Base merges a head may carry on top of the decided one; past this it waits on a human. */
const MAX_CHAIN = 100;

/** The last `decision` event, normalised: what the approver decided and the heads it was bound to. */
export interface DecisionRecord {
  decision: string | null;
  autoMerge: boolean;
  head: string | null;
  heads: Record<string, string | null>;
}

/** Why autoMergeGate refused: MergeResult's reasons it owns. */
export type EligibilityReason = 'auto-off' | 'superseded' | 'decision' | 'floor';

/** `moved`: the live head is not the decided one but carries base merges on it, so its age is the base merge's, not the push's. */
export type GateResult = { ok: true; moved: boolean } | { ok: false; reason: EligibilityReason; error: string };

const sha = (v: unknown): string | null => (typeof v === 'string' && FULL_SHA.test(v) ? v : null);

/** The last `decision` event, or null. A head that is not a full commit id reads as null. */
export function lastDecision(events: JobEvent[]): DecisionRecord | null {
  const e = events.findLast((x) => x.type === 'decision');
  if (!e) return null;
  // fromEntries defines own properties, so a `__proto__` key can't reach the prototype; decidedHead reads with hasOwn.
  const heads: Record<string, string | null> = isMap(e.heads) ? Object.fromEntries(Object.entries(e.heads).map(([k, v]) => [k, sha(v)])) : {};
  return { decision: typeof e.decision === 'string' ? e.decision : null, autoMerge: e.autoMerge === true, head: sha(e.head), heads };
}

const SUPERSEDING_ACTIONS = new Set(['rework', 'revise-spec']);

/** Job states a human decides about: a decision from before one does not stand. */
const ENDED_STATES = new Set<string>(['cancelled', 'failed']);

/** Requests that ask for a rework, a revise-spec or a cancel: queued from the dashboard, they act only once a session handles them. */
const SUPERSEDING_REQUESTS = new Set<string>(['rework', 'revise-spec', 'cancel']);

/** A request still to be handled: waiting in the inbox, or claimed by a session that has not acked it. */
const OPEN_REQUEST = new Set<string>(['pending', 'in-progress']);

/**
 * Whether a PR record holds a review requesting changes: the count the caller's sync just wrote from
 * GitHub's reviews (a missing one reads as none), on a PR GitHub has not merged or closed, since a
 * person who merged or closed it decided past that review.
 */
const requestsChanges = (pr: { changesRequested?: unknown; state?: unknown } | null | undefined): boolean =>
  Number(pr?.changesRequested) > 0 && pr?.state !== 'MERGED' && pr?.state !== 'CLOSED';

/**
 * Why the approver's last decision no longer stands, or null: the job left stage pr, it is cancelled
 * or failed, a rework, revise-spec or cancel a person asked for still waits in the request inbox
 * (`requests`: the dashboard queues it, and a busy pool slot or a repo budget hold can keep it there
 * a long time before `forge job human` records it), the job went to cancelled or failed after the
 * last `decision` (even if a session set it back), a `round` event follows the last `decision` (a
 * round on an open PR with merge.auto off skips the approver, step rule DC10), or a human rework or
 * revise-spec follows it, a person's or the foreman's. GitHub feedback that asks for changes counts
 * too: a `gate` request for the job the Foreman has not decided yet (forge sync queues a pr-feedback
 * one and continues deferred merges in the same pass), or a review GitHub lists as
 * CHANGES_REQUESTED on any open PR of the job (`job.pr.changesRequested`, and for a linked job each
 * PR member's `pr.changesRequested`, which both callers read right after their own sync recorded
 * them at the live heads). Log positions decide, never timestamps, so reordering ts values
 * gains nothing. An approve or answer after the decision supersedes nothing. With no decision, only
 * the job's stage, state, inbox and PRs can answer. Reads no inbox itself: callers pass
 * `listRequests(root)`, and none means nothing is queued.
 */
export function decisionSuperseded(
  job: Pick<Job, 'id' | 'stage' | 'state'> & Partial<Pick<Job, 'pr' | 'repos'>>,
  events: JobEvent[],
  requests: readonly Pick<ForgeRequest, 'job' | 'type' | 'status'>[] = [],
): string | null {
  const word = (v: unknown): string => clean(String(v)).slice(0, 40);
  if (job.stage !== 'pr')
    return `the job is at stage ${word(job.stage)}, not pr: a rework or another stage change replaced the approver's decision; the job's own session merges once it is back at pr with a new decision, or a human merges it`;
  if (ENDED_STATES.has(job.state)) return `the job is ${word(job.state)}: a human decides whether its PR merges`;
  const d = events.findLastIndex((e) => e.type === 'decision');
  if (d >= 0) {
    const ended = events.findIndex((e, i) => i > d && e.type === 'transition' && ENDED_STATES.has(String(stageOf(e.to).state)));
    if (ended >= 0) return `the job was ${stageOf(events[ended].to).state} after the approver's decision: a human decides whether its PR merges`;
    const round = events.findIndex((e, i) => i > d && e.type === 'round');
    if (round >= 0) {
      const n = events[round].round;
      return `round ${Number.isInteger(n) && (n as number) > 0 ? n : '?'} started after the approver's decision; the approver decides again before an auto-merge, or a human merges it`;
    }
    const rework = events.findIndex((e, i) => i > d && e.type === 'human' && SUPERSEDING_ACTIONS.has(e.action as string));
    if (rework >= 0) return `a ${events[rework].action} was recorded after the approver's decision; the approver decides again before an auto-merge, or a human merges it`;
  }
  const open = requests.filter((r) => r.job === job.id && OPEN_REQUEST.has(r.status));
  const queued = open.find((r) => SUPERSEDING_REQUESTS.has(r.type));
  if (queued)
    return queued.type === 'cancel'
      ? 'a cancel request for this job is waiting in the request inbox: a human decides whether its PR merges'
      : `a ${queued.type} request for this job is waiting in the request inbox; once it is handled the approver decides again before an auto-merge, or a human merges it`;
  if (open.some((r) => r.type === 'gate')) return 'a gate request for this job is waiting for the Foreman: it decides that gate first, or a human merges the PR';
  // A linked job's PRs merge as one unit under one decision, so a change request on any of them holds every one.
  const members = memberRepos({ repos: job.repos ?? [] }).filter((m) => !m.verifyOnly);
  if (requestsChanges(job.pr))
    return `a review on GitHub requests changes on ${members.length ? 'the root PR' : 'this PR'}: a human merges it, or dismisses that review on GitHub once it is addressed`;
  const member = members.find((m) => requestsChanges(m.pr));
  if (member) return `a review on GitHub requests changes on repo ${word(member.repo)}'s PR: a human merges the job's PRs, or dismisses that review on GitHub once it is addressed`;
  return null;
}

/** An APPROVE the approver marked auto-merge eligible, bound to a head. Every event from before the binding fails. */
export function decisionEligible(d: DecisionRecord | null | undefined): d is DecisionRecord & { head: string } {
  return Boolean(d && d.decision === 'APPROVE' && d.autoMerge === true && d.head !== null && FULL_SHA.test(d.head));
}

/** The head the decision approved for one PR: the root's (`repo` null) or a member's. */
export function decidedHead(d: DecisionRecord, repo: string | null): string | null {
  if (repo === null) return d.head;
  return Object.hasOwn(d.heads, repo) ? d.heads[repo] : null;
}

/** `git … ` that answers yes or no; any failure is no. */
const yes = (cwd: string, args: string[]): boolean => git(cwd, args, { env: historyEnv(), allowFail: true }).ok;

const isCommit = (cwd: string, s: string): boolean => git(cwd, ['cat-file', '-t', s], { env: historyEnv(), allowFail: true }).stdout.trim() === 'commit';

/**
 * Whether `head` is the decided commit, or that commit with only clean merges of the base on top:
 * each commit on the first-parent chain from `decided` has two parents, the previous commit and a
 * commit already on the base, and a tree equal to git's own merge of the two (so nothing rides in
 * a merge). Forge's `forge integrate` with `strategy: merge` and no conflicts makes exactly this.
 * Never throws: a git failure, a non-commit or a non-hex value is false.
 */
export function headFollows(cwd: string, config: Config, base: Pick<Job, 'base'>, decided: string | null | undefined, head: string | null | undefined): boolean {
  try {
    if (!decided || !head || !FULL_SHA.test(decided) || !FULL_SHA.test(head)) return false;
    if (head === decided) return true;
    if (!isCommit(cwd, decided) || !isCommit(cwd, head)) return false;
    if (!yes(cwd, ['merge-base', '--is-ancestor', decided, head])) return false;
    const tip = resolveBase(cwd, config, base, head).tip;
    if (!FULL_SHA.test(tip)) return false;
    const list = git(cwd, ['rev-list', '--first-parent', '--parents', `--max-count=${MAX_CHAIN + 1}`, `${decided}..${head}`], { env: historyEnv(), allowFail: true });
    if (!list.ok) return false;
    const chain = list.stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter((l) => l[0]).reverse();
    if (!chain.length || chain.length > MAX_CHAIN || chain.at(-1)![0] !== head) return false;
    let prev = decided;
    for (const [commit, p1, p2, ...rest] of chain) {
      if (rest.length || !p2 || p1 !== prev || ![commit, p1, p2].every((s) => FULL_SHA.test(s))) return false;
      if (!yes(cwd, ['merge-base', '--is-ancestor', p2, tip])) return false;
      const touched = integrationTouched(cwd, p1, p2, commit, { conflictFree: true });
      if (touched === null || touched.length) return false;
      prev = commit;
    }
    return true;
  } catch {
    return false;
  }
}

const headOf = (cwd: string): string | null => sha(git(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'], { env: historyEnv(), allowFail: true }).stdout.trim());

/**
 * Whether the recorded decision still covers every job repo: it is eligible, and the root worktree's
 * HEAD and each PR member's trusted worktree HEAD follow their decided heads. Step's PR4 reads this;
 * mergePr checks the live PR heads itself.
 */
export function decisionCurrent(root: string, config: Config, job: Job, events: JobEvent[]): boolean {
  const d = lastDecision(events);
  if (!decisionEligible(d) || !job.worktree) return false;
  try {
    if (!headFollows(job.worktree, config, job, d.head, headOf(job.worktree))) return false;
    for (const m of memberRepos(job).filter((r) => !r.verifyOnly)) {
      const wt = trustedMemberWorktree(root, config, job, m.repo);
      if (!wt || !headFollows(wt, config, { base: m.base }, decidedHead(d, m.repo), headOf(wt))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether every job repo's HEAD still follows the head the current round's review was given. Null
 * when the round has no `verdicts` event: nothing is bound. The anchor is the head on RV2's own
 * `scope` event: the round's first one after its last verify run, with both before the panel's
 * first reviewer start (the first `reviewer:` agent-start since the round's own `round` event; the
 * verdicts event when none), and only when it is the head that run verified. A scope
 * logged earlier, during build, is not RV2's, and a verify, commit or scope after a reviewer
 * started (RV2 logs a fresh one after any verify) is not what the reviewers were given. It is never
 * the `verdicts` sha, which is read after the panel ends and so would cover a commit a reviewer made
 * during it. An integrate conflict episode that started on a reviewed head, left integrate for
 * decide or pr, and whose last verify passed moves the anchor to the head that verify checked.
 * Anything else, a missing record or a git failure is false.
 */
export function reviewCurrent(root: string, config: Config, job: Job, events: JobEvent[]): boolean | null {
  const v = events.findLastIndex((e) => e.type === 'verdicts' && e.round === job.round);
  if (v < 0) return null;
  try {
    if (!job.worktree) return false;
    // The round's own `round` event, or -1 in a log without one. Every earlier round's reviewer starts
    // come before it, and leaving review and coming back within the round keeps the first panel's bound.
    const opened = events.findIndex((e, i) => i < v && e.type === 'round' && e.round === job.round);
    const started = events.findIndex((e, i) => i > opened && i < v && e.type === 'agent-start' && typeof e.role === 'string' && e.role.startsWith('reviewer:'));
    const panel = started < 0 ? v : started;
    const lv = roundRuns(job).filter((r) => typeof r.at === 'string' && r.at < events[panel].ts).at(-1);
    if (!lv || lv.ok !== true) return false;
    const s = events.findIndex((e, i) => i < panel && e.type === 'scope' && e.round === job.round && after(e.ts, lv.at));
    if (s < 0) return false;
    const scope = events[s];
    let anchor = sha(scope.head);
    if (!anchor || anchor !== sha(lv.sha)) return false;
    for (let pos = v, c = nextConflicts(events, pos); c >= 0; c = nextConflicts(events, pos)) {
      const t = events.findIndex((e, i) => i > c && e.type === 'transition' && stageOf(e.from).stage === 'integrate' && stageOf(e.to).stage !== 'integrate');
      if (t < 0) break;
      const last = runsSince(job, events[c].ts).filter((r) => typeof r.at === 'string' && r.at < events[t].ts).at(-1);
      const to = stageOf(events[t].to).stage;
      const start = sha(events[c].head);
      if ((to === 'decide' || to === 'pr') && last?.ok === true && sha(last.sha) && start && headFollows(job.worktree, config, job, anchor, start)) anchor = last.sha;
      pos = t;
    }
    if (!headFollows(job.worktree, config, job, anchor, headOf(job.worktree))) return false;
    const heads = isMap(scope.heads) ? scope.heads : {};
    for (const name of reviewedRepoNames(job)) {
      const wt = trustedMemberWorktree(root, config, job, name);
      const reviewed = Object.hasOwn(heads, name) ? sha(heads[name]) : null;
      if (!wt || !headFollows(wt, config, { base: memberEntry(job, name)?.base ?? null }, reviewed, headOf(wt))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** The first `integrate-conflicts` event after position `pos`, or -1. */
const nextConflicts = (events: JobEvent[], pos: number): number => events.findIndex((e, i) => i > pos && e.type === 'integrate-conflicts');

const short = (s: string | null | undefined): string => String(s ?? 'none').slice(0, 12);

/** At most 3 paths, control characters escaped, the rest counted. */
function pathList(paths: string[]): string {
  const shown = paths.slice(0, 3).map(clean);
  return [...shown, ...(paths.length > 3 ? [`+${paths.length - 3} more`] : [])].join(', ');
}

/** One PR as the gate checks it: the repo it is in (null: the root), and GitHub's live head and base branch from this call's sync. */
export interface GateTarget {
  repo: string | null;
  headOid: string | null;
  baseRef: string | null;
}

const named = (b: string | null | undefined): string => (b ? JSON.stringify(clean(b).slice(0, 80)) : 'no branch');

/**
 * Checks 1 to 6 of a merge without --now, in order (docs/CONFIG.md "Merge"): merge.auto is on, the
 * decision still stands (decisionSuperseded, given the request inbox too), the last decision event is eligible, the live head
 * follows the decided head on the base the job targets, protected paths recomputed at the live head
 * are all approved (throws `protected_path` otherwise, as forge pr open does), and the escalate floor
 * finds nothing. A check that can't be computed refuses under its own reason. Checks 4 to 6 compare
 * against the base as the push remote holds it now (remoteBaseTip), never a local ref the job's
 * worktree could have moved; a base that can't be read refuses under `decision`, and so does a PR
 * GitHub now targets at another branch, since GitHub merges into that one and every check would run
 * on a diff that does not land.
 */
export function autoMergeGate(root: string, config: Config, job: Job, events: JobEvent[], target: GateTarget): GateResult {
  if (!autoMerge(config)) return { ok: false, reason: 'auto-off', error: 'merge.auto is off: a human merges this PR on GitHub, or runs forge pr merge <id> --now in their own terminal' };
  const stale = decisionSuperseded(job, events, listRequests(root));
  if (stale) return { ok: false, reason: 'superseded', error: stale };
  const d = lastDecision(events);
  if (!decisionEligible(d))
    return { ok: false, reason: 'decision', error: "the approver's recorded decision is not an auto-merge eligible APPROVE bound to a head (forge job decision records it); a human reviews and merges this PR" };
  const live = sha(target.headOid);
  const decided = decidedHead(d, target.repo);
  let cwd: string;
  let base: Pick<Job, 'base'>;
  try {
    cwd = target.repo === null ? root : memberClone(root, config, target.repo);
    base = target.repo === null ? { base: job.base } : { base: memberEntry(job, target.repo)?.base ?? null };
  } catch (e) {
    return { ok: false, reason: 'decision', error: `repo ${target.repo} can't be checked against the approved head: ${(e as Error).message}; a human reviews and merges it` };
  }
  const notApproved = (): GateResult => ({ ok: false, reason: 'decision', error: `the PR head ${short(target.headOid)} is not the commit the approver approved (${short(decided)}); a human reviews and merges it` });
  if (live === null) return notApproved();
  if (target.baseRef === null || target.baseRef !== base.base) return { ok: false, reason: 'decision', error: `the PR targets ${named(target.baseRef)} on GitHub, not the job's base ${named(base.base)}; a human reviews and merges it` };
  // From here the base is a commit id read from the remote, which resolveBase takes as it is.
  try {
    base = { base: remoteBaseTip(cwd, config, job.id, base.base) };
  } catch (e) {
    return { ok: false, reason: 'decision', error: `the PR head can't be checked against the base: ${clean((e as Error).message).slice(0, 200)}; retry, or a human reviews and merges it` };
  }
  if (!headFollows(cwd, config, base, decided, live)) return notApproved();
  protectedGate(cwd, config, job, events, base, live, target.repo);
  let floor: string[];
  try {
    floor = branchFloor(cwd, config, base, live, { member: target.repo !== null }).map((p) => (target.repo === null ? p : `${target.repo}:${p}`));
  } catch (e) {
    return { ok: false, reason: 'floor', error: `the escalate floor could not be checked at ${short(live)} (${clean((e as Error).message).slice(0, 200)}), so only a human merges it` };
  }
  if (floor.length) return { ok: false, reason: 'floor', error: `the PR changes ${pathList(floor)}, which only a human merges` };
  return { ok: true, moved: live !== decided };
}

/**
 * Check 5: protected paths at the live head, never the stored flag alone. A refuse hit, or an
 * escalate hit whose (path, blob) the job flag does not hold under a human approval, throws
 * `protected_path`; so does a check that can't be computed.
 */
function protectedGate(cwd: string, config: Config, job: Job, events: JobEvent[], base: Pick<Job, 'base'>, live: string, repo: string | null): void {
  const label = repo === null ? 'the PR head' : `repo ${repo}'s PR head`;
  let found: { refused: ProtectedHit[]; escalated: ProtectedHit[] };
  try {
    const hits = branchHits(cwd, config, base, live);
    found = repo === null ? hits : prefixHits(repo, hits);
  } catch (e) {
    if (e instanceof ForgeError && e.code === 'config_invalid') throw e;
    throw new ForgeError(`protected paths could not be checked at ${label} ${short(live)}: ${clean((e as Error).message).slice(0, 200)}; a human merges it`, 'protected_path');
  }
  if (found.refused.length) throw new ForgeError(refusalText(`${label} ${short(live)}`, found.refused), 'protected_path');
  if (!found.escalated.length) return;
  const flag = job.protectedPaths;
  const key = (h: Pick<ProtectedHit, 'path' | 'blob'>) => `${h.path}\0${h.blob ?? ''}`;
  const held = new Set((Array.isArray(flag?.hits) ? flag.hits : []).map(key));
  const unheld = found.escalated.filter((h) => !held.has(key(h)));
  if (unheld.length || !protectedApproved(flag, events))
    throw new ForgeError(
      `${label} ${short(live)} changes protected paths no human approved at this content: ${pathList((unheld.length ? unheld : found.escalated).map((h) => h.path))}; a human approves them in forge job step's protected-paths gate, or merges with --now in their own terminal`,
      'protected_path',
    );
}
