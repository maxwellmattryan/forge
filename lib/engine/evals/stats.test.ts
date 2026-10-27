// Where a job's wall time went: jobTiming's stage and agent split, which eval results and
// `forge eval compare` read, and the timeline it is built on, which forge stats' speed figures read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { busyMs, jobTiming, timeline } from './stats.ts';
import type { JobEvent } from '#core/types.ts';

const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const ev = (min: number, type: string, more: Record<string, unknown> = {}): JobEvent => ({ v: 1, ts: at(min), type, ...more });
const side = (stage: string, state = 'running', waitingOn: string | null = null) => ({ stage, state, waitingOn }) as JobEvent['from'];

const EVENTS: JobEvent[] = [
  ev(10, 'transition', { from: side('spec'), to: side('build') }),
  ev(12, 'agent-start', { role: 'builder' }),
  ev(30, 'agent-end', { role: 'builder', agentId: 'b1' }),
  ev(40, 'transition', { from: side('build'), to: side('review') }),
  ev(41, 'agent-start', { role: 'reviewer:code', agentId: 'c1' }),
  ev(42, 'agent-start', { role: 'reviewer:security' }),
  ev(50, 'agent-end', { role: 'reviewer:code' }),
  ev(55, 'agent-end', { role: 'reviewer:security', agentId: 's1' }),
  // No end: ignored.
  ev(56, 'agent-start', { role: 'verifier' }),
  { v: 1, ts: 'not a time', type: 'agent-start', role: 'reviewer' },
];

test('jobTiming splits wall time by stage and agent', () => {
  assert.deepEqual(jobTiming(EVENTS, at(0), T0 + 60 * 60_000, 'done'), {
    stages: { spec: 10, build: 30, review: 20 },
    // 18 + 9 + 13, parallel reviewers summed.
    agentMinutes: 40,
    // 60 minus the busy union 12–30 and 41–55.
    orchestratorMinutes: 28,
    reviewerRuns: 2,
  });
  // A run that started before the job counts in full as agent time, clipped as busy time.
  const early = [ev(-5, 'agent-start', { role: 'planner' }), ev(2, 'agent-end', { role: 'planner' })];
  assert.deepEqual(jobTiming(early, at(0), T0 + 10 * 60_000, 'plan'), { stages: { plan: 10 }, agentMinutes: 7, orchestratorMinutes: 8, reviewerRuns: 0 }, 'no transitions: the current stage');
  assert.deepEqual(jobTiming(EVENTS, null, T0, 'done'), { stages: {}, agentMinutes: null, orchestratorMinutes: null, reviewerRuns: 2 }, 'no createdAt');
  assert.deepEqual(jobTiming(EVENTS, 'garbage', T0, 'done'), { stages: {}, agentMinutes: null, orchestratorMinutes: null, reviewerRuns: 2 }, 'unreadable createdAt');
});

test('timeline segments carry state and waitingOn, and runs their agent id', () => {
  const events = [
    ev(5, 'transition', { from: side('spec', 'running'), to: side('spec', 'waiting', 'spec-approval') }),
    ev(20, 'transition', { from: side('spec', 'waiting', 'spec-approval'), to: side('build', 'running') }),
    ev(25, 'transition', { from: 'legacy', to: { stage: 'build' } }),
    ...EVENTS.slice(1, 3),
  ];
  const tl = timeline(events, at(0), T0 + 30 * 60_000, { stage: 'done', state: 'done', waitingOn: null });
  assert.ok(tl);
  assert.deepEqual(
    tl.segments.map((s) => [(s.from - T0) / 60_000, (s.to - T0) / 60_000, s.stage, s.state, s.waitingOn]),
    [
      [0, 5, 'spec', 'running', null],
      [5, 20, 'spec', 'waiting', 'spec-approval'],
      [20, 25, 'build', 'running', null],
      // A side without a string state counts as neither running nor waiting.
      [25, 30, 'build', null, null],
    ],
  );
  assert.deepEqual(tl.runs, [{ role: 'builder', start: T0 + 12 * 60_000, end: T0 + 30 * 60_000, agentId: 'b1' }]);
  const none = timeline([], at(0), T0 + 60_000, { stage: 'build', state: 'running', waitingOn: null });
  assert.deepEqual(none?.segments.map((s) => [s.stage, s.state]), [['build', 'running']], 'no transitions: the current side');
  assert.deepEqual(timeline(EVENTS, 'garbage', T0, { stage: 'done' })?.runs.map((r) => r.agentId) ?? null, null, 'unreadable createdAt');
  // The start's id when the end has none.
  assert.deepEqual(timeline(EVENTS, at(0), T0 + 60 * 60_000, { stage: 'done' })?.runs.map((r) => r.agentId), ['b1', 'c1', 's1']);
  assert.equal(busyMs([[0, 10], [5, 20], [30, 40], [50, 45]], 2, 35), 23, 'the clipped union');
});
