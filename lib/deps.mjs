// @ts-check
// Dependencies between jobs (`job.dependsOn`): validation, parking, claim refusal, stacked
// branches and retargeting. Imports only jobs/paths/util: worktree.mjs imports this module,
// and pr.mjs imports worktree.mjs, so anything more would be a cycle.
import path from 'node:path';
import { claimJob, isActive, jobDir, listJobs, loadJob, logEvent, setJob } from './jobs.mjs';
import { exists } from './paths.mjs';
import { ForgeError, run } from './util.mjs';

export const DEP_REASON = 'dependencies not done: ';

/** Hand-edited job.json can hold anything; only string ids count. @param {any} job @returns {string[]} */
const depIds = (job) => (Array.isArray(job?.dependsOn) ? job.dependsOn.filter((/** @type {unknown} */ d) => typeof d === 'string' && d) : []);

/** @param {string} root @param {string} id */
function tryLoad(root, id) {
  try {
    return loadJob(root, id);
  } catch {
    return null;
  }
}

/** @param {string} root @param {string} id */
function jobExists(root, id) {
  try {
    return exists(path.join(jobDir(root, id), 'job.json'));
  } catch {
    return false;
  }
}

/**
 * Dependencies whose job is not `done`, in `dependsOn` order. `cancelled` blocks too: a human
 * removes the dependency or forces the claim.
 * @param {string} root @param {any} job @returns {{id:string, stage:string|null, state:string}[]}
 */
export function unmetDependencies(root, job) {
  /** @type {{id:string, stage:string|null, state:string}[]} */
  const unmet = [];
  for (const id of depIds(job)) {
    const dep = tryLoad(root, id);
    if (!dep) unmet.push({ id, stage: null, state: 'missing' });
    else if (dep.state !== 'done') unmet.push({ id, stage: dep.stage, state: dep.state });
  }
  return unmet;
}

/** @param {{id:string, stage:string|null, state:string}[]} unmet */
const describe = (unmet) => unmet.map((u) => (u.state === 'missing' ? `${u.id} (missing)` : `${u.id} (${u.stage}/${u.state})`)).join(', ');

/** @param {any} job */
const isParked = (job) => job.state === 'waiting' && job.waitingOn === 'external' && String(job.reason ?? '').startsWith(DEP_REASON);

/**
 * @param {string} root @param {string} id @param {unknown} value
 * @returns {string[]}
 */
export function validateDependsOn(root, id, value) {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !v)) throw new ForgeError('dependsOn must be a JSON array of job ids, e.g. dependsOn=["a","b"]');
  const ids = [...new Set(/** @type {string[]} */ (value))];
  if (ids.includes(id)) throw new ForgeError(`job ${id} cannot depend on itself`);
  const unknown = ids.filter((d) => !jobExists(root, d));
  if (unknown.length) throw new ForgeError(`unknown job id(s) in dependsOn: ${unknown.join(', ')}`);
  /** @type {Map<string, string[]>} */
  const graph = new Map(listJobs(root).map((j) => [j.id, depIds(j)]));
  graph.set(id, ids);
  // Every cycle this write can create passes through `id`, so a search from it is enough.
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {string} node @param {string[]} trail @returns {string[]|null} */
  const back = (node, trail) => {
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
 * Parks a queued job behind its unmet dependencies, rewrites the reason of an already parked
 * one, and releases a parked job once they are all done. Other waits (spec approval, input…)
 * are never overwritten.
 * @param {string} root @param {string} id
 */
export function refreshDependencyWait(root, id) {
  const job = loadJob(root, id);
  const unmet = unmetDependencies(root, job);
  const parked = isParked(job);
  if (unmet.length && (job.state === 'queued' || parked)) {
    const reason = DEP_REASON + describe(unmet);
    if (!parked || job.reason !== reason) setJob(root, id, { state: 'waiting', waitingOn: 'external', reason });
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
 * @param {string} root @param {string} id @param {string} session @param {boolean} force
 * @returns {{job:any, overridden:string[]}}
 */
export function claimRespectingDeps(root, id, session, force) {
  const unmet = unmetDependencies(root, loadJob(root, id));
  if (unmet.length && !force) {
    refreshDependencyWait(root, id);
    throw new ForgeError(`job ${id} waits on dependencies not done: ${describe(unmet)}; pass --force to claim anyway`, 4);
  }
  const claimed = claimJob(root, id, session, force);
  if (unmet.length) {
    const ids = unmet.map((u) => u.id);
    logEvent(root, id, 'dependencies-overridden', { unmet: ids });
    return { job: claimed, overridden: ids };
  }
  return { job: refreshDependencyWait(root, id).released ? loadJob(root, id) : claimed, overridden: [] };
}

/** `<remote>/<name>` when the remote-tracking ref exists, else the local name. @param {string} root @param {any} config @param {string} name */
export function baseRef(root, config, name) {
  return refExists(root, `refs/remotes/${config.git.remote}/${name}`) ? `${config.git.remote}/${name}` : name;
}

/** @param {string} root @param {string} ref */
const refExists = (root, ref) => run('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root, allowFail: true }).ok;

/** The dependency's branch as a ref (remote first), or null when it exists nowhere. @param {string} root @param {any} config @param {any} dep */
function depBranchRef(root, config, dep) {
  if (!dep.branch) return null;
  if (refExists(root, `refs/remotes/${config.git.remote}/${dep.branch}`)) return `${config.git.remote}/${dep.branch}`;
  if (refExists(root, `refs/heads/${dep.branch}`)) return dep.branch;
  return null;
}

/**
 * A dependency is merged when its PR merged, when its branch is already in `base`, or when its
 * branch is gone and the job is done (a merged branch deleted after cleanup).
 * @param {string} root @param {any} config @param {any} dep @param {string} base a ref such as `origin/main`
 */
export function isMerged(root, config, dep, base) {
  if (dep.pr?.state === 'MERGED') return true;
  const ref = depBranchRef(root, config, dep);
  if (ref) return run('git', ['merge-base', '--is-ancestor', ref, base], { cwd: root, allowFail: true }).ok;
  return dep.state === 'done';
}

/**
 * Where a new branch for `job` starts: null for the usual base, or the one unmerged
 * dependency's branch to stack on.
 * @param {string} root @param {any} config @param {any} job
 * @returns {{dependency:string, start:string, base:string}|null}
 */
export function stackSource(root, config, job) {
  const deps = depIds(job).map((d) => {
    const dep = tryLoad(root, d);
    if (!dep) throw new ForgeError(`dependency ${d} not found`);
    return dep;
  });
  if (!deps.length) return null;
  const base = baseRef(root, config, job.base);
  const unmerged = deps.filter((d) => !isMerged(root, config, d, base));
  if (!unmerged.length) return null;
  if (unmerged.length > 1) throw new ForgeError(`job ${job.id} depends on more than one unmerged job (${unmerged.map((d) => d.id).join(', ')}); wait until at most one is unmerged`);
  const dep = unmerged[0];
  const start = depBranchRef(root, config, dep);
  if (!start) throw new ForgeError(`dependency ${dep.id} has no branch yet (${dep.branch}); create its worktree first`);
  return { dependency: dep.id, start, base: dep.branch };
}

/**
 * Stacked jobs (base = a dependency's branch) whose dependency has merged, with the base they
 * move back to: the dependency's own base, else the repo base.
 * @param {string} root @param {any} config
 * @returns {{id:string, from:string, to:string, dependency:string}[]}
 */
export function retargetPlan(root, config) {
  const candidates = [];
  for (const job of listJobs(root).filter((j) => isActive(j) && j.kind !== 'eval' && j.base)) {
    for (const d of depIds(job)) {
      const dep = tryLoad(root, d);
      if (dep && dep.branch && dep.branch === job.base) candidates.push({ job, dep });
    }
  }
  if (!candidates.length) return [];
  run('git', ['fetch', config.git.remote, '--prune'], { cwd: root, allowFail: true });
  const plan = [];
  for (const { job, dep } of candidates) {
    const to = dep.base && dep.base !== job.base ? dep.base : config.git.base;
    if (to === job.base) continue;
    if (isMerged(root, config, dep, baseRef(root, config, to))) plan.push({ id: job.id, from: job.base, to, dependency: dep.id });
  }
  return plan;
}
