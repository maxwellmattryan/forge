// Where a done job's time went, for forge stats: working and parked time per stage, time between agents, stalls, agent gaps and extra rounds, over timeline() in lib/engine/evals/stats.ts. Pure: no I/O.
import { STAGES, WAITING_ON } from '#core/job/schema.ts';
import { busyMs, timeline } from '../evals/stats.ts';
import type { TimelineSegment } from '../evals/stats.ts';
import type { Job, JobEvent, Stage, Stats, TimeSpread, WaitingOn } from '#core/types.ts';

/** The shortest stretch with no agent, no command and no event that counts as a stall. */
export const STALL_MS = 5 * 60_000;

/** One done job's time, in ms unless named otherwise. */
export interface JobSpeed {
  /** Per stage, time in state running; only stages with some. */
  stageMs: Partial<Record<Stage, number>>;
  /** Per waitingOn, time in state waiting on it; only those with some. */
  waitingMs: Partial<Record<WaitingOn, number>>;
  runningMs: number;
  /** Running with no agent run open. */
  idleMs: number;
  /** Running in stretches of STALL_MS or more with no agent, no command span and no event. */
  stalledMs: number;
  /** Agent gaps: each run that overlaps no earlier one, from the latest earlier end, while running throughout. */
  gaps: { seconds: number; withCommand: boolean }[];
  /** Wall minutes from each round ≥ 2's first `round` event to the first later `verdicts` event for it. */
  extraRoundMinutes: number[];
  /** Every agent run; `background` when it overlaps another run of the job. */
  runs: { start: number; end: number; agentId: string | null; background: boolean }[];
}

/** The median of `xs`, null for none. */
export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** The nearest-rank 90th percentile of `xs`, null for none. */
export function p90(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.ceil(0.9 * s.length) - 1];
}

const round = (x: number | null, places: number): number | null => (x === null ? null : Math.round(x * 10 ** places) / 10 ** places);

/** The median, p90 and size of `xs`, rounded to `places`. */
export function spread(xs: number[], places: number): TimeSpread {
  return { median: round(median(xs), places), p90: round(p90(xs), places), n: xs.length };
}

/** The parts of [from, to] that no span covers; `spans` sorted by start. */
function uncovered(from: number, to: number, spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cursor = from;
  for (const [a, b] of spans) {
    if (b <= cursor || a >= to) continue;
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < to) out.push([cursor, to]);
  return out;
}

/** Whether [a, b] lies inside the timeline and every segment it touches is running. */
function runningThroughout(segments: TimelineSegment[], a: number, b: number): boolean {
  if (a === b) return segments.some((s) => s.state === 'running' && s.from <= a && a <= s.to);
  const touched = segments.filter((s) => s.from < b && s.to > a);
  return touched.length > 0 && a >= touched[0].from && b <= touched[touched.length - 1].to && touched.every((s) => s.state === 'running');
}

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** A done job's speed figures; null unless it is done with a readable createdAt and finishedAt. */
export function jobSpeed(job: Job, events: JobEvent[]): JobSpeed | null {
  if (job.state !== 'done' || typeof job.finishedAt !== 'string') return null;
  const end = Date.parse(job.finishedAt);
  if (!Number.isFinite(end)) return null;
  const tl = timeline(events, job.createdAt, end, { stage: job.stage, state: job.state, waitingOn: job.waitingOn });
  if (!tl) return null;
  const ts = (e: JobEvent) => Date.parse(e.ts);
  const agentSpans = tl.runs.map((r): [number, number] => [r.start, r.end]);
  const commands = tl.ordered.filter((e) => e.type === 'command');
  const commandSpans = commands.map((e): [number, number] => [ts(e) - Math.max(0, num(e.durationMs) ?? 0), ts(e)]);
  const covered = [...agentSpans, ...commandSpans].sort((x, y) => x[0] - y[0]);

  const stageMs: JobSpeed['stageMs'] = {};
  const waitingMs: JobSpeed['waitingMs'] = {};
  let runningMs = 0, idleMs = 0, stalledMs = 0;
  // Running stretches with no agent and no command, oldest first.
  const quiet: [number, number][] = [];
  for (const s of tl.segments) {
    const len = s.to - s.from;
    if (len <= 0) continue;
    if (s.state === 'waiting' && s.waitingOn) waitingMs[s.waitingOn] = (waitingMs[s.waitingOn] ?? 0) + len;
    if (s.state !== 'running') continue;
    stageMs[s.stage] = (stageMs[s.stage] ?? 0) + len;
    runningMs += len;
    idleMs += len - busyMs(agentSpans, s.from, s.to);
    quiet.push(...uncovered(s.from, s.to, covered));
  }
  // An event of any kind is a sign of life, so it splits a quiet stretch; `ordered` is sorted, so one pointer walks both.
  const cuts = tl.ordered.map(ts);
  let k = 0;
  for (const [a, b] of quiet) {
    while (k < cuts.length && cuts[k] <= a) k++;
    let piece = a;
    for (let i = k; i < cuts.length && cuts[i] < b; i++) {
      if (cuts[i] - piece >= STALL_MS) stalledMs += cuts[i] - piece;
      piece = cuts[i];
    }
    if (b - piece >= STALL_MS) stalledMs += b - piece;
  }

  const sorted = [...tl.runs].sort((x, y) => x.start - y.start || x.end - y.end);
  const gaps: JobSpeed['gaps'] = [];
  let reach = -Infinity;
  for (const [i, r] of sorted.entries()) {
    if (i > 0 && r.start >= reach && runningThroughout(tl.segments, reach, r.start)) {
      gaps.push({ seconds: (r.start - reach) / 1000, withCommand: commands.some((e) => ts(e) >= reach && ts(e) <= r.start) });
    }
    reach = Math.max(reach, r.end);
  }
  const runs = tl.runs.map((r) => ({ start: r.start, end: r.end, agentId: r.agentId, background: tl.runs.some((o) => o !== r && o.start < r.end && o.end > r.start) }));

  const extraRoundMinutes: number[] = [];
  const seen = new Set<number>();
  for (const [i, e] of tl.ordered.entries()) {
    const n = num(e.round);
    if (e.type !== 'round' || n === null || n < 2 || seen.has(n)) continue;
    seen.add(n);
    const done = tl.ordered.slice(i + 1).find((v) => v.type === 'verdicts' && v.round === n);
    if (done) extraRoundMinutes.push((ts(done) - ts(e)) / 60_000);
  }
  return { stageMs, waitingMs, runningMs, idleMs, stalledMs, gaps, extraRoundMinutes, runs };
}

const minutes = (ms: number[]): number | null => round(median(ms.map((x) => x / 60_000)), 2);

/** The speed figures over done jobs' JobSpeed: medians in minutes (2 places), spreads in seconds (1 place) or minutes. */
export function speedFigures(perJob: JobSpeed[]): Omit<Stats['speed'], 'medianMinutesToPr' | 'medianMinutesToDone' | 'agentStartSeconds'> {
  const stageMinutes: Stats['speed']['stageMinutes'] = {};
  for (const s of STAGES) {
    const m = minutes(perJob.flatMap((j) => j.stageMs[s] ?? []));
    if (m !== null) stageMinutes[s] = m;
  }
  const waitingMinutes: Stats['speed']['waitingMinutes'] = {};
  for (const w of WAITING_ON) {
    const m = minutes(perJob.flatMap((j) => j.waitingMs[w] ?? []));
    if (m !== null) waitingMinutes[w] = m;
  }
  const working = perJob.filter((j) => j.runningMs > 0);
  const gaps = perJob.flatMap((j) => j.gaps);
  return {
    stageMinutes,
    waitingMinutes,
    medianHandoffMinutes: minutes(working.map((j) => j.idleMs)),
    stalledMinutes: minutes(working.map((j) => j.stalledMs)),
    handoffSeconds: {
      withoutCommand: spread(gaps.filter((g) => !g.withCommand).map((g) => g.seconds), 1),
      withCommand: spread(gaps.filter((g) => g.withCommand).map((g) => g.seconds), 1),
    },
    minutesPerExtraRound: spread(perJob.flatMap((j) => j.extraRoundMinutes), 2),
    timedJobs: perJob.length,
  };
}
