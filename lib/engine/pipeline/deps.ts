// Dependencies between jobs (`job.dependsOn`): validation, parking, claim refusal, stacked
// branches and retargeting. Imports only jobs/paths/util/git and archive.ts (which imports no more):
// worktree.ts imports this module, and lib/engine/pr/ imports worktree.ts, so anything more would be a cycle.
import path from 'node:path';
import { readArchived } from '#core/job/archive.ts';
import { git } from '#integrations/git/runner.ts';
import { claimJob, isActive, jobDir, listJobs, loadJob, logEvent, setJob } from '#core/job/store.ts';
import type { ClaimOpts } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import type { Config, Job, LoadedJob } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';

export const DEP_REASON = 'dependencies not done: ';

/** A dependency that blocks a job: unmetDependencies. `state` is 'missing' when its job.json is gone. */
export interface UnmetDependency {
  id: string;
  stage: string | null;
  state: string;
}

/** Hand-edited job.json can hold anything; only string ids count. */
const depIds = (job: Job): string[] => (Array.isArray(job?.dependsOn) ? job.dependsOn.filter((d: unknown) => typeof d === 'string' && d) : []);

/** The live job, else its archive record's job (an archived dependency counts with its archived state). */
function tryLoad(root: string, id: string): LoadedJob | null {
  try {
    return loadJob(root, id);
  } catch {
    return readArchived(root, id)?.job ?? null;
  }
}

function jobExists(root: string, id: string): boolean {
  try {
    return exists(path.join(jobDir(root, id), 'job.json'));
  } catch {
    return false;
  }
}

/**
 * Dependencies whose job is not `done`, in `dependsOn` order. `cancelled` blocks too: a human
 * removes the dependency or forces the claim.
 */
export function unmetDependencies(root: string, job: Job): UnmetDependency[] {
  const unmet: UnmetDependency[] = [];
  for (const id of depIds(job)) {
    const dep = tryLoad(root, id);
    if (!dep) unmet.push({ id, stage: null, state: 'missing' });
    else if (dep.state !== 'done') unmet.push({ id, stage: dep.stage, state: dep.state });
  }
  return unmet;
}

const describe = (unmet: UnmetDependency[]): string => unmet.map((u) => (u.state === 'missing' ? `${u.id} (missing)` : `${u.id} (${u.stage}/${u.state})`)).join(', ');

const isParked = (job: Job): boolean => job.state === 'waiting' && job.waitingOn === 'external' && String(job.reason ?? '').startsWith(DEP_REASON);

export function validateDependsOn(root: string, id: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) throw new ForgeError('dependsOn must be a JSON array of job ids, e.g. dependsOn=["a","b"]');
  const ids = [...new Set(value as string[])];
  if (ids.includes(id)) throw new ForgeError(`job ${id} cannot depend on itself`);
  const unknown = ids.filter((d) => !jobExists(root, d));
  if (unknown.length) throw new ForgeError(`unknown job id(s) in dependsOn: ${unknown.join(', ')}`);
  const graph = new Map<string, string[]>(listJobs(root).map((j) => [j.id, depIds(j)]));
  graph.set(id, ids);
  // Every cycle this write can create passes through `id`, so a search from it is enough.
  const seen = new Set<string>();
  const back = (node: string, trail: string[]): string[] | null => {
    for (const next of graph.get(node) ?? []) {
      if (next === id) return [...trail, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = back(next, [...trail, next]);
      if (found) return found;
    }
    return null;
  };
  const cycle = back(id, [id]);
  if (cycle) throw new ForgeError(`dependsOn would create a cycle: ${cycle.join(' → ')}`);
  return ids;
}

/**
 * Parks a queued job behind its unmet dependencies (releasing its owner), rewrites the reason of
 * an already parked one, and unparks a parked job once they are all done (`released` in the
 * result means unparked, not an owner release). Other waits (spec approval, input…)
 * are never overwritten.
 */
export function refreshDependencyWait(root: string, id: string): { unmet: UnmetDependency[]; parked: boolean; released: boolean } {
  const job = loadJob(root, id);
  const unmet = unmetDependencies(root, job);
  const parked = isParked(job);
  if (unmet.length && (job.state === 'queued' || parked)) {
    const reason = DEP_REASON + describe(unmet);
    // Parking releases the owner: nobody drives a parked job. A rewrite keeps it, so a --force
    // claim on a parked job survives sync.
    const wait = { state: 'waiting', waitingOn: 'external', reason };
    if (!parked) setJob(root, id, { ...wait, release: true });
    else if (job.reason !== reason) setJob(root, id, wait);
    return { unmet, parked: true, released: false };
  }
  if (!unmet.length && parked) {
    setJob(root, id, { state: 'queued', waitingOn: null, reason: null });
    return { unmet, parked: false, released: true };
  }
  return { unmet, parked, released: false };
}

/**
 * The dependency check runs before the ownership check, so a blocked job reports that first.
 * `force` overrides both.
 */
export function claimRespectingDeps(root: string, id: string, session: string, force: boolean, opts: ClaimOpts = {}): { job: LoadedJob; overridden: string[] } {
  const unmet = unmetDependencies(root, loadJob(root, id));
  if (unmet.length && !force) {
    refreshDependencyWait(root, id);
    throw new ForgeError(`job ${id} waits on dependencies not done: ${describe(unmet)}; pass --force to claim anyway`, 4);
  }
  const claimed = claimJob(root, id, session, force, opts);
  if (unmet.length) {
    const ids = unmet.map((u) => u.id);
    logEvent(root, id, 'dependencies-overridden', { unmet: ids, ...(opts.actor ? { actor: opts.actor } : {}) });
    return { job: claimed, overridden: ids };
  }
  return { job: refreshDependencyWait(root, id).released ? loadJob(root, id) : claimed, overridden: [] };
}

/** `<remote>/<name>` when the remote-tracking ref exists, else the local name. */
export function baseRef(root: string, config: Config, name: string): string {
  return refExists(root, `refs/remotes/${config.git.remote}/${name}`) ? `${config.git.remote}/${name}` : name;
}

const refExists = (root: string, ref: string): boolean => git(root, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true }).ok;

/** The dependency's branch as a ref (remote first), or null when it exists nowhere. */
function depBranchRef(root: string, config: Config, dep: Job): string | null {
  if (!dep.branch) return null;
  if (refExists(root, `refs/remotes/${config.git.remote}/${dep.branch}`)) return `${config.git.remote}/${dep.branch}`;
  if (refExists(root, `refs/heads/${dep.branch}`)) return dep.branch;
  return null;
}

/**
 * A dependency is merged when its PR merged, when its branch is already in `base`, or when its
 * branch is gone and the job is done (a merged branch deleted after cleanup).
 * `base` is a ref such as `origin/main`.
 */
export function isMerged(root: string, config: Config, dep: Job, base: string): boolean {
  if (dep.pr?.state === 'MERGED') return true;
  const ref = depBranchRef(root, config, dep);
  if (ref) return git(root, ['merge-base', '--is-ancestor', ref, base], { allowFail: true }).ok;
  return dep.state === 'done';
}

/**
 * Where a new branch for `job` starts: null for the usual base, or the one unmerged
 * dependency's branch to stack on.
 */
export function stackSource(root: string, config: Config, job: Job): { dependency: string; start: string; base: string } | null {
  const deps = depIds(job).map((d) => {
    const dep = tryLoad(root, d);
    if (!dep) throw new ForgeError(`dependency ${d} not found`);
    return dep;
  });
  if (!deps.length) return null;
  // createJob always sets base.
  const base = baseRef(root, config, job.base!);
  const unmerged = deps.filter((d) => !isMerged(root, config, d, base));
  if (!unmerged.length) return null;
  if (unmerged.length > 1) throw new ForgeError(`job ${job.id} depends on more than one unmerged job (${unmerged.map((d) => d.id).join(', ')}); wait until at most one is unmerged`);
  const dep = unmerged[0];
  const start = depBranchRef(root, config, dep);
  if (!start) throw new ForgeError(`dependency ${dep.id} has no branch yet (${dep.branch}); create its worktree first`);
  // depBranchRef found a ref, so the dependency has a branch.
  return { dependency: dep.id, start, base: dep.branch! };
}

/**
 * Stacked jobs (base = a dependency's branch) whose dependency has merged, with the base they
 * move back to: the dependency's own base, else the repo base.
 */
export function retargetPlan(root: string, config: Config): { id: string; from: string; to: string; dependency: string }[] {
  const candidates: { job: LoadedJob; dep: LoadedJob }[] = [];
  for (const job of listJobs(root).filter((j) => isActive(j) && j.kind !== 'eval' && j.base)) {
    for (const d of depIds(job)) {
      const dep = tryLoad(root, d);
      if (dep && dep.branch && dep.branch === job.base) candidates.push({ job, dep });
    }
  }
  if (!candidates.length) return [];
  git(root, ['fetch', config.git.remote, '--prune'], { allowFail: true, write: true });
  const plan: { id: string; from: string; to: string; dependency: string }[] = [];
  for (const { job, dep } of candidates) {
    const to = dep.base && dep.base !== job.base ? dep.base : config.git.base;
    if (to === job.base) continue;
    if (isMerged(root, config, dep, baseRef(root, config, to))) plan.push({ id: job.id, from: job.base!, to, dependency: dep.id }); // candidates all have a base
  }
  return plan;
}
