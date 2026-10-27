import test from 'node:test';
import assert from 'node:assert/strict';
import { statsFrom } from './stats.ts';
import type { StatsSource } from './stats.ts';
import { normalizeJob } from '#core/job/schema.ts';
import type { JobEvent } from '#core/types.ts';

/** A `verifiers` record event for round `round`. */
const record = (round: number, outcome: 'PASS' | 'CHANGES', results: unknown[]): JobEvent => ({
  v: 1,
  ts: '2026-10-01T10:00:00.000Z',
  type: 'verifiers',
  phase: 'record',
  round,
  outcome,
  results,
});
const RESULTS = [{ name: 'cli-help', mode: 'block', answer: 'no' }];

/** A job with no verdicts, so stats never reads its findings. */
const source = (id: string, events: JobEvent[], job: Record<string, unknown> = {}): StatsSource => ({
  job: normalizeJob({ id, ...job }),
  events: () => events,
  findings: () => {
    throw new Error('a job without verdicts has no findings to read');
  },
  archived: false,
});

test("verifierFirstRoundBlockRate counts each job's first round-1 verifiers record", () => {
  assert.equal(statsFrom([]).quality.verifierFirstRoundBlockRate, null, 'no jobs');
  const five = [
    source('blocked', [record(1, 'CHANGES', RESULTS)]),
    source('passed', [record(1, 'PASS', [{ name: 'cli-help', mode: 'block', answer: 'yes' }])]),
    source('no-results', [record(1, 'PASS', [])]),
    source('round-2-only', [record(2, 'CHANGES', RESULTS)]),
    source('rerun', [record(1, 'PASS', RESULTS), record(1, 'CHANGES', RESULTS), record(2, 'CHANGES', RESULTS)]),
  ];
  assert.equal(statsFrom(five).quality.verifierFirstRoundBlockRate, 0.333, '1 blocked of 3 counted');
  assert.equal(statsFrom([five[0]]).quality.verifierFirstRoundBlockRate, 1);
  assert.equal(statsFrom([five[2], five[3]]).quality.verifierFirstRoundBlockRate, null, 'no job counts');
});

test('a shelved job counts as shelved, not waiting', () => {
  const s = statsFrom([
    source('shelved', [], { state: 'waiting', waitingOn: 'shelved' }),
    source('escalated', [], { state: 'waiting', waitingOn: 'escalation' }),
    source('queued', [], { state: 'queued' }),
  ]);
  assert.deepEqual([s.counts.active, s.counts.waiting, s.counts.shelved], [3, 1, 1]);
  assert.deepEqual(s.waitingOn, { escalation: 1 });
});
