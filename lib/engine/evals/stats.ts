// Eval statistics: where a job's time went, and n / mean / min / max over a run's repeats, so an
// A/B comparison shows the sample behind every number. Pure: no I/O, so every rule is a test row.
import type { EvalDelta, EvalResult, EvalRun, EvalStat, EvalTaskAggregate, EvalTaskMetric, JobEvent, JobState, Stage, WaitingOn } from '#core/types.ts';

export const TASK_METRICS = [
  'checkPass',
  'judgeScore',
  'firstPass',
  'rounds',
  'tokens',
  'costUsd',
  'minutes',
  'agentMinutes',
  'orchestratorMinutes',
  'reviewerRuns',
] as const satisfies readonly EvalTaskMetric[];

// Fails to type-check when lib/core/types.ts names a metric this list lacks.
type Missing = Exclude<EvalTaskMetric, (typeof TASK_METRICS)[number]>;
true satisfies [Missing] extends [never] ? true : never;

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** One result's value for each metric; null means the result doesn't count towards it. */
const METRIC: Record<EvalTaskMetric, (r: EvalResult) => number | null> = {
  checkPass: (r) => (r.check?.ran ? (r.check.pass === true ? 1 : 0) : null),
  judgeScore: (r) => (r.judge && num(r.judge.score) !== null && num(r.judge.outOf) ? r.judge.score / r.judge.outOf : null),
  firstPass: (r) => (typeof r.firstPass === 'boolean' ? (r.firstPass ? 1 : 0) : null),
  rounds: (r) => num(r.rounds),
  tokens: (r) => num(r.tokens),
  costUsd: (r) => num(r.estCostUsd),
  minutes: (r) => num(r.minutes),
  agentMinutes: (r) => num(r.agentMinutes),
  orchestratorMinutes: (r) => num(r.orchestratorMinutes),
  reviewerRuns: (r) => num(r.reviewerRuns),
};

const round = (x: number, places: number): number => Math.round(x * 10 ** places) / 10 ** places;
// The same rounding gradeJob uses for `minutes`.
const minutes = (ms: number): number => Math.round(ms / 600) / 100;

type Side = JobEvent['from'];
const field = (side: Side, k: 'stage' | 'state' | 'waitingOn'): string | null => (side && typeof side === 'object' && typeof side[k] === 'string' ? side[k] : null);
const stageOf = (side: Side): Stage | null => field(side, 'stage') as Stage | null;

/** A stretch of a job's life between two transitions, with the stage, state and waitingOn it was in. */
export interface TimelineSegment {
  from: number;
  to: number;
  stage: Stage;
  /** Null when the side that opened it is not an object or has no string state: neither running nor waiting. */
  state: JobState | null;
  waitingOn: WaitingOn | null;
}

/** One agent run: an agent-start paired with the next agent-end of its role. */
export interface TimelineRun {
  role: string;
  start: number;
  end: number;
  /** The end event's agentId, else the start's, else null. */
  agentId: string | null;
}

/** A job's events laid out in time: jobTiming's split and forge stats' speed figures (lib/engine/metrics/speed.ts) read it. */
export interface Timeline {
  start: number;
  end: number;
  /** Events with a readable ts, oldest first; same-millisecond events keep their file order. */
  ordered: JobEvent[];
  /** From createdAt through each transition to the end; a transition before the cursor gives a zero-length segment. */
  segments: TimelineSegment[];
  runs: TimelineRun[];
}

const tsOf = (e: JobEvent): number => Date.parse(e.ts);
// Stable sort: events written in the same millisecond keep their file order.
const order = (events: JobEvent[]): JobEvent[] => events.filter((e) => e && Number.isFinite(tsOf(e))).sort((a, b) => tsOf(a) - tsOf(b));

/**
 * A job's segments and agent runs from createdAt to `endMs`; null when createdAt is unreadable. The
 * first segment's stage, state and waitingOn come from the first transition's `from` side, else `current`.
 * An agent-start with no matching end is ignored.
 */
export function timeline(
  events: JobEvent[],
  createdAt: string | null | undefined,
  endMs: number,
  current: { stage: Stage; state?: JobState | null; waitingOn?: WaitingOn | null },
): Timeline | null {
  const start = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(start)) return null;
  const ordered = order(events);
  const transitions = ordered.filter((e) => e.type === 'transition');
  const first = transitions.length ? transitions[0].from : undefined;
  let stage: Stage = stageOf(first) ?? current.stage;
  let state = (transitions.length ? field(first, 'state') : (current.state ?? null)) as JobState | null;
  let waitingOn = (transitions.length ? field(first, 'waitingOn') : (current.waitingOn ?? null)) as WaitingOn | null;
  const segments: TimelineSegment[] = [];
  let cursor = start;
  const add = (to: number) => {
    const end = Math.max(cursor, to);
    segments.push({ from: cursor, to: end, stage, state, waitingOn });
    cursor = end;
  };
  for (const t of transitions) {
    add(tsOf(t));
    stage = stageOf(t.to) ?? stage;
    state = field(t.to, 'state') as JobState | null;
    waitingOn = field(t.to, 'waitingOn') as WaitingOn | null;
  }
  add(endMs);

  const open = new Map<string, JobEvent>();
  const runs: TimelineRun[] = [];
  for (const e of ordered) {
    if (typeof e.role !== 'string') continue;
    if (e.type === 'agent-start') open.set(e.role, e);
    else if (e.type === 'agent-end' && open.has(e.role)) {
      const s = open.get(e.role)!;
      const agentId = typeof e.agentId === 'string' ? e.agentId : typeof s.agentId === 'string' ? s.agentId : null;
      runs.push({ role: e.role, start: tsOf(s), end: tsOf(e), agentId });
      open.delete(e.role);
    }
  }
  return { start, end: endMs, ordered, segments, runs };
}

/** The length of the union of `spans`, each clipped to [from, to]: overlapping agents are one stretch of busy time. */
export function busyMs(spans: [number, number][], from: number, to: number): number {
  let busy = 0;
  let reach = -Infinity;
  for (const [a, b] of spans.map(([a, b]): [number, number] => [Math.max(a, from), Math.min(b, to)]).sort((x, y) => x[0] - y[0])) {
    if (b <= a) continue;
    const lo = Math.max(a, reach);
    if (b > lo) busy += b - lo;
    reach = Math.max(reach, b);
  }
  return busy;
}

/**
 * Where a job's wall time went: per stage (from its transitions), in agents (summed across
 * parallel agents) and outside any agent. An agent-start with no matching end is ignored.
 */
export function jobTiming(
  events: JobEvent[],
  createdAt: string | null,
  endMs: number,
  currentStage: Stage,
): { stages: Partial<Record<Stage, number>>; agentMinutes: number | null; orchestratorMinutes: number | null; reviewerRuns: number } {
  const reviewerRuns = order(events).filter((e) => e.type === 'agent-start' && typeof e.role === 'string' && (e.role === 'reviewer' || e.role.startsWith('reviewer:'))).length;
  const tl = timeline(events, createdAt, endMs, { stage: currentStage });
  if (!tl) return { stages: {}, agentMinutes: null, orchestratorMinutes: null, reviewerRuns };
  const ms: Partial<Record<Stage, number>> = {};
  for (const s of tl.segments) ms[s.stage] = (ms[s.stage] ?? 0) + (s.to - s.from);
  const stages: Partial<Record<Stage, number>> = {};
  for (const [k, v] of Object.entries(ms) as [Stage, number][]) stages[k] = minutes(v);
  const spans = tl.runs.map((r): [number, number] => [r.start, r.end]);
  const agentMs = spans.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  const busy = busyMs(spans, tl.start, endMs);
  return { stages, agentMinutes: minutes(agentMs), orchestratorMinutes: minutes(Math.max(0, endMs - tl.start - busy)), reviewerRuns };
}

/** n, mean, min and max, rounded to 0.001; all null when there is no sample. */
export function stat(xs: number[]): EvalStat {
  if (!xs.length) return { n: 0, mean: null, min: null, max: null };
  return {
    n: xs.length,
    mean: round(xs.reduce((a, b) => a + b, 0) / xs.length, 3),
    min: round(Math.min(...xs), 3),
    max: round(Math.max(...xs), 3),
  };
}

const graded = (entries: EvalRun['tasks']): EvalResult[] => entries.map((t) => t.result).filter((r): r is EvalResult => Boolean(r));

/** Stage minutes over the results that entered each stage. */
export function stageStats(results: EvalResult[]): Record<string, EvalStat> {
  const by = new Map<string, number[]>();
  for (const r of results) {
    if (!r.stages || typeof r.stages !== 'object') continue;
    for (const [k, v] of Object.entries(r.stages)) {
      if (num(v) === null) continue;
      by.set(k, [...(by.get(k) ?? []), v as number]);
    }
  }
  return Object.fromEntries([...by].map(([k, xs]) => [k, stat(xs)]));
}

function metricStats(results: EvalResult[]): Record<EvalTaskMetric, EvalStat> {
  return Object.fromEntries(TASK_METRICS.map((m) => [m, stat(results.map(METRIC[m]).filter((x): x is number => x !== null))])) as Record<EvalTaskMetric, EvalStat>;
}

/** Per task, in first-seen order: how many repeats ran, how many were graded, and their spread. */
export function aggregateTasks(tasks: EvalRun['tasks']): EvalTaskAggregate[] {
  const by = new Map<string, EvalRun['tasks']>();
  for (const t of tasks ?? []) by.set(t.task, [...(by.get(t.task) ?? []), t]);
  return [...by].map(([task, entries]) => {
    const rs = graded(entries);
    return { task, runs: entries.length, graded: rs.length, metrics: metricStats(rs), stages: stageStats(rs) };
  });
}

/** Two means, the change from a to b, and the count behind each. */
export function delta(a: EvalStat | null, b: EvalStat | null): EvalDelta {
  const x = a?.mean ?? null;
  const y = b?.mean ?? null;
  return { a: x, b: y, change: x !== null && y !== null ? round(y - x, 3) : null, na: a?.n ?? 0, nb: b?.n ?? 0 };
}

/**
 * A task's check across its repeats: true when at least one graded repeat ran its check and every
 * one that ran passed, false when any failed, null when none ran.
 */
export function taskPass(entries: EvalRun['tasks']): boolean | null {
  const ran = graded(entries).filter((r) => r.check?.ran);
  if (!ran.length) return null;
  return ran.every((r) => r.check.pass === true);
}
