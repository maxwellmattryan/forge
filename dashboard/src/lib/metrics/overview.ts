// The Overview page: project cards sorted by what waits on you, and the stacked bars of jobs shipped and cost per
// UTC day across projects (GET /api/projects/stats). No DOM access.
import { STATS_WINDOWS } from './analytics.ts';
import { switcherEntries, type SwitcherEntry } from '../shell/switcher.ts';
import type { DaemonStatus, MachineProjectSummary, ProjectsResponse, ProjectsStatsResponse } from '../core/types.ts';

/** The graph windows: the Analytics ones but all time. */
export const OVERVIEW_WINDOWS = STATS_WINDOWS.filter(([v]) => v !== 'all');

export interface OverviewCard extends SwitcherEntry {
  latest: MachineProjectSummary['latest'];
  /** `none`: foreman.enabled is off; else the office session's status; null while not loaded. */
  foreman: 'none' | DaemonStatus | null;
  /** The Pipeline the waiting count links to, while openable with a job waiting. */
  waitingHref: string | null;
}

const RANK: Record<SwitcherEntry['state'], number> = { ok: 0, unavailable: 1, missing: 2 };
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * One card per registered project: openable ones first, by waiting count (most first), then latest activity (newest
 * first, none last), then name; then unavailable ones, then missing ones, each by name. [] before the list loads.
 */
export function overviewCards(r: ProjectsResponse | null): OverviewCard[] {
  if (!r) return [];
  const raw = new Map(r.projects.map((p) => [p.name, p]));
  return switcherEntries(r)
    .map((e): OverviewCard => {
      const p = raw.get(e.name);
      const d = p?.daemon ?? null;
      return {
        ...e,
        latest: e.openable ? (p?.latest ?? null) : null,
        foreman: !e.openable || !d ? null : d.foreman ? (d.office ?? 'off') : 'none',
        waitingHref: e.openable && e.waiting > 0 ? `#/p/${e.name}/pipeline` : null,
      };
    })
    .sort((a, b) => {
      if (RANK[a.state] !== RANK[b.state]) return RANK[a.state] - RANK[b.state];
      if (a.state === 'ok') {
        if (a.waiting !== b.waiting) return b.waiting - a.waiting;
        const at = a.latest?.at ?? '';
        const bt = b.latest?.at ?? '';
        if (at !== bt) return at < bt ? 1 : -1;
      }
      return byName(a, b);
    });
}

/** The series classes, whole literals so Tailwind sees them; style.css gives each its fill and background. */
export const SERIES = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'] as const;
export type Series = (typeof SERIES)[number];

export interface StackSegment {
  project: string;
  value: number;
  series: Series;
  /** The top edge and height, in percent of the chart's height (0 at the top). */
  y: number;
  h: number;
}
export interface StackColumn {
  day: string;
  total: number;
  /** Bottom-up in name order, non-zero values only. */
  segments: StackSegment[];
}
export interface StackLegend {
  project: string;
  total: number;
  /** The project's total over the grand total; null when the grand total is 0. */
  share: number | null;
  series: Series;
  error: string | null;
}
export interface Stacked {
  /** The tallest day's total: it fills the chart's height. */
  max: number;
  columns: StackColumn[];
  legend: StackLegend[];
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * One column per day, stacked by project. A project's series is its index in name order (cycling over SERIES), so
 * the shipped and cost graphs give it the same colour.
 */
export function stackedSeries(r: ProjectsStatsResponse, metric: 'shipped' | 'costUsd'): Stacked {
  const projects = [...r.projects].sort(byName);
  const series = (i: number): Series => SERIES[i % SERIES.length]!;
  const totals = r.days.map((_, d) => round4(projects.reduce((n, p) => n + finite(p[metric][d]), 0)));
  const max = Math.max(0, ...totals);
  const columns = r.days.map((day, d): StackColumn => {
    let below = 0;
    const segments: StackSegment[] = [];
    projects.forEach((p, i) => {
      const value = finite(p[metric][d]);
      if (!value) return;
      const h = (value / max) * 100;
      segments.push({ project: p.name, value, series: series(i), y: 100 - below - h, h });
      below += h;
    });
    return { day, total: totals[d]!, segments };
  });
  const sums = projects.map((p) => round4(p[metric].reduce((n: number, v) => n + finite(v), 0)));
  const grand = sums.reduce((n, v) => n + v, 0);
  const legend = projects.map((p, i): StackLegend => ({ project: p.name, total: sums[i]!, share: grand > 0 ? sums[i]! / grand : null, series: series(i), error: p.error }));
  return { max, columns, legend };
}
