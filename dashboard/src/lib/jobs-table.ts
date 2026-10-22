// The pipeline table's sort and filter: client-side, not persisted, so the table loads in urgency order every time.
// Plain functions, no DOM access, so node:test can pin them.
import type { Job, Progress } from './types.ts';
import { STAGES, STATES } from './types.ts';
import { sortByRank } from './view.ts';

/** job.json can be hand-edited, so values are read defensively despite the types (the same alias as view.ts). */
type JobLike = Partial<Job> & { progress?: Progress };

export const SORT_KEYS = ['title', 'stage', 'state', 'tokens', 'cost', 'updated'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface TableSort {
  key: SortKey;
  dir: 'asc' | 'desc';
}

/** A header's first click: words and pipeline order read A to Z, amounts and times read largest or newest first. */
export const DEFAULT_DIR: Record<SortKey, 'asc' | 'desc'> = { title: 'asc', stage: 'asc', state: 'asc', tokens: 'desc', cost: 'desc', updated: 'desc' };

/** The click cycle on one header: its default direction, then reversed, then back to the urgency order (null). */
export function nextSort(cur: TableSort | null, key: SortKey): TableSort | null {
  if (!cur || cur.key !== key) return { key, dir: DEFAULT_DIR[key] };
  return cur.dir === DEFAULT_DIR[key] ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : null;
}

const index = (list: readonly string[], v: unknown): number | null => {
  const i = list.indexOf(String(v ?? ''));
  return i < 0 ? null : i;
};
const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A job's value for a key, or null when it is missing (no usage, an unparsable date, an unknown stage or state). */
function value(j: JobLike, key: SortKey): string | number | null {
  switch (key) {
    case 'title':
      return j.title == null ? null : String(j.title).toLowerCase();
    case 'stage':
      return index(STAGES, j.stage);
    case 'state':
      return index(STATES, j.state);
    case 'tokens':
      return finite(j.usage?.totalTokens);
    case 'cost':
      return finite(j.usage?.estCostUsd);
    case 'updated':
      return finite(Date.parse(String(j.updatedAt ?? '')));
  }
}

/** A new array: the urgency order with null, else by the key's value, missing values last either way and ties left in urgency order. */
export function sortJobs<T extends JobLike>(jobs: T[], sort: TableSort | null): T[] {
  const ranked = sortByRank(jobs);
  if (!sort) return ranked;
  const sign = sort.dir === 'asc' ? 1 : -1;
  // Array.prototype.sort is stable, so equal values keep the urgency order they came in.
  return ranked
    .map((j) => ({ j, v: value(j, sort.key) }))
    .sort((a, b) => {
      if (a.v === null || b.v === null) return a.v === b.v ? 0 : a.v === null ? 1 : -1;
      return a.v < b.v ? -sign : a.v > b.v ? sign : 0;
    })
    .map((x) => x.j);
}

/** The jobs whose title or id holds the query, case-insensitive; a blank query keeps them all. */
export function filterByText<T extends { id?: unknown; title?: unknown }>(jobs: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return jobs;
  return jobs.filter((j) => String(j.title ?? '').toLowerCase().includes(q) || String(j.id ?? '').toLowerCase().includes(q));
}
