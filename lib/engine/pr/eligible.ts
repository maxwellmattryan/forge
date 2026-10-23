// Whether a job's PR may merge without a person: the recorded decision bound to its head, recomputed
// protected paths and the escalate floor. mergePr asks autoMergeGate before any merge without --now,
// whoever calls it; `forge job step` asks decisionCurrent before PR4. decision.md is never read here:
// only the `decision` event `forge job decision` recorded once per approver run counts.
import { autoMerge } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { isMap } from '#core/shape.ts';
import type { Config, Job, JobEvent, ProtectedHit } from '#core/types.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { branchFloor } from '../guard/floor.ts';
import { branchHits, clean, prefixHits, protectedApproved, refusalText } from '../guard/protected.ts';
import { integrationTouched, resolveBase } from '../pipeline/scope.ts';
import { memberClone, memberEntry, memberRepos, trustedMemberWorktree } from '../project/job-repos.ts';

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
export type GateReason = 'auto-off' | 'decision' | 'floor';

export type GateResult = { ok: true } | { ok: false; reason: GateReason; error: string };

const sha = (v: unknown): string | null => (typeof v === 'string' && FULL_SHA.test(v) ? v : null);

/** The last `decision` event, or null. A head that is not a full commit id reads as null. */
export function lastDecision(events: JobEvent[]): DecisionRecord | null {
  const e = events.findLast((x) => x.type === 'decision');
  if (!e) return null;
  // fromEntries defines own properties, so a `__proto__` key can't reach the prototype; decidedHead reads with hasOwn.
  const heads: Record<string, string | null> = isMap(e.heads) ? Object.fromEntries(Object.entries(e.heads).map(([k, v]) => [k, sha(v)])) : {};
  return { decision: typeof e.decision === 'string' ? e.decision : null, autoMerge: e.autoMerge === true, head: sha(e.head), heads };
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
      const touched = integrationTouched(cwd, p1, p2, commit);
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

const short = (s: string | null | undefined): string => String(s ?? 'none').slice(0, 12);

/** At most 3 paths, control characters escaped, the rest counted. */
function pathList(paths: string[]): string {
  const shown = paths.slice(0, 3).map(clean);
  return [...shown, ...(paths.length > 3 ? [`+${paths.length - 3} more`] : [])].join(', ');
}

/** One PR as the gate checks it: the repo it is in (null: the root) and GitHub's live head from this call's sync. */
export interface GateTarget {
  repo: string | null;
  headOid: string | null;
}

/**
 * Checks 1 to 5 of a merge without --now, in order (docs/CONFIG.md "Merge"): merge.auto is on, the
 * last decision event is eligible, the live head follows the decided head, protected paths recomputed
 * at the live head are all approved (throws `protected_path` otherwise, as forge pr open does), and
 * the escalate floor finds nothing. A check that can't be computed refuses under its own reason.
 */
export function autoMergeGate(root: string, config: Config, job: Job, events: JobEvent[], target: GateTarget): GateResult {
  if (!autoMerge(config)) return { ok: false, reason: 'auto-off', error: 'merge.auto is off: a human merges this PR on GitHub, or runs forge pr merge <id> --now in their own terminal' };
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
  if (live === null || !headFollows(cwd, config, base, decided, live))
    return { ok: false, reason: 'decision', error: `the PR head ${short(target.headOid)} is not the commit the approver approved (${short(decided)}); a human reviews and merges it` };
  protectedGate(cwd, config, job, events, base, live, target.repo);
  let floor: string[];
  try {
    floor = branchFloor(cwd, config, base, live, { member: target.repo !== null }).map((p) => (target.repo === null ? p : `${target.repo}:${p}`));
  } catch (e) {
    return { ok: false, reason: 'floor', error: `the escalate floor could not be checked at ${short(live)} (${clean((e as Error).message).slice(0, 200)}), so only a human merges it` };
  }
  if (floor.length) return { ok: false, reason: 'floor', error: `the PR changes ${pathList(floor)}, which only a human merges` };
  return { ok: true };
}

/**
 * Check 4: protected paths at the live head, never the stored flag alone. A refuse hit, or an
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
