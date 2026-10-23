// Merging a job's PRs once CI allows it, in dependency order for a linked job, and marking drafts
// ready.
import fs from 'node:fs';
import path from 'node:path';
import { currentActor } from '#integrations/github/actor.ts';
import { loadJob, logEvent, readEvents, setJob } from '#core/job/store.ts';
import { policyRules } from '#core/config/validators/policy-check.ts';
import { exists } from '#core/paths.ts';
import type { Config, Job, JobPr, JobRepoPr, PrChecks } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { PR_STATES, SLUG_RE, safePrNumber } from '#integrations/github/pull-requests.ts';
import type { GitHub } from '#integrations/github/types.ts';
import { memberClone, memberEntry, memberRepos } from '../project/job-repos.ts';
import { REPO_NAME } from '../project/member-repos.ts';
import { isLinkedJob, jobRepoOrder } from '../project/repo-order.ts';
import type { PrStateKey, RepoKey } from '../project/repo-order.ts';
import { bumpsOnRelease, releaseGates, repoLabel, resolveInterim } from '../release/interim.ts';
import type { ReleaseGate } from '../release/interim.ts';
import { interimStatus } from '../release/interim-apply.ts';
import { FULL_SHA, autoMergeGate } from './eligible.ts';
import type { GateReason, GateResult } from './eligible.ts';
import { memberSlug, recordMemberPr } from './members.ts';
import type { MemberSync } from './members.ts';
import { syncPr, syncPrDetailed } from './sync.ts';

/** What `forge pr merge` returns: mergePr. */
export interface MergeResult {
  merged: boolean;
  autoMerge?: boolean;
  action: 'already-merged' | 'deferred' | 'refused' | 'failed' | 'auto' | 'merged';
  checks: PrChecks['state'] | undefined;
  mergeState?: string | null;
  error?: string;
  /** A linked job: the PR the action is about (null: the root). */
  repo?: string | null;
  /**
   * Why it was refused: a dependency PR is not merged (order), the dependsOn edges cycle, a release
   * gate holds it, or a merge without --now failed autoMergeGate (auto-off, decision, floor).
   */
  reason?: MergeReason;
  /** A linked job: each PR this call acted on, in merge order. */
  parts?: MergePart[];
}

/** One PR a linked job's merge acted on: mergePr. */
export interface MergePart {
  repo: string | null;
  number: number | null;
  action: MergeResult['action'];
  checks: PrChecks['state'] | undefined;
  mergeState?: string | null;
  error?: string;
}

export type MergeReason = 'order' | 'cycle' | 'release' | GateReason;

// Merge states in which GitHub itself holds a PR back (required checks or reviews, or an
// up-to-date requirement). In any other state `gh pr merge --auto` merges immediately.
const ENFORCED_MERGE_STATES = new Set(['BLOCKED', 'BEHIND']);

/**
 * How long after Forge's last push a PR head is settling: a rollup read sooner may not hold every
 * check yet, so neither an all-green nor an empty one merges directly.
 */
export const CI_SETTLE_MS = 5 * 60_000;

/**
 * The merge policy as a pure function, so the only branch point in `mergePr` is testable
 * without GitHub. A direct merge is safe only when CI has passed, or the repo has none, at a head
 * that has settled. `checksState` is `passing|pending|failing|none` from summarizeChecks, which
 * can't tell a partial rollup from a complete one: `settled` (false unless the caller knows) can.
 */
export function mergeAction(
  checksState: string | undefined,
  { hasWorkflows = false, now = false, mergeState = null, settled = false }: { hasWorkflows?: boolean; now?: boolean; mergeState?: string | null; settled?: boolean } = {},
): 'merge' | 'auto' | 'defer' | 'refuse' {
  if (now) return 'merge';
  if (checksState === 'failing') return 'refuse';
  // UNSTABLE: GitHub sees a status that has not passed, whatever the rollup we read says.
  if (checksState === 'passing' && settled && String(mergeState ?? '').toUpperCase() !== 'UNSTABLE') return 'merge';
  // An empty rollup on a repo with workflows means they have not registered yet, not that
  // there is nothing to wait for.
  if (checksState === 'none' && !hasWorkflows && settled) return 'merge';
  // Pending, settling, not yet registered, or a state we do not recognise: wait for CI. `--auto`
  // only waits when GitHub enforces requirements; otherwise (e.g. UNSTABLE on an unprotected repo)
  // it merges at once, so Forge defers and a later `forge pr merge` re-decides.
  return ENFORCED_MERGE_STATES.has(String(mergeState ?? '').toUpperCase()) ? 'auto' : 'defer';
}

/** The CI systems hasCiWorkflows knows, as paths from the repo root. */
const CI_PATHS = ['.github/workflows', '.circleci', '.buildkite', '.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml'];
const CI_ROOT_FILES = new Set(['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml']);

/** One repo path that configures CI: a top-level Actions workflow, anything under .circleci/ or .buildkite/, or a root CI file. */
const isCiPath = (n: string): boolean => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(n) || n.startsWith('.circleci/') || n.startsWith('.buildkite/') || CI_ROOT_FILES.has(n);

/**
 * Whether `ref` (else the working tree) configures CI on any system in CI_PATHS. Used only when
 * the checks rollup is empty, to tell "no CI" from "CI not reported yet". Callers pass the base
 * branch, not the PR head, so a PR cannot make itself look CI-free by deleting its CI config; the
 * cost is that a PR adding a repo's first CI is treated as having none.
 */
export function hasCiWorkflows(root: string, ref?: string): boolean {
  if (ref) {
    const ls = git(root, ['ls-tree', '-r', '-z', '--name-only', ref, '--', ...CI_PATHS], { allowFail: true });
    if (ls.ok) return ls.stdout.split('\0').some(isCiPath);
  }
  const has = (rel: string, pred: (names: string[]) => boolean): boolean => {
    try {
      return pred(fs.readdirSync(path.join(root, rel)));
    } catch {
      return false;
    }
  };
  if (has('.github/workflows', (names) => names.some((n) => /\.ya?ml$/.test(n)))) return true;
  if (has('.circleci', (names) => names.length > 0) || has('.buildkite', (names) => names.length > 0)) return true;
  return [...CI_ROOT_FILES].some((f) => exists(path.join(root, f)));
}

/** One PR as a merge decides on it: what this call's sync read, plus when forge pr open last pushed. */
interface MergeTarget {
  repo: string | null;
  number: number;
  /** Only read once a gh merge call is due, as before linked jobs. */
  slug: () => string;
  state: string | null | undefined;
  checks: PrChecks['state'] | undefined;
  mergeState: string | null;
  headOid: string | null;
  /** The ts of the job's last pr-opened/pr-updated event (one forge pr open pushes every repo), or null. */
  pushedAt: string | null;
  /** When the live head was committed, in ms, or null when it can't be read. Asked only for a head that moved on. */
  headAt: () => number | null;
  /** Whether the PR's base has workflows, asked only when the checks rollup is empty. */
  hasWorkflows: () => boolean;
}

/** When forge pr open last pushed the job: the head is settling until CI_SETTLE_MS after it. */
function lastPushAt(root: string, id: string): string | null {
  const e = readEvents(root, id).findLast((x) => x.type === 'pr-opened' || x.type === 'pr-updated');
  return typeof e?.ts === 'string' ? e.ts : null;
}

/** When commit `sha` was committed in `cwd`, in ms, or null (not a commit id, absent or unreadable). */
function commitTime(cwd: string, sha: string | null): number | null {
  if (sha === null || !FULL_SHA.test(sha)) return null;
  const out = git(cwd, ['log', '-1', '--format=%ct', sha, '--'], { env: historyEnv(), allowFail: true });
  const secs = Number(out.stdout.trim());
  return out.ok && Number.isInteger(secs) && secs > 0 ? secs * 1000 : null;
}

const prLabel = (repo: string | null, number: number | null): string => (repo === null ? `PR #${number ?? '?'}` : number === null ? `repo ${repo} (no PR)` : `repo ${repo} PR #${number}`);

/**
 * One PR's merge policy. Without --now, autoMergeGate first (merge.auto, the decision bound to this
 * head, protected paths at it, the escalate floor), then CI: direct when checks pass (or its repo
 * has no CI) at a settled head, queued with `--auto` while pending if GitHub enforces requirements,
 * deferred (no call) while pending if it does not, refused when failing. Exactly one `gh pr merge`
 * call, never a fallback between direct and `--auto`, because a fallback is how unverified code got
 * merged. `tag` goes on every event (repo, target).
 */
function mergeOne(root: string, config: Config, github: GitHub, id: string, t: MergeTarget, opts: { now: boolean; tag: Record<string, unknown>; clock: () => number }): MergeResult {
  const { number, checks, tag } = { ...t, tag: opts.tag };
  const label = prLabel(t.repo, number);
  if (t.state === 'MERGED') return { merged: true, action: 'already-merged', checks };
  if (t.state === 'CLOSED') throw new ForgeError(`${label} is closed; reopen it before merging`);
  const now = opts.now;
  // The live head carries base merges Forge did not push (GitHub's "Update branch", a person's push).
  let moved = false;
  if (!now) {
    let gate: GateResult;
    try {
      gate = autoMergeGate(root, config, loadJob(root, id), readEvents(root, id), { repo: t.repo, headOid: t.headOid });
    } catch (e) {
      if (e instanceof ForgeError && e.code === 'protected_path') logEvent(root, id, 'pr-merge-refused', { ...tag, number, checks, head: t.headOid, reason: 'protected' });
      throw e;
    }
    if (gate.ok === false) {
      logEvent(root, id, 'pr-merge-refused', { ...tag, number, checks, head: t.headOid, reason: gate.reason });
      return { merged: false, autoMerge: false, action: 'refused', checks, reason: gate.reason, error: gate.error };
    }
    moved = gate.moved;
  }
  const hasWorkflows = checks === 'none' ? t.hasWorkflows() : false;
  const mergeState = t.mergeState;
  const old = (at: number | null): boolean => at !== null && Number.isFinite(at) && opts.clock() - at >= CI_SETTLE_MS;
  // No push event (or an unreadable one) never settles: such a PR waits on a human or --now. A head
  // that is not the decided one is as young as its newest commit, whenever Forge last pushed.
  const settled = old(t.pushedAt === null ? null : Date.parse(t.pushedAt)) && (!moved || old(t.headAt()));
  const decided = mergeAction(checks, { hasWorkflows, now, mergeState, settled });
  const settling = decided !== 'merge' && !settled && mergeAction(checks, { hasWorkflows, mergeState, settled: true }) === 'merge';
  // Once --auto is queued, GitHub merges on its own, and whether it still holds
  // --match-head-commit then is not documented. Under a protected-paths policy Forge waits instead,
  // so the merge that lands goes through the gate above (sync continues it).
  const held = decided === 'auto' && policyRules(config).length > 0;
  const action = held ? 'defer' : decided;
  if (action === 'defer') {
    logEvent(root, id, 'pr-merge-deferred', { ...tag, number, checks, mergeState, ...(held ? { reason: 'protected' } : settling ? { reason: 'settling' } : {}) });
    return { merged: false, autoMerge: false, action: 'deferred', checks, mergeState };
  }
  if (action === 'refuse') {
    logEvent(root, id, 'pr-merge-refused', { ...tag, number, checks });
    return { merged: false, autoMerge: false, action: 'refused', checks, error: 'CI is failing; fix it, or a human merges anyway with forge pr merge --now in their own terminal' };
  }
  const slug = t.slug();
  // --now is a person's call, so every event it writes says who; without it the approver's
  // auto-merge is not a human action and records no actor.
  const by = now ? { actor: currentActor(root) } : {};
  // Logged before the call so a human override is on record even if the merge then fails.
  if (now) logEvent(root, id, 'pr-merge-bypass', { ...tag, number, checks, ...by });
  // matchHead pins the commit whose checks were just read, so a push after the sync cannot ride along.
  const res = github.merge(root, slug, number, { method: config.merge.method, auto: action === 'auto', matchHead: t.headOid });
  // `=== false`, not `!`: the tests' loose type check narrows the union only on the literal.
  if (res.ok === false) {
    const error = res.error;
    logEvent(root, id, 'pr-merge-failed', { ...tag, number, error, ...by });
    return { merged: false, autoMerge: false, action: 'failed', checks, error };
  }
  if (action === 'auto') {
    logEvent(root, id, 'pr-auto-merge', { ...tag, number, checks, ...by });
    return { merged: false, autoMerge: true, action: 'auto', checks };
  }
  // --now skips every check above, not only CI, so its merge is always a bypass.
  logEvent(root, id, 'pr-merged', { ...tag, number, method: config.merge.method, checks, bypass: now, ...by });
  return { merged: true, autoMerge: false, action: 'merged', checks };
}

/**
 * Merges only once CI allows it (mergeOne). A linked job's PRs merge in the order of the
 * components' dependsOn (lib/engine/project/repo-order.ts): a PR is merged, or queued with `--auto`, only when
 * every dependency's PR is MERGED by this call's own sync, so a consumer never lands first and a
 * hand-edited job.json state counts for nothing. `repo` (a member) or `root` merges only that PR.
 */
export async function mergePr(
  root: string,
  config: Config,
  github: GitHub,
  id: string,
  opts: { now?: boolean; repo?: string; root?: boolean; clock?: () => number } = {},
): Promise<MergeResult> {
  const clock = opts.clock ?? Date.now;
  github.require();
  const job = loadJob(root, id);
  if (opts.repo !== undefined && opts.root) throw new ForgeError('pass --repo or --root, not both');
  if (opts.repo !== undefined) {
    if (typeof opts.repo !== 'string' || !REPO_NAME.test(opts.repo)) throw new ForgeError(`--repo must name a member repo (got ${(JSON.stringify(opts.repo) ?? String(opts.repo)).slice(0, 80)})`);
    const m = memberEntry(job, opts.repo);
    if (!m) throw new ForgeError(`job ${id} has no member repo ${opts.repo}`);
    if (m.verifyOnly) throw new ForgeError(`repo ${opts.repo} is verify-only in job ${id}, so it has no PR to merge`);
  }
  if (!job.pr?.number) throw new ForgeError(`job ${id} has no PR`);
  const now = opts.now === true;
  if (isLinkedJob(job)) return mergeLinked(root, config, github, id, { now, clock, target: opts.repo !== undefined ? opts.repo : opts.root ? null : undefined });
  // A merge never routes: a conflicting PR parks as before, and the next forge sync routes it.
  const { pr: synced } = await syncPr(root, config, github, id, { route: false });
  const number = synced?.number ?? job.pr.number;
  const checks = synced?.checks?.state;
  if (synced?.state === 'MERGED') return { merged: true, action: 'already-merged', checks };
  return mergeOne(root, config, github, id, rootTarget(root, config, github, id, number, synced), { now, tag: {}, clock });
}

/**
 * `forge sync`'s continuation of a deferred merge: mergePr without --now, so every check holds. The
 * inbox session runs forge sync and may not merge another job's PR, so without this no deferred
 * merge would finish unattended. A thrown error becomes the sync row's `error`.
 */
export async function continueMerge(root: string, config: Config, github: GitHub, id: string): Promise<{ merge: { action: MergeResult['action']; reason?: MergeReason; error?: string } } | { error: string }> {
  try {
    const m = await mergePr(root, config, github, id);
    return { merge: { action: m.action, ...(m.reason ? { reason: m.reason } : {}), ...(m.error ? { error: m.error.slice(0, 300) } : {}) } };
  } catch (e) {
    return { error: (e as Error).message.slice(0, 300) };
  }
}

// The live head is always GitHub's headRefOid from this call's sync, never job.json's pushedSha,
// which the session can write.
function rootTarget(root: string, config: Config, github: GitHub, id: string, number: number, synced: JobPr | null): MergeTarget {
  const job = loadJob(root, id);
  return {
    repo: null,
    number,
    slug: () => github.repoSlug(root, config),
    state: synced?.state,
    checks: synced?.checks?.state,
    mergeState: synced?.mergeState ?? null,
    headOid: synced?.headOid ?? null,
    pushedAt: lastPushAt(root, id),
    headAt: () => commitTime(root, synced?.headOid ?? null),
    hasWorkflows: () => hasCiWorkflows(root, `${config.git.remote}/${job.base}`),
  };
}

function memberTarget(root: string, config: Config, job: Job, m: MemberSync): MergeTarget {
  const entry = memberEntry(job, m.repo);
  return {
    repo: m.repo,
    number: m.number!,
    slug: () => {
      const slug = memberSlug(config, m.repo);
      if (!SLUG_RE.test(slug)) throw new ForgeError(`repo ${m.repo} has an unusable GitHub repository ${JSON.stringify(slug).slice(0, 80)}`);
      return slug;
    },
    state: m.state,
    checks: m.checks,
    mergeState: m.mergeState,
    headOid: m.headOid,
    pushedAt: lastPushAt(root, job.id),
    headAt: () => {
      try {
        return commitTime(memberClone(root, config, m.repo), m.headOid);
      } catch {
        return null;
      }
    },
    // A clone Forge can't check is treated as having CI: an empty rollup then waits, never merges.
    hasWorkflows: () => {
      try {
        return hasCiWorkflows(memberClone(root, config, m.repo), `${config.git.remote}/${entry?.base}`);
      } catch {
        return true;
      }
    },
  };
}

/**
 * `forge pr merge`'s and `forge pr ready`'s target flags, checked strictly: `--root` must be bare
 * (`--root <id>` would swallow the id), `--repo` one member name, and not both.
 */
export function mergeTarget(flags: Record<string, unknown>, sub: 'merge' | 'ready' = 'merge'): { repo?: string; root?: true } {
  const { repo, root } = flags;
  if (root !== undefined && root !== true) throw new ForgeError(`--root takes no value; put the job id first: forge pr ${sub} <id> --root`);
  if (repo !== undefined && (typeof repo !== 'string' || !REPO_NAME.test(repo))) throw new ForgeError(`--repo needs one member repo name: forge pr ${sub} <id> --repo NAME`);
  if (repo !== undefined && root === true) throw new ForgeError('pass --repo or --root, not both');
  return { ...(typeof repo === 'string' ? { repo } : {}), ...(root === true ? { root: true as const } : {}) };
}

/** mergePr for a linked job: the walk in merge order, or one `target` PR (null: the root). */
async function mergeLinked(root: string, config: Config, github: GitHub, id: string, opts: { now: boolean; clock: () => number; target: RepoKey | undefined }): Promise<MergeResult> {
  const { result, members } = await syncPrDetailed(root, config, github, id, { route: false });
  const job = loadJob(root, id);
  const { order, deps, cycle } = jobRepoOrder(config, job);
  const gates = releaseGates(resolveInterim(config, job).edges, readEvents(root, id), job);
  const synced = result.pr;
  const rootNumber = safePrNumber(synced?.number) ?? job.pr!.number;
  // This call's answers only: a member missing from the sync (or one that failed) is unknown.
  const states = new Map<RepoKey, PrStateKey>([[null, synced && PR_STATES.has(synced.state) ? synced.state : null]]);
  for (const k of order) if (k !== null) states.set(k, members.get(k)?.state ?? null);
  const numberOf = (k: RepoKey): number | null => (k === null ? rootNumber : (members.get(k)?.number ?? null));
  const label = (k: RepoKey): string => {
    const base = k === null ? `the root PR #${rootNumber}` : prLabel(k, numberOf(k));
    return states.get(k) === null && numberOf(k) !== null ? `${base} (state unknown)` : base;
  };
  const targeted = opts.target !== undefined;
  const tag = (k: RepoKey) => ({ ...(k !== null ? { repo: k } : {}), ...(targeted ? { target: true } : {}) });
  const keys: RepoKey[] = targeted ? [opts.target as RepoKey] : order;
  const parts: MergePart[] = [];
  let reason: MergeReason | undefined;
  const finish = (): MergeResult => {
    const merged = order.every((k) => states.get(k) === 'MERGED');
    const last = parts.at(-1);
    if (!last) {
      if (keys.every((k) => states.get(k) === 'MERGED')) return { merged, action: 'already-merged', checks: synced?.checks?.state, repo: keys.length === 1 ? keys[0] : null, parts };
      const unread = keys.filter((k) => states.get(k) !== 'MERGED').map(label);
      return { merged, autoMerge: false, action: 'refused', checks: undefined, error: `${unread.join(', ')} could not be read in this call; run: forge pr sync ${id}`, parts };
    }
    const { repo, action, checks, mergeState, error } = last;
    return { merged, autoMerge: action === 'auto', action, checks, ...(mergeState !== undefined ? { mergeState } : {}), ...(error !== undefined ? { error } : {}), repo, ...(reason ? { reason } : {}), parts };
  };
  const refuse = (k: RepoKey, why: 'order' | 'cycle' | 'release', error: string, extra: Record<string, unknown> = {}): MergeResult => {
    reason = why;
    logEvent(root, id, 'pr-merge-refused', { ...tag(k), number: numberOf(k), reason: why, ...extra });
    parts.push({ repo: k, number: numberOf(k), action: 'refused', checks: undefined, error });
    return finish();
  };
  if (cycle) {
    const k = keys.find((x) => states.get(x) !== 'MERGED');
    if (k === undefined) return finish();
    const names = cycle.map((x) => (x === null ? 'the root repo' : `repo ${x}`)).join(', ');
    return refuse(k, 'cycle', `the components' dependsOn form a cycle between ${names}; no PR of job ${id} is merged until config orders them`);
  }
  for (const k of keys) {
    const state = states.get(k);
    if (state === 'MERGED') continue;
    // Its consumers are refused on order below; the PR itself can't be judged on an unknown state.
    if (state === null && !targeted) continue;
    const waiting = (deps.get(k) ?? []).find((d) => states.get(d) !== 'MERGED');
    if (waiting !== undefined) return refuse(k, 'order', `${label(k)} depends on ${label(waiting)}, which is not merged yet; merge it first`, { waitingFor: label(waiting) });
    if (state === null) throw new ForgeError(numberOf(k) === null ? `repo ${k} has no PR to merge` : `${label(k)} could not be read in this call; run: forge pr sync ${id}`);
    // After the order check, and never bypassed by --now: a held consumer merges only after a human
    // recorded its dependency's release, and a bump-due one only once verify bumped it to that release.
    const gate = gates.find((g) => g.consumer === k && (g.gate === 'held' || g.gate === 'bump-due'));
    if (gate) return refuse(k, 'release', releaseGateMessage(id, gate));
    const t = k === null ? rootTarget(root, config, github, id, rootNumber, synced) : memberTarget(root, config, job, members.get(k)!);
    const r = mergeOne(root, config, github, id, t, { now: opts.now, tag: tag(k), clock: opts.clock });
    // The walk's reason is the refused PR's own (auto-off, decision, floor).
    if (r.reason) reason = r.reason;
    parts.push({ repo: k, number: t.number, action: r.action, checks: r.checks, ...(r.mergeState !== undefined ? { mergeState: r.mergeState } : {}), ...(r.error !== undefined ? { error: r.error } : {}) });
    if (r.action !== 'merged') break;
    states.set(k, 'MERGED');
  }
  return finish();
}

/** Why a held consumer's PR stays a draft, and the command a human runs to clear it; for a bump-due one, the commands that bump it. */
function releaseGateMessage(id: string, gate: Pick<ReleaseGate, 'consumer' | 'dependency'> & Partial<Pick<ReleaseGate, 'gate' | 'version'>>): string {
  if (gate.gate === 'bump-due')
    return `${repoLabel(gate.consumer)}'s manifests don't name ${repoLabel(gate.dependency)}'s released version ${gate.version} yet; run: forge verify ${id}, then forge pr open ${id}`;
  const dep = gate.dependency === null ? '--root' : gate.dependency;
  return `${repoLabel(gate.consumer)}'s PR stays a draft until ${repoLabel(gate.dependency)}'s release is recorded; a human runs: forge job interim release ${id} ${dep} <version>`;
}

/** What `forge pr ready` did: the PRs it marked ready for review, and the ones it left alone and why. */
export interface ReadyResult {
  id: string;
  ready: { repo: RepoKey; number: number }[];
  skipped: { repo: RepoKey; number: number | null; why: string }[];
}

/**
 * `forge pr ready`: marks the job's draft PRs ready for review, in merge order. With no target, every
 * open draft PR of the job (root and non-verify-only members); with `repo` or `root`, only that one.
 * Refused (`release_gate`) before any gh call while a targeted repo's release gate is held or bump-due,
 * or its manifests at HEAD don't name a recorded release yet.
 */
export function readyPr(root: string, config: Config, github: GitHub, id: string, target: { repo?: string; root?: true } = {}): ReadyResult {
  const job = loadJob(root, id);
  if (target.repo !== undefined) {
    const m = memberEntry(job, target.repo);
    if (!m) throw new ForgeError(`job ${id} has no member repo ${target.repo}`);
    if (m.verifyOnly) throw new ForgeError(`repo ${target.repo} is verify-only in job ${id}, so it has no PR`);
  }
  const prOf = (k: RepoKey) => (k === null ? job.pr : memberEntry(job, k)?.pr);
  const all: RepoKey[] = [null, ...memberRepos(job).filter((m) => !m.verifyOnly).map((m) => m.repo)];
  const { order } = jobRepoOrder(config, job);
  const rank = (k: RepoKey) => (order.includes(k) ? order.indexOf(k) : order.length + all.indexOf(k));
  const keys: RepoKey[] =
    target.repo !== undefined
      ? [target.repo]
      : target.root
        ? [null]
        : all.filter((k) => {
            const pr = prOf(k);
            return pr?.state === 'OPEN' && pr.isDraft === true;
          });
  keys.sort((a, b) => rank(a) - rank(b));
  const edges = resolveInterim(config, job).edges;
  const gates = releaseGates(edges, readEvents(root, id), job);
  for (const k of keys) {
    const gate = gates.find((g) => g.consumer === k && (g.gate === 'held' || g.gate === 'bump-due'));
    if (gate) throw new ForgeError(releaseGateMessage(id, gate), 'release_gate');
  }
  // events.jsonl is writable outside the CLI: a released gate on a release edge is only believed once
  // the consumer's manifests at HEAD really name the released version (git, no network).
  if (keys.some((k) => gates.some((g, i) => g.consumer === k && g.gate === 'released' && bumpsOnRelease(edges[i], job)))) {
    const status = interimStatus(root, config, job).edges;
    for (const k of keys) {
      const stale = status.find((e) => e.consumer === k && e.release !== undefined && e.state !== 'released');
      if (stale) throw new ForgeError(releaseGateMessage(id, { consumer: k, dependency: stale.dependency, gate: 'bump-due', version: stale.release }), 'release_gate');
    }
  }
  const out: ReadyResult = { id, ready: [], skipped: [] };
  const pending: { repo: RepoKey; number: number }[] = [];
  for (const k of keys) {
    const pr = prOf(k);
    const number = safePrNumber(pr?.number);
    if (number === null) out.skipped.push({ repo: k, number: null, why: 'no PR' });
    else if (pr?.state !== 'OPEN') out.skipped.push({ repo: k, number, why: `not open (${String(pr?.state ?? 'unknown').slice(0, 20)})` });
    else if (pr.isDraft !== true) out.skipped.push({ repo: k, number, why: 'not a draft' });
    else pending.push({ repo: k, number });
  }
  if (!pending.length) return out;
  github.require();
  for (const { repo, number } of pending) {
    let slug: string;
    if (repo === null) slug = github.repoSlug(root, config);
    else {
      slug = memberSlug(config, repo);
      if (!SLUG_RE.test(slug)) throw new ForgeError(`repo ${repo} has an unusable GitHub repository ${JSON.stringify(slug).slice(0, 80)}`);
    }
    github.ready(root, slug, number);
    if (repo === null) setJob(root, id, { owned: { 'pr.isDraft': false } });
    else recordMemberPr(root, id, repo, (prev) => ({ ...(prev ?? {}), isDraft: false }) as JobRepoPr);
    logEvent(root, id, 'pr-ready', { ...(repo !== null ? { repo } : {}), number });
    out.ready.push({ repo, number });
  }
  return out;
}
