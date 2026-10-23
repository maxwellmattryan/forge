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
import { git } from '#integrations/git/runner.ts';
import { PR_STATES, SLUG_RE, markPrReady, repoSlug, requireGh, safePrNumber, submitMerge } from '#integrations/github/pull-requests.ts';
import { memberClone, memberEntry, memberRepos } from '../project/job-repos.ts';
import { REPO_NAME } from '../project/member-repos.ts';
import { isLinkedJob, jobRepoOrder } from '../project/repo-order.ts';
import type { PrStateKey, RepoKey } from '../project/repo-order.ts';
import { bumpsOnRelease, releaseGates, repoLabel, resolveInterim } from '../release/interim.ts';
import type { ReleaseGate } from '../release/interim.ts';
import { interimStatus } from '../release/interim-apply.ts';
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
  /** A linked job's refusal: a dependency PR is not merged (order) or the dependsOn edges cycle. */
  reason?: 'order' | 'cycle' | 'release';
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

// Merge states in which GitHub itself holds a PR back (required checks or reviews, or an
// up-to-date requirement). In any other state `gh pr merge --auto` merges immediately.
const ENFORCED_MERGE_STATES = new Set(['BLOCKED', 'BEHIND']);

/**
 * The merge policy as a pure function, so the only branch point in `mergePr` is testable
 * without GitHub. A direct merge is safe only when CI has passed or the repo has none.
 * `checksState` is `passing|pending|failing|none` from summarizeChecks.
 */
export function mergeAction(
  checksState: string | undefined,
  { hasWorkflows = false, now = false, mergeState = null }: { hasWorkflows?: boolean; now?: boolean; mergeState?: string | null } = {},
): 'merge' | 'auto' | 'defer' | 'refuse' {
  if (now) return 'merge';
  if (checksState === 'passing') return 'merge';
  if (checksState === 'failing') return 'refuse';
  // An empty rollup on a repo with workflows means they have not registered yet, not that
  // there is nothing to wait for.
  if (checksState === 'none' && !hasWorkflows) return 'merge';
  // Pending, not yet registered, or a state we do not recognise: wait for CI. `--auto` only
  // waits when GitHub enforces requirements; otherwise (e.g. UNSTABLE on an unprotected repo)
  // it merges at once, so Forge defers and a later `forge pr merge` re-decides.
  return ENFORCED_MERGE_STATES.has(String(mergeState ?? '').toUpperCase()) ? 'auto' : 'defer';
}

/**
 * Whether `ref` (else the working tree) has GitHub Actions workflows. Used only when the
 * checks rollup is empty, to tell "no CI" from "CI not reported yet". Callers pass the base
 * branch, not the PR head, so a PR cannot make itself look CI-free by deleting workflows; the
 * cost is that a PR adding a repo's first workflow is treated as having no CI.
 */
export function hasCiWorkflows(root: string, ref?: string): boolean {
  const isWorkflow = (n: string) => /\.ya?ml$/.test(n);
  if (ref) {
    const ls = git(root, ['ls-tree', '--name-only', ref, '.github/workflows/'], { allowFail: true });
    if (ls.ok) return ls.stdout.split('\n').some((n) => isWorkflow(n.trim()));
  }
  const dir = path.join(root, '.github', 'workflows');
  if (!exists(dir)) return false;
  try {
    return fs.readdirSync(dir).some(isWorkflow);
  } catch {
    return false;
  }
}

/** One PR as a merge decides on it: what this call's sync read, plus what forge pr open pushed. */
interface MergeTarget {
  repo: string | null;
  number: number;
  /** Only read once a gh merge call is due, as before linked jobs. */
  slug: () => string;
  state: string | null | undefined;
  checks: PrChecks['state'] | undefined;
  mergeState: string | null;
  headOid: string | null;
  pushedSha: string | null;
  /** Whether the PR's base has workflows, asked only when the checks rollup is empty. */
  hasWorkflows: () => boolean;
}

const prLabel = (repo: string | null, number: number | null): string => (repo === null ? `PR #${number ?? '?'}` : number === null ? `repo ${repo} (no PR)` : `repo ${repo} PR #${number}`);

/**
 * One PR's merge policy: direct when checks pass (or its repo has no CI), queued with `--auto` while
 * pending if GitHub enforces requirements, deferred (no call) while pending if it does not, refused
 * when failing. Exactly one `gh pr merge` call, never a fallback between direct and `--auto`,
 * because a fallback is how unverified code got merged. `tag` goes on every event (repo, target).
 */
function mergeOne(root: string, config: Config, id: string, t: MergeTarget, opts: { now: boolean; tag: Record<string, unknown> }): MergeResult {
  const { number, checks, tag } = { ...t, tag: opts.tag };
  const label = prLabel(t.repo, number);
  if (t.state === 'MERGED') return { merged: true, action: 'already-merged', checks };
  if (t.state === 'CLOSED') throw new ForgeError(`${label} is closed; reopen it before merging`);
  const now = opts.now;
  // forge pr open checked protected paths on the head it pushed. A head pushed since, by plain git
  // or a stale session, was never checked, so only a human's --now merges it unless pr open runs again.
  const head = t.headOid;
  const pushed = t.pushedSha;
  if (!now && policyRules(config).length && (head === null || head !== pushed)) {
    logEvent(root, id, 'pr-merge-refused', { ...tag, number, checks, head, pushedSha: pushed, reason: 'protected' });
    throw new ForgeError(
      `${label}'s head ${String(head ?? 'unknown').slice(0, 12)} is not the commit forge pr open checked for protected paths (${String(pushed ?? 'none').slice(0, 12)}); run: forge pr open ${id}, or merge with --now`,
      'protected_path',
    );
  }
  const hasWorkflows = checks === 'none' ? t.hasWorkflows() : false;
  const mergeState = t.mergeState;
  const decided = mergeAction(checks, { hasWorkflows, now, mergeState });
  // Once --auto is queued, GitHub merges on its own, and whether it still holds
  // --match-head-commit then is not documented. Under a protected-paths policy Forge waits instead,
  // so the merge that lands goes through the head check above (sync surfaces it for retry).
  const held = decided === 'auto' && policyRules(config).length > 0;
  const action = held ? 'defer' : decided;
  if (action === 'defer') {
    logEvent(root, id, 'pr-merge-deferred', { ...tag, number, checks, mergeState, ...(held ? { reason: 'protected' } : {}) });
    return { merged: false, autoMerge: false, action: 'deferred', checks, mergeState };
  }
  if (action === 'refuse') {
    logEvent(root, id, 'pr-merge-refused', { ...tag, number, checks });
    return { merged: false, autoMerge: false, action: 'refused', checks, error: 'CI is failing; fix it or pass --now to merge anyway' };
  }
  const slug = t.slug();
  // --now is a person's call, so every event it writes says who; without it the approver's
  // auto-merge is not a human action and records no actor.
  const by = now ? { actor: currentActor(root) } : {};
  // Logged before the call so a human override is on record even if the merge then fails.
  if (now) logEvent(root, id, 'pr-merge-bypass', { ...tag, number, checks, ...by });
  // matchHead pins the commit whose checks were just read, so a push after the sync cannot ride along.
  const res = submitMerge(root, slug, number, { method: config.merge.method, auto: action === 'auto', matchHead: t.headOid });
  if (!res.ok) {
    const error = (res.stderr || res.stdout).trim();
    logEvent(root, id, 'pr-merge-failed', { ...tag, number, error, ...by });
    return { merged: false, autoMerge: false, action: 'failed', checks, error };
  }
  if (action === 'auto') {
    logEvent(root, id, 'pr-auto-merge', { ...tag, number, checks, ...by });
    return { merged: false, autoMerge: true, action: 'auto', checks };
  }
  logEvent(root, id, 'pr-merged', { ...tag, number, method: config.merge.method, checks, bypass: now && checks !== 'passing', ...by });
  return { merged: true, autoMerge: false, action: 'merged', checks };
}

/**
 * Merges only once CI allows it (mergeOne). A linked job's PRs merge in the order of the
 * components' dependsOn (lib/engine/project/repo-order.ts): a PR is merged, or queued with `--auto`, only when
 * every dependency's PR is MERGED by this call's own sync, so a consumer never lands first and a
 * hand-edited job.json state counts for nothing. `repo` (a member) or `root` merges only that PR.
 */
export function mergePr(root: string, config: Config, id: string, opts: { now?: boolean; repo?: string; root?: boolean } = {}): MergeResult {
  requireGh();
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
  if (isLinkedJob(job)) return mergeLinked(root, config, id, { now, target: opts.repo !== undefined ? opts.repo : opts.root ? null : undefined });
  // A merge never routes: a conflicting PR parks as before, and the next forge sync routes it.
  const { pr: synced } = syncPr(root, config, id, { route: false });
  const number = synced?.number ?? job.pr.number;
  const checks = synced?.checks?.state;
  if (synced?.state === 'MERGED') return { merged: true, action: 'already-merged', checks };
  return mergeOne(root, config, id, rootTarget(root, config, id, number, synced), { now, tag: {} });
}

function rootTarget(root: string, config: Config, id: string, number: number, synced: JobPr | null): MergeTarget {
  const job = loadJob(root, id);
  return {
    repo: null,
    number,
    slug: () => repoSlug(root, config),
    state: synced?.state,
    checks: synced?.checks?.state,
    mergeState: synced?.mergeState ?? null,
    headOid: synced?.headOid ?? null,
    pushedSha: job.pr?.pushedSha ?? null,
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
    pushedSha: entry?.pr?.pushedSha ?? null,
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
function mergeLinked(root: string, config: Config, id: string, opts: { now: boolean; target: RepoKey | undefined }): MergeResult {
  const { result, members } = syncPrDetailed(root, config, id, { route: false });
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
  let reason: 'order' | 'cycle' | 'release' | undefined;
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
    const t = k === null ? rootTarget(root, config, id, rootNumber, synced) : memberTarget(root, config, job, members.get(k)!);
    const r = mergeOne(root, config, id, t, { now: opts.now, tag: tag(k) });
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
export function readyPr(root: string, config: Config, id: string, target: { repo?: string; root?: true } = {}): ReadyResult {
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
  requireGh();
  for (const { repo, number } of pending) {
    let slug: string;
    if (repo === null) slug = repoSlug(root, config);
    else {
      slug = memberSlug(config, repo);
      if (!SLUG_RE.test(slug)) throw new ForgeError(`repo ${repo} has an unusable GitHub repository ${JSON.stringify(slug).slice(0, 80)}`);
    }
    markPrReady(root, slug, number);
    if (repo === null) setJob(root, id, { owned: { 'pr.isDraft': false } });
    else recordMemberPr(root, id, repo, (prev) => ({ ...(prev ?? {}), isDraft: false }) as JobRepoPr);
    logEvent(root, id, 'pr-ready', { ...(repo !== null ? { repo } : {}), number });
    out.ready.push({ repo, number });
  }
  return out;
}
