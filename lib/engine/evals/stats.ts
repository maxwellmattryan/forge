// Eval statistics: where a job's time went, and n / mean / min / max over a run's repeats, so an
// A/B comparison shows the sample behind every number. Pure: no I/O, so every rule is a test row.
import type { EvalDelta, EvalResult, EvalRun, EvalStat, EvalTaskAggregate, EvalTaskMetric, JobEvent, Stage } from '#core/types.ts';

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

const stageOf = (side: JobEvent['from']): Stage | null => (side && typeof side === 'object' && typeof side.stage === 'string' ? side.stage : null);

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
  const ts = (e: JobEvent) => Date.parse(e.ts);
  // Stable sort: events written in the same millisecond keep their file order.
  const ordered = events.filter((e) => e && Number.isFinite(ts(e))).sort((a, b) => ts(a) - ts(b));
  const reviewerRuns = ordered.filter((e) => e.type === 'agent-start' && typeof e.role === 'string' && (e.role === 'reviewer' || e.role.startsWith('reviewer:'))).length;
  const start = createdAt ? Date.parse(createdAt) : NaN;
  if (!Number.isFinite(start)) return { stages: {}, agentMinutes: null, orchestratorMinutes: null, reviewerRuns };

  const transitions = ordered.filter((e) => e.type === 'transition');
  const ms: Partial<Record<Stage, number>> = {};
  let stage: Stage = (transitions.length ? stageOf(transitions[0].from) : null) ?? currentStage;
  let cursor = start;
  const add = (to: number) => {
    ms[stage] = (ms[stage] ?? 0) + Math.max(0, to - cursor);
    cursor = Math.max(cursor, to);
  };
  for (const t of transitions) {
    add(ts(t));
    stage = stageOf(t.to) ?? stage;
  }
  add(endMs);
  const stages: Partial<Record<Stage, number>> = {};
  for (const [k, v] of Object.entries(ms) as [Stage, number][]) stages[k] = minutes(v);

  const open = new Map<string, number>();
  const runs: [number, number][] = [];
  for (const e of ordered) {
    if (typeof e.role !== 'string') continue;
    if (e.type === 'agent-start') open.set(e.role, ts(e));
    else if (e.type === 'agent-end' && open.has(e.role)) {
      runs.push([open.get(e.role)!, ts(e)]);
      open.delete(e.role);
    }
  }
  const agentMs = runs.reduce((n, [a, b]) => n + Math.max(0, b - a), 0);
  // The union, clipped to the job's window: overlapping reviewers are one stretch of busy time.
  let busy = 0;
  let reach = -Infinity;
  for (const [a, b] of runs.map(([a, b]): [number, number] => [Math.max(a, start), Math.min(b, endMs)]).sort((x, y) => x[0] - y[0])) {
    if (b <= a) continue;
    const from = Math.max(a, reach);
    if (b > from) busy += b - from;
    reach = Math.max(reach, b);
  }
  return { stages, agentMinutes: minutes(agentMs), orchestratorMinutes: minutes(Math.max(0, endMs - start - busy)), reviewerRuns };
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
