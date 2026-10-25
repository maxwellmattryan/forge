// Per-UTC-day totals over a window ending today: the jobs shipped (non-eval, state done, on the day of finishedAt,
// live or archived) and the spend ledger's cost (reported and metered), for the Overview's graphs (GET /api/projects/stats).
import { listArchived } from '#core/job/archive.ts';
import { listJobs } from '#core/job/store.ts';
import type { Config, Job } from '#core/types.ts';
import { periodTotals, spendLedger } from './spend.ts';

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const usd = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** UTC `YYYY-MM-DD` of an ISO time, or null when it doesn't parse. */
function utcDay(ts: unknown): string | null {
  if (typeof ts !== 'string') return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** The `days` UTC dates ending at `at`'s, oldest first. */
export function windowDays(days: number, at: number = Date.now()): string[] {
  const end = Date.parse(new Date(at).toISOString().slice(0, 10));
  return Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/**
 * One repo's shipped jobs and cost per UTC day over the window, plus today's and this month's spend
 * (periodTotals over the same ledger). The ledger is read with write: false, so a GET never writes .forge/runtime/.
 */
export function dailyTotals(
  root: string,
  config: Config,
  { days, at = Date.now() }: { days: number; at?: number },
): { days: string[]; shipped: number[]; costUsd: number[]; dayUsd: number; monthUsd: number } {
  const list = windowDays(days, at);
  const index = new Map(list.map((d, i) => [d, i]));
  const shipped = list.map(() => 0);
  const cost = list.map(() => 0);

  const jobs = new Map<string, Pick<Job, 'id' | 'kind' | 'state' | 'finishedAt' | 'updatedAt'>>();
  for (const j of listJobs(root)) jobs.set(j.id, j);
  for (const a of listArchived(root)) if (!jobs.has(a.job.id)) jobs.set(a.job.id, a.job);
  for (const j of jobs.values()) {
    if (j.kind === 'eval' || j.state !== 'done') continue;
    const i = index.get(utcDay(j.finishedAt) ?? utcDay(j.updatedAt) ?? '');
    if (i !== undefined) shipped[i]++;
  }

  const ledger = spendLedger(root, config, { write: false });
  for (const j of Object.values(ledger)) {
    for (const [key, b] of [...Object.entries(j.buckets ?? {}), ...Object.entries(j.metered ?? {})]) {
      const i = index.get(key.slice(0, key.indexOf('|')));
      if (i !== undefined) cost[i] += usd(b.usd);
    }
  }
  const { dayUsd, monthUsd } = periodTotals(ledger, at);
  return { days: list, shipped, costUsd: cost.map(round4), dayUsd, monthUsd };
}
