// The Analytics and Evals pages: the stats query, KPI lines, usage bars, top jobs and the eval compare table. No DOM access.
import type { EvalCompare, StateJob } from '../core/types.ts';
import type { JobLike } from '../jobs/state.ts';

const s = (v: unknown): string => String(v ?? '');

/** The query for /api/stats: `?since=<iso>` for a day window, '' for all time. */
export function statsQuery(window: string, now: number): string {
  const since = window === 'all' ? '' : new Date(now - Number(window) * 86400000).toISOString();
  return since ? `?since=${encodeURIComponent(since)}` : '';
}

/**
 * The Analytics "Jobs" KPI sub-line: which message and its params. The archived count shows only
 * once retention has archived something; an older /api/stats without it reads as 0.
 */
export function jobsSummary(counts: { active: number; done: number; cancelled: number; archived?: number }): {
  key: 'analytics.jobsSub' | 'analytics.jobsSubArchived';
  params: Record<string, number>;
} {
  const params: Record<string, number> = { active: counts.active, done: counts.done, cancelled: counts.cancelled };
  const archived = Number(counts.archived) || 0;
  return archived > 0 ? { key: 'analytics.jobsSubArchived', params: { ...params, archived } } : { key: 'analytics.jobsSub', params };
}

export const STATS_WINDOWS = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['all', 'All time'],
] as const;

/** Usage rows by descending tokens, with the bar width the table draws. */
export function usageBars<T extends { tokens: number }>(rows: Record<string, T>): { key: string; row: T; width: number }[] {
  const max = Math.max(1, ...Object.values(rows).map((v) => v.tokens));
  return Object.entries(rows)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([key, row]) => ({ key, row, width: Math.max(2, (row.tokens / max) * 100) }));
}

export const topJobsByUsage = (jobs: StateJob[]): StateJob[] =>
  jobs
    .filter((j) => j.kind !== 'eval' && j.usage?.totalTokens)
    .sort((a, b) => b.usage.totalTokens - a.usage.totalTokens)
    .slice(0, 25);

export const jobMs = (j: JobLike): number | null => Date.parse(s(j.finishedAt ?? j.updatedAt)) - Date.parse(s(j.createdAt)) || null;

// ---------- evals ----------

const BETTER: Record<string, number> = { checkPassRate: 1, avgJudgeScore: 1, firstPassRate: 1, avgRounds: -1, escalationRate: -1, roundsExhaustedRate: -1, avgTokens: -1, avgCostUsd: -1, avgMinutes: -1 };

export interface CompareRow {
  key: string;
  a: string;
  b: string;
  change: string;
  tone: 'text-muted' | 'text-ok' | 'text-bad';
}

export function compareRows(c: EvalCompare): CompareRow[] {
  return Object.entries(c.delta)
    .filter(([k]) => k in BETTER)
    .map(([key, d]) => ({
      key,
      a: s(d.a ?? '—'),
      b: s(d.b ?? '—'),
      change: d.change == null ? '—' : (d.change > 0 ? '+' : '') + d.change,
      tone: d.change == null || d.change === 0 ? 'text-muted' : Math.sign(d.change) === BETTER[key] ? 'text-ok' : 'text-bad',
    }));
}
