// The Pipeline page's board and table: filters, counts, columns, urgency order, each card's slots, and the table's
// sort, filter chips and mandate groups. No DOM access.
import type { Progress, Stage } from '../core/types.ts';
import { MANDATE_ID_SOURCE } from '../core/types.ts';
import { STAGE_LABEL } from '../core/labels.ts';
import { protectedSummary } from './protected.ts';
import type { ProtectedSummary } from './protected.ts';
import { isOpen, isShelved, needsHuman, prChipModel, progressWidth } from './state.ts';
import type { JobLike } from './state.ts';

const s = (v: unknown): string => String(v ?? '');

/** The Waiting filter: a job waiting, blocked or failed, but not one a person set aside. */
const waits = (j: JobLike): boolean => ['waiting', 'blocked', 'failed'].includes(j.state as string) && !isShelved(j);

export function filterJobs<T extends JobLike>(jobs: T[], filter: string): T[] {
  const list = jobs.filter((j) => j.kind !== 'eval' || filter === 'all');
  if (filter === 'active') return list.filter(isOpen);
  if (filter === 'waiting') return list.filter(waits);
  if (filter === 'done') return list.filter((j) => ['done', 'cancelled'].includes(j.state as string));
  return list;
}

export function pipelineCounts(jobs: JobLike[]): { all: number; active: number; waiting: number; done: number } {
  const all = jobs.filter((j) => j.kind !== 'eval');
  return {
    all: jobs.length,
    active: all.filter(isOpen).length,
    waiting: all.filter(waits).length,
    done: all.filter((j) => ['done', 'cancelled'].includes(j.state as string)).length,
  };
}

export const BOARD_GROUPS = [
  { id: 'queued', stages: ['backlog'] },
  { id: 'plan', stages: ['plan', 'spec', 'design'] },
  { id: 'build', stages: ['build', 'verify', 'review'] },
  { id: 'ship', stages: ['integrate', 'decide', 'pr'] },
  { id: 'done', stages: ['done'] },
] as const;
export type BoardGroupId = (typeof BOARD_GROUPS)[number]['id'];
/** The stepper's 9 stages: plan…pr, i.e. the plan, build and ship groups. */
export const STEPPER_STAGES: Stage[] = BOARD_GROUPS.slice(1, 4).flatMap((g) => [...g.stages]);

/** The board column a job sits in. A finished job left in an earlier stage still lands in Done, and a stage no group
 *  knows (a hand-edited job.json) lands in Queued so the job is never invisible. */
function boardGroup(j: JobLike): BoardGroupId {
  if (j.state === 'cancelled' || j.state === 'done' || j.stage === 'done') return 'done';
  return BOARD_GROUPS.find((g) => (g.stages as readonly string[]).includes(s(j.stage)))?.id ?? 'queued';
}

/** Urgency: 0 needs you, failed or blocked; 1 running; 2 PR review; 3 queued and other waits (dependency parks, shelved jobs); 4 finished. */
export function boardRank(j: JobLike): 0 | 1 | 2 | 3 | 4 {
  if (needsHuman(j) || j.state === 'failed' || j.state === 'blocked') return 0;
  if (j.state === 'running') return 1;
  if (j.state === 'waiting' && j.waitingOn === 'pr-review') return 2;
  if (j.state === 'done' || j.state === 'cancelled') return 4;
  return 3;
}

/** A new array by urgency, then newest updatedAt (a missing or invalid date last), then id ascending. */
export function sortByRank<T extends JobLike>(jobs: T[]): T[] {
  const time = (j: T) => {
    const ms = Date.parse(s(j.updatedAt));
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  return jobs
    .map((j) => ({ j, rank: boardRank(j), at: time(j), id: s(j.id) }))
    .sort((a, b) => a.rank - b.rank || (a.at === b.at ? 0 : b.at > a.at ? 1 : -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((x) => x.j);
}

/** Queued, Plan, Build and Ship always; Done only when it holds a job. Each column is sorted by urgency. */
export function boardColumns<T extends JobLike>(jobs: T[]): { id: BoardGroupId; jobs: T[] }[] {
  const sorted = sortByRank(jobs);
  return BOARD_GROUPS.map((g) => ({ id: g.id, jobs: sorted.filter((j) => boardGroup(j) === g.id) })).filter((c) => c.id !== 'done' || c.jobs.length > 0);
}

/** The table's columns that show only when a row fills them, in rendered order; Job, Title, Stage, State and Updated always show. */
export const OPTIONAL_COLUMNS = ['needs', 'round', 'tasks', 'verdicts', 'pr', 'tokens', 'cost', 'budget'] as const;
export type OptionalColumn = (typeof OPTIONAL_COLUMNS)[number];

/**
 * The ids in `dependsOn` whose job in `all` is missing or not done: the Needs cell. Its own loop rather than deps.ts's
 * depLinks, which imports cardRef from here.
 */
export function openNeedIds(j: JobLike, all: JobLike[]): string[] {
  const ids = Array.isArray(j.dependsOn) ? j.dependsOn.filter((d: unknown): d is string => typeof d === 'string' && d !== '') : [];
  return ids.filter((id) => all.find((x) => x?.id === id)?.state !== 'done');
}

/**
 * The optional table columns at least one job fills, judged as each cell judges value vs `—`; `hasBudget` is the Budget
 * cell's own test, and `all` the jobs dependencies resolve against.
 */
export function tableColumns<T extends JobLike>(jobs: T[], hasBudget: (j: T) => boolean, all: JobLike[] = jobs): Set<OptionalColumn> {
  const fills: Record<OptionalColumn, (j: T) => boolean> = {
    needs: (j) => openNeedIds(j, all).length > 0,
    round: (j) => Number(j.round) > 0,
    tasks: (j) => Number(j.progress?.total) > 0,
    verdicts: (j) => Array.isArray(j.reviewers) && j.reviewers.length > 0,
    pr: (j) => prChipModel(j.pr) !== null,
    tokens: (j) => j.usage?.totalTokens != null,
    cost: (j) => j.usage?.estCostUsd != null,
    budget: hasBudget,
  };
  return new Set(OPTIONAL_COLUMNS.filter((c) => jobs.some(fills[c])));
}

/** The table's sortable columns: every column but Verdicts and Budget. */
export const SORT_COLUMNS = ['job', 'title', 'stage', 'state', 'needs', 'round', 'tasks', 'pr', 'tokens', 'cost', 'updated'] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];
export interface TableSort {
  col: SortColumn;
  dir: 'asc' | 'desc';
}

/** A column's first-click direction: names and the pipeline read ascending, amounts and recency descending. */
const NATURAL: Record<SortColumn, TableSort['dir']> = { job: 'asc', title: 'asc', stage: 'asc', state: 'asc', needs: 'desc', round: 'desc', tasks: 'desc', pr: 'desc', tokens: 'desc', cost: 'desc', updated: 'desc' };

/** The stored `tableSort` pref as a sort; anything but a known column and direction is the urgency order (null). */
export function parseSort(raw: string): TableSort | null {
  const [col, dir, ...rest] = s(raw).split(':');
  if (rest.length || !(SORT_COLUMNS as readonly string[]).includes(col ?? '') || (dir !== 'asc' && dir !== 'desc')) return null;
  return { col: col as SortColumn, dir };
}

/** The sort as its `tableSort` pref value; `""` for the urgency order. */
export const sortPref = (sort: TableSort | null): string => (sort ? `${sort.col}:${sort.dir}` : '');

/** A header click: a new column starts at its natural direction, the same column reverses, then returns to the urgency order. */
export function nextSort(cur: TableSort | null, col: SortColumn): TableSort | null {
  if (!cur || cur.col !== col) return { col, dir: NATURAL[col] };
  if (cur.dir === NATURAL[col]) return { col, dir: cur.dir === 'asc' ? 'desc' : 'asc' };
  return null;
}

/** The pipeline's stage order: Queued, the stepper's stages, Done. */
const STAGE_ORDER: readonly string[] = ['backlog', ...STEPPER_STAGES, 'done'];

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A row's sort key for `col`, or null where its cell shows `—` (or the value is unusable). */
function sortKey(j: JobLike, col: SortColumn, all: JobLike[]): number | string | null {
  switch (col) {
    case 'job':
      return cardRef(j) ?? (s(j.id) || null);
    case 'title':
      return s(j.title) || null;
    case 'stage': {
      const i = STAGE_ORDER.indexOf(s(j.stage));
      return i < 0 ? null : i;
    }
    case 'state':
      return boardRank(j);
    case 'needs':
      return openNeedIds(j, all).length || null;
    case 'round':
      return Number(j.round) > 0 ? Number(j.round) : null;
    case 'tasks':
      return Number(j.progress?.total) > 0 ? finite(j.progress?.done) : null;
    case 'pr':
      return finite(j.pr?.number);
    case 'tokens':
      return finite(j.usage?.totalTokens);
    case 'cost':
      return finite(j.usage?.estCostUsd);
    case 'updated': {
      const ms = Date.parse(s(j.updatedAt));
      return Number.isNaN(ms) ? null : ms;
    }
  }
}

/** The table's rows in `sort`, or the urgency order for null. Rows without a value go last either way; ties keep the urgency order. */
export function sortTable<T extends JobLike>(jobs: T[], sort: TableSort | null, all: JobLike[]): T[] {
  const ranked = sortByRank(jobs);
  if (!sort) return ranked;
  const sign = sort.dir === 'asc' ? 1 : -1;
  const cmp = (a: number | string, b: number | string): number =>
    typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
  return ranked
    .map((j, i) => ({ j, i, k: sortKey(j, sort.col, all) }))
    .sort((a, b) => {
      if (a.k === null || b.k === null) return a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1;
      return sign * cmp(a.k, b.k) || a.i - b.i;
    })
    .map((x) => x.j);
}

const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);

/** A job's mandate id, as mandateBadge (lib/office/foreman.ts) judges it, without importing its fetch helpers; null for none. */
const mandateOf = (j: JobLike): string | null => (typeof j.mandate === 'string' && MANDATE_ID.test(j.mandate) && j.mandate !== 'none' ? j.mandate : null);

export type FilterField = 'mandate' | 'state' | 'stage';
/** One filter chip. A mandate of `''` is No mandate; a state of `'open'` is any job not done or cancelled. */
export interface FilterChip {
  field: FilterField;
  value: string;
}

const FILTER_FIELDS: readonly FilterField[] = ['mandate', 'state', 'stage'];
const STATE_ORDER: readonly string[] = ['running', 'waiting', 'blocked', 'failed', 'done', 'cancelled'];

function chipMatches(j: JobLike, c: FilterChip): boolean {
  if (c.field === 'mandate') return (mandateOf(j) ?? '') === c.value;
  if (c.field === 'state') return c.value === 'open' ? isOpen(j) : s(j.state) === c.value;
  return s(j.stage) === c.value;
}

/** The rows the chips and search keep: chips of one field OR, fields and the search AND; the search is a trimmed, case-insensitive substring of ref, id or title. */
export function filterTable<T extends JobLike>(jobs: T[], chips: FilterChip[], text: string): T[] {
  const q = s(text).trim().toLowerCase();
  const fields = FILTER_FIELDS.map((f) => chips.filter((c) => c.field === f)).filter((cs) => cs.length > 0);
  return jobs.filter(
    (j) => fields.every((cs) => cs.some((c) => chipMatches(j, c))) && (!q || [cardRef(j) ?? '', s(j.id), s(j.title)].join('\n').toLowerCase().includes(q)),
  );
}

/** What + Filter offers: present mandates (first seen, then No mandate), open then present states, present stages in pipeline order; never a chosen chip. */
export function filterChoices(jobs: JobLike[], chips: FilterChip[]): FilterChip[] {
  const mandates = [...new Set(jobs.map((j) => mandateOf(j)))];
  const ids = mandates.filter((m): m is string => m !== null);
  const states = new Set(jobs.map((j) => s(j.state)).filter(Boolean));
  const stages = new Set(jobs.map((j) => s(j.stage)));
  const out: FilterChip[] = [
    ...[...ids, ...(mandates.includes(null) ? [''] : [])].map((value) => ({ field: 'mandate' as const, value })),
    ...(jobs.some(isOpen) ? ['open'] : []).map((value) => ({ field: 'state' as const, value })),
    ...[...STATE_ORDER.filter((x) => states.has(x)), ...[...states].filter((x) => !STATE_ORDER.includes(x)).sort()].map((value) => ({ field: 'state' as const, value })),
    ...STAGE_ORDER.filter((x) => stages.has(x)).map((value) => ({ field: 'stage' as const, value })),
  ];
  return out.filter((o) => !chips.some((c) => c.field === o.field && c.value === o.value));
}

/** One mandate's rows; `mandate` null is No mandate. `merged` counts rows whose PR merged or that are done. */
export interface MandateGroup<T> {
  mandate: string | null;
  jobs: T[];
  merged: number;
}

/** The rows split by mandate, in input order, each group placed by its first row; No mandate always last. */
export function groupByMandate<T extends JobLike>(rows: T[]): MandateGroup<T>[] {
  const groups = new Map<string | null, MandateGroup<T>>();
  for (const j of rows) {
    const m = mandateOf(j);
    const g = groups.get(m) ?? { mandate: m, jobs: [], merged: 0 };
    g.jobs.push(j);
    if (j.pr?.state === 'MERGED' || j.state === 'done') g.merged++;
    groups.set(m, g);
  }
  const all = [...groups.values()];
  return [...all.filter((g) => g.mandate !== null), ...all.filter((g) => g.mandate === null)];
}

export type TableRow<T> = { kind: 'group'; group: MandateGroup<T>; open: boolean } | { kind: 'job'; job: T };

/** Each group's header row, then its job rows unless `collapsed` holds its key (`mandate ?? ''`). */
export function tableRows<T>(groups: MandateGroup<T>[], collapsed: ReadonlySet<string>): TableRow<T>[] {
  return groups.flatMap((group): TableRow<T>[] => {
    const open = !collapsed.has(group.mandate ?? '');
    return [{ kind: 'group', group, open }, ...(open ? group.jobs.map((job): TableRow<T> => ({ kind: 'job', job })) : [])];
  });
}

export interface StageStep {
  stage: Stage;
  status: 'past' | 'current' | 'future';
  tone: 'gleam' | 'ember';
}

/** The card's 9-dot stepper over STEPPER_STAGES. Only the current step can be red: when the job needs a human, failed or is blocked. */
function stageSteps(j: JobLike): StageStep[] {
  const at = j.stage === 'done' ? STEPPER_STAGES.length : STEPPER_STAGES.indexOf(j.stage as Stage);
  const red = needsHuman(j) || j.state === 'failed' || j.state === 'blocked';
  return STEPPER_STAGES.map((stage, i) => {
    const status = at < 0 || i > at ? 'future' : i < at ? 'past' : 'current';
    return { stage, status, tone: status === 'current' && red ? 'ember' : 'gleam' };
  });
}

/** The 1-based step a screen reader hears: the current step, else the count of past steps (0 before plan, 9 when done). */
export const stepPosition = (steps: StageStep[]): number => {
  const i = steps.findIndex((x) => x.status === 'current');
  return i >= 0 ? i + 1 : steps.filter((x) => x.status === 'past').length;
};

/**
 * An issue as a short label: `#12` for a bare number, `repo#12` for `owner/repo#12` (the dashboard
 * knows no repo slug, so a qualified ref keeps its last segment), any other ref as it is.
 */
function issueLabel(ref: unknown): string | null {
  const r = s(ref);
  if (!r) return null;
  if (/^\d+$/.test(r)) return `#${r}`;
  const q = /(?:^|\/)([^/#]+)#(\d+)$/.exec(r);
  return q && r.includes('/') ? `${q[1]}#${q[2]}` : r;
}

/**
 * The card's tracker ref: the primary issue's label, plus ` +N` when more issues have refs. The
 * label is hidden for a local slug ref the id starts with, which would only print a near-copy of
 * the id; the count stays, so a multi-issue job never looks like a single-issue one.
 */
export function cardRef(job: JobLike): string | null {
  const refs = (Array.isArray(job.issues) ? job.issues : []).map((i) => s(i?.ref)).filter(Boolean);
  const first = refs[0];
  if (!first) return null;
  const more = refs.length > 1 ? `+${refs.length - 1}` : '';
  const label = issueLabel(first);
  if (!label || (!/^\d+$/.test(first) && !first.includes('/') && s(job.id).startsWith(first))) return more || null;
  return more ? `${label} ${more}` : label;
}

export interface CardModel {
  ref: string;
  refTitle: string;
  steps: StageStep[];
  stage: string;
  round: { round: number; max: number | null } | null;
  progress: Progress | null;
  lenses: { name: string; verdict: string | null }[] | null;
  /** The job is running: its stepper's current step carries the draw-on ring. */
  running: boolean;
  /** Protected paths the branch changes: the state slot's Protected chip. */
  protected: ProtectedSummary | null;
}

/** Everything a card's slots show, so JobCard reads no raw job state. */
export function cardModel(j: JobLike): CardModel {
  const round = Number(j.round) || 0;
  const verdicts = j.verdicts?.[round];
  return {
    ref: cardRef(j) ?? s(j.id),
    refTitle: s(j.id),
    steps: stageSteps(j),
    stage: STAGE_LABEL[j.stage as Stage] ?? s(j.stage),
    round: round > 0 ? { round, max: j.maxRounds ?? null } : null,
    progress: j.progress && progressWidth(j.progress) !== null ? j.progress : null,
    lenses: j.reviewers?.length ? j.reviewers.map((name) => ({ name, verdict: verdicts?.[name] ?? null })) : null,
    running: j.state === 'running',
    protected: protectedSummary({ protectedPaths: j.protectedPaths ?? null }),
  };
}
