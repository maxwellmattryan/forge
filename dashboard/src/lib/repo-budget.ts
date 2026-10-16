// The repo budget's numbers for the Analytics meter, the status-bar spend chip and the Needs-you section, from
// /api/state.budget (repoBudgetStatus in lib/repo-budget.ts). No DOM access, so node:test can import it.
import type { Job, RepoBudgetKey, RepoBudgetStatus } from './types.ts';

/** none, warn from 80% of the cap, danger once the cap is reached (the server's `exceeded`). */
export type MeterTone = 'none' | 'warn' | 'danger';

export const WARN_AT = 0.8;
const MONTH_KEYS: readonly RepoBudgetKey[] = ['usdPerMonth', 'tokensPerMonth'];

const fin = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Spent over cap, clamped to [0, 1]; null when uncapped. A cap of 0 reads as full. */
export function meterFraction(spent: number, cap: number | null): number | null {
  if (cap === null || cap === undefined) return null;
  if (cap <= 0) return 1;
  return Math.min(1, Math.max(0, fin(spent) / cap));
}

export function meterTone(spent: number, cap: number | null, exceeded: boolean): MeterTone {
  if (exceeded) return 'danger';
  const f = meterFraction(spent, cap);
  return f !== null && f >= WARN_AT ? 'warn' : 'none';
}

/** The tone's chip and fill modifier: whole literals, so Tailwind sees them. */
export const TONE_MOD: Record<MeterTone, string> = { none: '', warn: 'warn', danger: 'bad' };

/** Dollars as the meter and chip print them: cents, but a whole-dollar cap without them ($100). */
export function money(n: number | null): string {
  if (n === null) return '—';
  const v = fin(n);
  return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
}

/** Spent always shows cents ($12.30), so the chip doesn't jump width as cents come and go. */
export const spentMoney = (n: number): string => `$${fin(n).toFixed(2)}`;

export interface PeriodMeter {
  spent: number;
  cap: number | null;
  remaining: number | null;
  /** 0-100, for a width; null when uncapped. */
  percent: number | null;
  tone: MeterTone;
}

/** The month's USD meter: spent against the effective usdPerMonth. */
export function monthMeter(b: RepoBudgetStatus): PeriodMeter {
  const cap = b.caps.usdPerMonth;
  const f = meterFraction(b.spent.monthUsd, cap);
  return { spent: b.spent.monthUsd, cap, remaining: b.remaining.usdPerMonth, percent: f === null ? null : Math.round(f * 1000) / 10, tone: meterTone(b.spent.monthUsd, cap, b.exceeded.includes('usdPerMonth')) };
}

/** Today's USD meter: spent against the effective usdPerDay. */
export function dayMeter(b: RepoBudgetStatus): PeriodMeter {
  const cap = b.caps.usdPerDay;
  const f = meterFraction(b.spent.dayUsd, cap);
  return { spent: b.spent.dayUsd, cap, remaining: b.remaining.usdPerDay, percent: f === null ? null : Math.round(f * 1000) / 10, tone: meterTone(b.spent.dayUsd, cap, b.exceeded.includes('usdPerDay')) };
}

/**
 * The status-bar chip: `$12.34 / $100` against a month cap, `$12.34 this month` without one (the component picks the
 * message by `capped`). Its tone is the worst of the month and any exceeded key, so a reached day or token cap shows too.
 */
export function chipModel(b: RepoBudgetStatus): { capped: boolean; spent: string; cap: string; tone: MeterTone } {
  const m = monthMeter(b);
  const tone: MeterTone = b.exceeded.length ? 'danger' : m.tone;
  return { capped: m.cap !== null, spent: spentMoney(m.spent), cap: money(m.cap), tone };
}

/** What Acknowledge posts: the current month when a month key is exceeded, else the current day; null when nothing is. */
export function ackPeriod(b: RepoBudgetStatus): string | null {
  if (b.exceeded.some((k) => MONTH_KEYS.includes(k))) return b.month;
  if (b.exceeded.includes('usdPerDay')) return b.day;
  return null;
}

/** Whether Needs you heads with the Repo budget section. */
export const showRepoSection = (b: RepoBudgetStatus | null | undefined): boolean => Boolean(b && (b.held || b.heldJobs.length));

/** A job parked by the repo budget rather than its own: the reason prefix the CLI writes. */
export function isRepoHold(job: Pick<Job, 'state' | 'waitingOn' | 'reason'> | null | undefined): boolean {
  return Boolean(job && job.state === 'waiting' && job.waitingOn === 'budget' && String(job.reason ?? '').startsWith('repo budget:'));
}
