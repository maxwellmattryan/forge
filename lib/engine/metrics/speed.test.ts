// Where a done job's time went: working and parked time, time between agents, stalls, agent gaps
// and extra rounds, per job and as forge stats' medians and spreads.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobSpeed, p90, speedFigures, spread } from './speed.ts';
import { normalizeJob } from '#core/job/schema.ts';
import type { JobEvent } from '#core/types.ts';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const MIN = 60_000;
const at = (min: number): string => new Date(T0 + min * MIN).toISOString();
const ev = (min: number, type: string, more: Record<string, unknown> = {}): JobEvent => ({ v: 1, ts: at(min), type, ...more });
const side = (stage: string, state = 'running', waitingOn: string | null = null) => ({ stage, state, waitingOn }) as JobEvent['from'];
const move = (min: number, from: JobEvent['from'], to: JobEvent['from']) => ev(min, 'transition', { from, to });
const run = (role: string, start: number, end: number, agentId?: string) => [ev(start, 'agent-start', { role }), ev(end, 'agent-end', { role, ...(agentId ? { agentId } : {}) })];
const done = (id: string, finished: number | null, more: Record<string, unknown> = {}) =>
  normalizeJob({ id, stage: 'done', state: 'done', createdAt: at(0), finishedAt: finished === null ? null : at(finished), ...more });

test("a done job's working, parked, idle and stalled time", () => {
  const a = [
    ...run('spec-writer', 0, 6),
    // 6–10: a 4-minute idle stretch, no stall.
    move(10, side('spec'), side('spec', 'waiting', 'spec-approval')),
    move(40, side('spec', 'waiting', 'spec-approval'), side('build')),
    ...run('builder', 41, 64),
    // 64–70: six quiet minutes cut by a note into 3 + 3, no stall.
    ev(67, 'note', { text: 'still here' }),
    move(70, side('build'), side('review')),
    // A command covers 74–75; 75–80 and 90–100 are stalls.
    ev(75, 'command', { name: 'test', ok: true, durationMs: MIN }),
    ...run('reviewer:code', 80, 90),
    move(100, side('review'), side('done', 'done')),
  ];
  const sa = jobSpeed(done('A', 100), a);
  assert.ok(sa);
  assert.deepEqual(sa.stageMs, { spec: 10 * MIN, build: 30 * MIN, review: 30 * MIN });
  assert.deepEqual(sa.waitingMs, { 'spec-approval': 30 * MIN });
  assert.deepEqual([sa.runningMs, sa.idleMs, sa.stalledMs].map((x) => x / MIN), [70, 31, 15]);
  // A session-usage record is accounting, not a sign of life: inside the 90–100 stall it splits nothing, where a note would.
  assert.equal(jobSpeed(done('A', 100), [...a, ev(93, 'session-usage', { turn: 3, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } })])?.stalledMs, 15 * MIN);
  assert.equal(jobSpeed(done('A', 100), [...a, ev(93, 'note', { text: 'here' })])?.stalledMs, 12 * MIN);

  const b = [move(20, side('build'), side('build', 'waiting', 'shelved')), move(50, side('build', 'waiting', 'shelved'), side('build')), move(55, side('build'), side('done', 'done'))];
  const sb = jobSpeed(done('B', 55), b);
  assert.ok(sb);
  assert.deepEqual([sb.runningMs, sb.idleMs, sb.stalledMs].map((x) => x / MIN), [25, 25, 25]);

  assert.equal(jobSpeed(done('C', 55, { state: 'running' }), b), null, 'not done');
  assert.equal(jobSpeed(done('D', null), b), null, 'no finishedAt');
  assert.equal(jobSpeed(done('E', 55, { createdAt: 'garbage' }), b), null, 'unreadable createdAt');

  const figures = speedFigures([sa, sb]);
  assert.deepEqual(figures.stageMinutes, { spec: 10, build: 27.5, review: 30 });
  assert.deepEqual(Object.keys(figures.stageMinutes), ['spec', 'build', 'review'], 'STAGES order');
  assert.deepEqual(Object.keys(figures.waitingMinutes), ['spec-approval', 'shelved'], 'WAITING_ON order, shelved its own key');
  assert.deepEqual([figures.medianHandoffMinutes, figures.stalledMinutes, figures.timedJobs], [28, 20, 2]);

  const none = { median: null, p90: null, n: 0 };
  assert.deepEqual(speedFigures([]), {
    stageMinutes: {},
    waitingMinutes: {},
    medianHandoffMinutes: null,
    stalledMinutes: null,
    handoffSeconds: { withoutCommand: none, withCommand: none },
    minutesPerExtraRound: none,
    timedJobs: 0,
  });
});

test('gaps between agents split by command, and extra rounds', () => {
  const events = [
    // The first run has no gap.
    ...run('planner', 0, 10),
    ...run('spec-writer', 12, 20, 's1'),
    // Overlaps spec-writer: no gap, and both are background.
    ...run('designer', 18, 30),
    ev(32, 'command', { name: 'build', durationMs: 1000 }),
    ...run('builder', 35, 40),
    ...run('verifier', 41, 50),
    ...run('reviewer:code', 55, 58),
    move(60, side('build'), side('build', 'waiting', 'escalation')),
    move(70, side('build', 'waiting', 'escalation'), side('build')),
    // Its gap from 58 crosses the waiting stretch: none.
    ...run('reviewer:docs', 75, 80),
    ev(20, 'round', { round: 1 }),
    ev(30, 'round', { round: 2 }),
    ev(31, 'verdicts', { round: 1 }),
    ev(45, 'verdicts', { round: 2 }),
    ev(48, 'verdicts', { round: 2 }),
    // No verdicts: skipped.
    ev(50, 'round', { round: 3 }),
    ev(51, 'verdicts', { round: 4 }),
    ev(52, 'round', { round: 4 }),
    ev(60, 'verdicts', { round: 4 }),
    move(100, side('build'), side('done', 'done')),
  ];
  const s = jobSpeed(done('G', 100), events);
  assert.ok(s);
  assert.deepEqual(s.gaps, [
    { seconds: 120, withCommand: false },
    { seconds: 300, withCommand: true },
    { seconds: 60, withCommand: false },
    { seconds: 300, withCommand: false },
  ]);
  assert.deepEqual(s.runs.map((r) => r.background), [false, true, true, false, false, false, false]);
  assert.equal(s.runs[1].agentId, 's1');
  assert.deepEqual(s.extraRoundMinutes, [15, 8]);

  const f = speedFigures([s]);
  assert.deepEqual(f.handoffSeconds, { withoutCommand: { median: 120, p90: 300, n: 3 }, withCommand: { median: 300, p90: 300, n: 1 } });
  assert.deepEqual(f.minutesPerExtraRound, { median: 11.5, p90: 15, n: 2 });

  // Nearest rank: the ceil(0.9 n)-th smallest.
  assert.equal(p90([]), null);
  assert.equal(p90([3, 1, 2]), 3);
  assert.equal(p90(Array.from({ length: 10 }, (_, i) => i + 1)), 9);
  assert.equal(p90(Array.from({ length: 20 }, (_, i) => i + 1)), 18);
  assert.deepEqual(spread([1.26, 2.34], 1), { median: 1.8, p90: 2.3, n: 2 });
});
