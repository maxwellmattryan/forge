// The repo budget: caps on what the whole repo spends per UTC day and month (config `budget:`),
// separate from per-job budgets. The CLI checks it wherever a job starts (job new|claim|from-ref,
// next) and the daemon pool holds job sessions' requests while it is exceeded. Repo holds reuse
// waiting:budget, told apart from a per-job stop by the reason prefix; release re-checks the job's
// own budget, so rewriting a reason never frees a per-job stop. docs/CONFIG.md "Repo budget".
import fs from 'node:fs';
import { effectiveLimits, exceededKeys, measureJob } from './budget.ts';
import { configForJob } from '../evals/overlay.ts';
import { isActive, listJobs, loadJob, logEvent, logRepoEvent, parseEventLines, readEvents, repoAuditFile, setJob } from '#core/job/store.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { REPO_BUDGET_KEYS } from '#core/job/schema.ts';
import { periodTotals, spendLedger } from './spend.ts';
import type { Config, EventActor, Job, RepoBudgetConfig, RepoBudgetKey, RepoBudgetStatus } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { readText } from '#core/os/fs.ts';

const REPO_HOLD_PREFIX = 'repo budget:';
const RELEASE_REASON = 'repo budget released';
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_KEYS: readonly RepoBudgetKey[] = ['usdPerMonth', 'tokensPerMonth'];

/** Why an ack was refused: `period` (malformed or not current) or `within` (nothing exceeded). */
export class RepoBudgetAckError extends ForgeError {
  // `declare` keeps this a type only: a plain field would become a runtime class field.
  declare reason: 'period' | 'within';
  constructor(reason: 'period' | 'within', message: string, code: 'usage' | 'failed' = 'failed') {
    super(message, code);
    this.reason = reason;
  }
}

/** config.budget with every key present; a missing or malformed block reads as unlimited. */
function repoBudgetConfig(config: Config): RepoBudgetConfig {
  const b: Partial<RepoBudgetConfig> = config?.budget && typeof config.budget === 'object' ? config.budget : {};
  const usd = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  return {
    usdPerDay: usd(b.usdPerDay),
    usdPerMonth: usd(b.usdPerMonth),
    tokensPerMonth: usd(b.tokensPerMonth),
    onExceeded: b.onExceeded === 'warn' ? 'warn' : 'hold',
  };
}

/** Whether a period id is a well-formed, real calendar month or day. */
export function validPeriod(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  if (MONTH_RE.test(p)) return true;
  if (!DAY_RE.test(p)) return false;
  const t = Date.parse(`${p}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === p;
}

/** Acknowledged periods from .forge/runtime/audit.jsonl, as a count per period id. */
function ackCounts(root: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of parseEventLines(readText(repoAuditFile(root)))) {
    if (e.type !== 'repo-budget-ack' || typeof e.period !== 'string') continue;
    out.set(e.period, (out.get(e.period) ?? 0) + 1);
  }
  return out;
}

const money = (n: number): string => `$${n.toFixed(2)}`;

/** `repo budget: …`, one part per exceeded key in REPO_BUDGET_KEYS order. */
function formatRepoReason(exceeded: RepoBudgetKey[], spent: RepoBudgetStatus['spent'], caps: RepoBudgetStatus['caps']): string {
  const part = (k: RepoBudgetKey): string => {
    if (k === 'usdPerMonth') return `${money(spent.monthUsd)} of ${money(caps.usdPerMonth ?? 0)} this month`;
    if (k === 'tokensPerMonth') return `${Math.round(spent.monthTokens)} of ${Math.round(caps.tokensPerMonth ?? 0)} tokens this month`;
    return `${money(spent.dayUsd)} of ${money(caps.usdPerDay ?? 0)} today`;
  };
  return `${REPO_HOLD_PREFIX} ${exceeded.map(part).join(', ')}`;
}

/** Whether a job is parked by the repo budget (not by its own). */
export function isRepoHold(job: Pick<Job, 'state' | 'waitingOn' | 'reason'>): boolean {
  return job.state === 'waiting' && job.waitingOn === 'budget' && String(job.reason ?? '').startsWith(REPO_HOLD_PREFIX);
}

/** Repo spend against the caps. `write: false` (server, daemon pool) never writes the spend cache. */
export function repoBudgetStatus(root: string, config: Config, { at = Date.now(), write = true }: { at?: number; write?: boolean } = {}): RepoBudgetStatus {
  const b = repoBudgetConfig(config);
  const iso = new Date(at).toISOString();
  const day = iso.slice(0, 10);
  const month = iso.slice(0, 7);
  const spent = periodTotals(spendLedger(root, config, { write }), at);
  const counts = ackCounts(root);
  const acks = { day: counts.get(day) ?? 0, month: counts.get(month) ?? 0 };
  const configured = { usdPerMonth: b.usdPerMonth, tokensPerMonth: b.tokensPerMonth, usdPerDay: b.usdPerDay };
  const scale = (v: number | null, n: number) => (v === null ? null : v * (1 + n));
  const caps = { usdPerMonth: scale(b.usdPerMonth, acks.month), tokensPerMonth: scale(b.tokensPerMonth, acks.month), usdPerDay: scale(b.usdPerDay, acks.day) };
  const used: Record<RepoBudgetKey, number> = { usdPerMonth: spent.monthUsd, tokensPerMonth: spent.monthTokens, usdPerDay: spent.dayUsd };
  const remaining = Object.fromEntries(REPO_BUDGET_KEYS.map((k) => [k, caps[k] === null ? null : Math.round(Math.max(0, caps[k]! - used[k]) * 10000) / 10000])) as Record<RepoBudgetKey, number | null>;
  // Reaching the cap holds: it is a ceiling on starting more work, and a cap of 0 holds everything.
  const exceeded = REPO_BUDGET_KEYS.filter((k) => caps[k] !== null && used[k] >= caps[k]!);
  const d = new Date(at);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const projectedMonthUsd = Math.round((spent.monthUsd / d.getUTCDate()) * daysInMonth * 100) / 100;
  const heldJobs = listJobs(root)
    .filter((j) => isActive(j) && isRepoHold(j))
    .map((j) => j.id)
    .sort();
  return {
    day,
    month,
    onExceeded: b.onExceeded,
    spent,
    configured,
    acks,
    caps,
    remaining,
    projectedMonthUsd,
    exceeded,
    held: exceeded.length > 0 && b.onExceeded === 'hold',
    reason: exceeded.length ? formatRepoReason(exceeded, spent, caps) : null,
    heldJobs,
  };
}

/** How long the pool's memo reuses the repo budget status. */
const REPO_BUDGET_MEMO_MS = 10_000;

/**
 * The daemon pool's repo budget status, reused for up to REPO_BUDGET_MEMO_MS: the ledger stats every job's
 * events. An acknowledgement (the audit log grows) or a changed `budget:` block recomputes it at once. Null
 * when the ledger can't be read: that must not stop the supervisor, and per-job budgets still hold.
 */
export function createRepoBudgetMemo(root: string): (c: Config) => RepoBudgetStatus | null {
  let memo: { at: number; key: string; status: RepoBudgetStatus | null } | null = null;
  return (c) => {
    let size = 0;
    try {
      size = fs.statSync(repoAuditFile(root)).size;
    } catch {}
    const key = `${size}|${JSON.stringify(c.budget ?? null)}`;
    if (memo && memo.key === key && Date.now() - memo.at < REPO_BUDGET_MEMO_MS) return memo.status;
    let status: RepoBudgetStatus | null = null;
    try {
      // write: false: the pool writes no state, the spend cache included.
      status = repoBudgetStatus(root, c, { write: false });
    } catch {}
    memo = { at: Date.now(), key, status };
    return status;
  };
}

/** Retro jobs, and a job a human forced past the cap this month, are never held. */
export function repoBudgetExempt(root: string, job: Pick<Job, 'id' | 'kind'>, status: Pick<RepoBudgetStatus, 'month'>): boolean {
  if (job.kind === 'retro') return true;
  try {
    return readEvents(root, job.id).some((e) => e.type === 'budget-override' && e.month === status.month);
  } catch {
    return false;
  }
}

/** Parks a job at waiting:budget with the repo reason, releasing its owner in the same write. A no-op when it already waits on budget. */
export function parkForRepoBudget(root: string, id: string, status: RepoBudgetStatus): boolean {
  const job = loadJob(root, id);
  if (job.state === 'waiting' && job.waitingOn === 'budget') return false;
  setJob(root, id, { state: 'waiting', waitingOn: 'budget', reason: status.reason ?? REPO_HOLD_PREFIX, release: true });
  logEvent(root, id, 'repo-budget-hold', { exceeded: status.exceeded, spent: status.spent, caps: status.caps });
  return true;
}

/** Whether a job's own (per-job) budget is still exceeded. */
function perJobExceeded(root: string, config: Config, job: Job): boolean {
  let limitsConfig = config;
  try {
    limitsConfig = configForJob(root, config, job);
  } catch {
    // A tampered overlay keeps the job held: release must never be the route past a budget.
    return true;
  }
  return exceededKeys(effectiveLimits(limitsConfig, job), measureJob(root, config, job), job.budget?.ack, job.round).length > 0;
}

/**
 * Frees every repo-held job whose own budget is fine: back to queued with its stage kept, plus a
 * `resume` request when the daemon is on and none is pending. Run only when the repo is not held.
 */
export function releaseRepoHolds(root: string, config: Config, status: RepoBudgetStatus): string[] {
  if (status.held) return [];
  const released: string[] = [];
  for (const job of listJobs(root)) {
    if (!isActive(job) || !isRepoHold(job)) continue;
    if (perJobExceeded(root, config, job)) continue;
    setJob(root, job.id, { state: 'queued', reason: RELEASE_REASON });
    released.push(job.id);
    if (config.daemon?.enabled !== true) continue;
    const open = listRequests(root).some((r) => r.type === 'resume' && r.job === job.id && (r.status === 'pending' || r.status === 'in-progress'));
    if (!open) enqueue(root, config, { type: 'resume', job: job.id, text: RELEASE_REASON, from: 'budget' });
  }
  return released;
}

/** The status, then release when the repo is not held. Every place a job starts runs this first. */
export function checkRepoBudget(root: string, config: Config): RepoBudgetStatus {
  const status = repoBudgetStatus(root, config);
  if (status.held) return status;
  const released = releaseRepoHolds(root, config, status);
  return released.length ? { ...status, heldJobs: status.heldJobs.filter((id) => !released.includes(id)) } : status;
}

/** The block a command adds to its output when a key is exceeded. */
export const repoBudgetBlock = (s: RepoBudgetStatus): { held: boolean; reason: string | null } => ({ held: s.held, reason: s.reason });

/**
 * The status, when `period` is the current, exceeded month or day an ack can grant; otherwise a
 * RepoBudgetAckError. `forge budget ack` runs it before asking a person to confirm, so nobody is asked
 * for an ack that would be refused.
 */
export function assertAckable(root: string, config: Config, period: string): RepoBudgetStatus {
  const status = repoBudgetStatus(root, config);
  if (period !== status.month && period !== status.day)
    throw new RepoBudgetAckError('period', `--period must be the current UTC month (${status.month}) or day (${status.day}); got ${period}`);
  const keys = period === status.month ? MONTH_KEYS : (['usdPerDay'] as const);
  if (!status.exceeded.some((k) => keys.includes(k))) throw new RepoBudgetAckError('within', `nothing to acknowledge: ${period} is within its cap`);
  return status;
}

/**
 * `forge budget ack` and POST /api/budget/ack: grants one more period's cap for the current, exceeded
 * month or day, recorded in .forge/runtime/audit.jsonl, then releases holds.
 */
export function ackRepoBudget(root: string, config: Config, period: unknown, note: string | null, actor: EventActor): { acked: string; status: RepoBudgetStatus } {
  if (!validPeriod(period)) throw new RepoBudgetAckError('period', `--period must be YYYY-MM or YYYY-MM-DD (got ${JSON.stringify(String(period ?? '')).slice(0, 40)})`, 'usage');
  // Again after the CLI's prompt: the day or month may have turned while the person typed.
  const status = assertAckable(root, config, period);
  logRepoEvent(root, 'repo-budget-ack', { period, note: note ?? undefined, spent: status.spent, caps: status.caps, actor });
  return { acked: period, status: checkRepoBudget(root, config) };
}
