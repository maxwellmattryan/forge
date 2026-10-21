// Per-job budgets. Limits come from config at every check (so raising `pipeline.budget` raises
// it for every job) with per-job overrides on top. Checkpoints park an over-budget job at
// waiting:budget; only a human raises or acknowledges it, and the orchestrator resumes it.
import { configForJob } from './eval-overlay.ts';
import { loadJob, logEvent, logHumanEvent, setJob, updateJob } from './jobs.ts';
import { exists } from './paths.ts';
import { BUDGET_KEYS } from './schema.ts';
import type { BudgetKey, BudgetLimits, BudgetUsed, Config, DaemonJobBudget, Job, JobBudget } from './types.ts';
import { ForgeError, now, run } from './util.ts';

const TERMINAL = ['done', 'cancelled', 'failed'];

/** A key over its limit: exceededKeys. */
export interface BudgetExceeded {
  key: BudgetKey;
  used: number;
  limit: number;
}

/** The limits daemon.jobBudget can fill: the spend keys. */
export const SPEND_KEYS = ['tokens', 'usd', 'minutes'] as const;

/** daemon.jobBudget with every key a finite number >= 0 or null, or null when it is off or not a map. */
export function jobBudgetOf(config: Config): DaemonJobBudget {
  const b: unknown = config?.daemon?.jobBudget;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  const v = (k: string) => {
    const n = (b as Record<string, unknown>)[k];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  return { tokens: v('tokens'), usd: v('usd'), minutes: v('minutes') };
}

/**
 * pipeline.budget with the job's overrides on top. With the daemon on, a job whose limits set no
 * spend key (none non-null in config, none present in its own overrides) gets daemon.jobBudget's
 * non-null keys, so an unattended job never loops without a spend ceiling. Every budget check, the
 * supervisor's hold and the dashboard (dashboard/src/lib/budget.ts) read limits through this rule.
 */
export function effectiveLimits(config: Config, job: Pick<Job, 'budget'>): BudgetLimits {
  const own = job.budget?.limits ?? {};
  const merged: Record<string, number | null | undefined> = { ...(config?.pipeline?.budget ?? {}), ...own };
  const limits = Object.fromEntries(BUDGET_KEYS.map((k) => [k, merged[k] ?? null])) as BudgetLimits;
  const fill = config?.daemon?.enabled === true ? jobBudgetOf(config) : null;
  if (fill && SPEND_KEYS.every((k) => limits[k] === null && !Object.hasOwn(own, k))) {
    for (const k of SPEND_KEYS) if (fill[k] !== null && fill[k] !== undefined) limits[k] = fill[k];
  }
  return limits;
}

/**
 * What the job has spent. `null` means unmeasured and never trips.
 */
export function measureBudget(job: Job): BudgetUsed {
  // byModel holds the same runs as byRole, so summing both would double-count.
  const ms = Object.values(job.usage?.byRole ?? {}).reduce((n, r) => n + (Number(r?.durationMs) || 0), 0);
  return {
    tokens: job.usage?.totalTokens ?? 0,
    usd: job.usage?.estCostUsd ?? 0,
    minutes: Math.round((ms / 60000) * 10000) / 10000,
    changedLines: changedLines(job),
    verifyRetries: job.verifyRetries?.[String(job.round)] ?? 0,
  };
}

/** Committed lines added + deleted against the base. */
function changedLines(job: Job): number | null {
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
 */
export function exceededKeys(limits: BudgetLimits, used: Partial<BudgetUsed>, ack: JobBudget['ack'] | undefined, round: number): BudgetExceeded[] {
  const out: BudgetExceeded[] = [];
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

const fmt = (key: string, v: number): string => (key === 'usd' ? v.toFixed(2) : key === 'minutes' ? v.toFixed(1) : String(Math.round(v)));

export function formatReason(exceeded: BudgetExceeded[]): string {
  return `budget exceeded: ${exceeded.map((e) => `${e.key} ${fmt(e.key, e.used)}/${fmt(e.key, e.limit)}`).join(', ')}`;
}

/**
 * A checkpoint: records `lastCheck`, and parks the job at waiting:budget when a key is over.
 * Returns the block the command adds to its output, or null when there is nothing to report.
 */
export function enforceBudget(
  root: string,
  config: Config,
  id: string,
  checkpoint: string,
): { stopped: true; reason: string; exceeded: BudgetExceeded[] } | null {
  const job = loadJob(root, id);
  const used = measureBudget(job);
  const exceeded = exceededKeys(effectiveLimits(configForJob(root, config, job), job), used, job.budget.ack, job.round);
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

/** An undefined value removes the override. */
function parseSet(kv: string): [BudgetKey, number | null | undefined] {
  const allowed = `allowed keys: ${BUDGET_KEYS.join(', ')}; values: a non-negative number, null or default`;
  const eq = kv.indexOf('=');
  // Checked against BUDGET_KEYS below, before it is returned.
  const key = (eq > 0 ? kv.slice(0, eq).trim() : '') as BudgetKey;
  const raw = eq > 0 ? kv.slice(eq + 1).trim() : '';
  if (!(BUDGET_KEYS as readonly string[]).includes(key)) throw new ForgeError(`unknown budget key in "${kv}" (${allowed})`);
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
 */
export function budgetCmd(
  root: string,
  config: Config,
  id: string,
  opts: { set?: string[]; ack?: boolean } = {},
): { id: string; limits: BudgetLimits; used: BudgetUsed; exceeded: BudgetKey[]; ack: JobBudget['ack']; acked: BudgetKey[]; stillExceeded: BudgetKey[] } {
  const sets = (opts.set ?? []).map(parseSet);
  if (sets.length) {
    updateJob(root, id, (j) => {
      for (const [k, v] of sets) {
        if (v === undefined) delete j.budget.limits[k];
        else j.budget.limits[k] = v;
      }
    });
    for (const [key, value] of sets) logHumanEvent(root, id, 'budget-set', { key, value: value === undefined ? 'default' : value });
  }
  const job = loadJob(root, id);
  const limits = effectiveLimits(configForJob(root, config, job), job);
  const used = measureBudget(job);
  const exceeded = exceededKeys(limits, used, job.budget.ack, job.round);
  const acked = opts.ack ? exceeded.map((e) => e.key) : [];
  const saved = updateJob(root, id, (j) => {
    for (const e of opts.ack ? exceeded : []) j.budget.ack[e.key] = { used: e.used, round: j.round };
    j.budget.lastCheck = { at: now(), checkpoint: 'budget', used };
  });
  if (acked.length) logHumanEvent(root, id, 'budget-ack', { keys: acked, used: Object.fromEntries(exceeded.map((e) => [e.key, e.used])) });
  const still = exceededKeys(limits, used, saved.budget.ack, saved.round).map((e) => e.key);
  return { id: saved.id, limits, used, exceeded: exceeded.map((e) => e.key), ack: saved.budget.ack, acked, stillExceeded: still };
}
