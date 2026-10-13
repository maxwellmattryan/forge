// Per-job budgets. Limits come from config at every check (so raising `pipeline.budget` raises
// it for every job) with per-job overrides on top. Checkpoints park an over-budget job at
// waiting:budget; only a human raises or acknowledges it, and the orchestrator resumes it.
import { loadJob, logEvent, setJob, updateJob } from './jobs.ts';
import { exists } from './paths.ts';
import { BUDGET_KEYS } from './schema.ts';
import { ForgeError, now, run } from './util.ts';

const TERMINAL = ['done', 'cancelled', 'failed'];

/** @param {any} config @param {any} job @returns {Record<string, number|null>} */
export function effectiveLimits(config, job) {
  const merged = { ...(config?.pipeline?.budget ?? {}), ...(job.budget?.limits ?? {}) };
  return Object.fromEntries(BUDGET_KEYS.map((k) => [k, merged[k] ?? null]));
}

/**
 * What the job has spent. `null` means unmeasured and never trips.
 * @param {any} job @returns {Record<string, number|null>}
 */
export function measureBudget(job) {
  // byModel holds the same runs as byRole, so summing both would double-count.
  const ms = Object.values(job.usage?.byRole ?? {}).reduce((n, /** @type {any} */ r) => n + (Number(r?.durationMs) || 0), 0);
  return {
    tokens: job.usage?.totalTokens ?? 0,
    usd: job.usage?.estCostUsd ?? 0,
    minutes: Math.round((ms / 60000) * 10000) / 10000,
    changedLines: changedLines(job),
    verifyRetries: job.verifyRetries?.[String(job.round)] ?? 0,
  };
}

/** Committed lines added + deleted against the base. @param {any} job @returns {number|null} */
function changedLines(job) {
  if (!job.worktree || !job.base || !exists(job.worktree)) return null;
  const r = run('git', ['diff', '--numstat', `${job.base}...HEAD`], { cwd: job.worktree, allowFail: true });
  if (!r.ok) return null;
  let n = 0;
  for (const line of r.stdout.split('\n')) {
    const [add, del] = line.split('\t');
    // Binary files show "-" and count as 0.
    n += (Number(add) || 0) + (Number(del) || 0);
  }
  return n;
}

/**
 * An acknowledged key trips again only after another full budget past the acknowledged point;
 * a verifyRetries ack belongs to its round.
 * @param {Record<string, number|null>} limits @param {Record<string, number|null>} used
 * @param {Record<string, {used:number, round:number}>} ack @param {number} round
 * @returns {{key:string, used:number, limit:number}[]}
 */
export function exceededKeys(limits, used, ack, round) {
  const out = [];
  for (const key of BUDGET_KEYS) {
    const limit = limits[key];
    const u = used[key];
    if (limit === null || limit === undefined || u === null || u === undefined) continue;
    const a = ack?.[key];
    const base = a && (key !== 'verifyRetries' || a.round === round) ? Number(a.used) || 0 : 0;
    if (u - base > limit) out.push({ key, used: u, limit });
  }
  return out;
}

/** @param {string} key @param {number} v */
const fmt = (key, v) => (key === 'usd' ? v.toFixed(2) : key === 'minutes' ? v.toFixed(1) : String(Math.round(v)));

/** @param {{key:string, used:number, limit:number}[]} exceeded */
export function formatReason(exceeded) {
  return `budget exceeded: ${exceeded.map((e) => `${e.key} ${fmt(e.key, e.used)}/${fmt(e.key, e.limit)}`).join(', ')}`;
}

/**
 * A checkpoint: records `lastCheck`, and parks the job at waiting:budget when a key is over.
 * Returns the block the command adds to its output, or null when there is nothing to report.
 * @param {string} root @param {any} config @param {string} id @param {string} checkpoint
 * @returns {{stopped:true, reason:string, exceeded:{key:string, used:number, limit:number}[]}|null}
 */
export function enforceBudget(root, config, id, checkpoint) {
  const job = loadJob(root, id);
  const used = measureBudget(job);
  const exceeded = exceededKeys(effectiveLimits(config, job), used, job.budget.ack, job.round);
  let state = job.state;
  let waitingOn = job.waitingOn;
  updateJob(root, id, (j) => {
    j.budget.lastCheck = { at: now(), checkpoint, used };
    state = j.state;
    waitingOn = j.waitingOn;
  });
  if (TERMINAL.includes(state) || !exceeded.length) return null;
  const reason = formatReason(exceeded);
  // A parallel reviewer finishing after the stop still reports it, without a second transition.
  if (!(state === 'waiting' && waitingOn === 'budget')) {
    setJob(root, id, { state: 'waiting', waitingOn: 'budget', reason });
    logEvent(root, id, 'budget', { checkpoint, exceeded });
  }
  return { stopped: true, reason, exceeded };
}

/** @param {string} kv @returns {[string, number|null|undefined]} undefined removes the override */
function parseSet(kv) {
  const allowed = `allowed keys: ${BUDGET_KEYS.join(', ')}; values: a non-negative number, null or default`;
  const eq = kv.indexOf('=');
  const key = eq > 0 ? kv.slice(0, eq).trim() : '';
  const raw = eq > 0 ? kv.slice(eq + 1).trim() : '';
  if (!(/** @type {readonly string[]} */ (BUDGET_KEYS).includes(key))) throw new ForgeError(`unknown budget key in "${kv}" (${allowed})`);
  if (raw === 'default') return [key, undefined];
  if (raw === 'null') return [key, null];
  const n = raw === '' ? NaN : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new ForgeError(`bad budget value in "${kv}" (${allowed})`);
  if (key === 'verifyRetries' && !Number.isInteger(n)) throw new ForgeError(`verifyRetries must be a non-negative integer, got "${raw}" (${allowed})`);
  return [key, n];
}

/**
 * `forge job budget <id> [--set k=v …] [--ack]`. Never changes state: the orchestrator resumes
 * the job so every transition stays visible through the normal loop.
 * @param {string} root @param {any} config @param {string} id @param {{set?:string[], ack?:boolean}} opts
 */
export function budgetCmd(root, config, id, opts = {}) {
  const sets = (opts.set ?? []).map(parseSet);
  if (sets.length) {
    updateJob(root, id, (j) => {
      for (const [k, v] of sets) {
        if (v === undefined) delete j.budget.limits[k];
        else j.budget.limits[k] = v;
      }
    });
    for (const [key, value] of sets) logEvent(root, id, 'budget-set', { key, value: value === undefined ? 'default' : value });
  }
  const job = loadJob(root, id);
  const limits = effectiveLimits(config, job);
  const used = measureBudget(job);
  const exceeded = exceededKeys(limits, used, job.budget.ack, job.round);
  const acked = opts.ack ? exceeded.map((e) => e.key) : [];
  const saved = updateJob(root, id, (j) => {
    for (const e of opts.ack ? exceeded : []) j.budget.ack[e.key] = { used: e.used, round: j.round };
    j.budget.lastCheck = { at: now(), checkpoint: 'budget', used };
  });
  if (acked.length) logEvent(root, id, 'budget-ack', { keys: acked, used: Object.fromEntries(exceeded.map((e) => [e.key, e.used])) });
  const still = exceededKeys(limits, used, saved.budget.ack, saved.round).map((e) => e.key);
  return { id: saved.id, limits, used, exceeded: exceeded.map((e) => e.key), ack: saved.budget.ack, acked, stillExceeded: still };
}
