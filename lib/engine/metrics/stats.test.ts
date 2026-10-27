import test from 'node:test';
import assert from 'node:assert/strict';
import { statsFrom } from './stats.ts';
import type { StatsSource } from './stats.ts';
import { normalizeJob } from '#core/job/schema.ts';
import type { JobEvent, JobUsage } from '#core/types.ts';
import type { JobFindings } from '#core/job/types.ts';

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

type Lens = JobFindings['byLens'][string];
const lens = (more: Partial<Lens> = {}): Lens => ({ raised: 0, fixed: 0, disputed: 0, recurring: 0, ...more });
/** A reviewed job: its verdicts by round, and its findings record. */
const reviewed = (id: string, verdicts: Record<number, Record<string, string>>, byLens: JobFindings['byLens'] = {}, totals: Partial<JobFindings['totals']> = {}, archived = false): StatsSource => ({
  job: normalizeJob({ id, verdicts }),
  events: () => [],
  findings: () => ({ rounds: [], byLens, totals: { raised: 0, fixed: 0, disputed: 0, recurring: 0, ...totals }, recurring: [], disputed: [] }),
  archived,
});

test('per-lens review figures: blockers, sole CHANGES and reopens, narrowed and archived', () => {
  const live = reviewed(
    'live',
    { 1: { code: 'PASS', security: 'CHANGES' }, 2: { security: 'CHANGES', docs: 'CHANGES' }, 3: { security: 'PASS' } },
    { security: lens({ raised: 3, severity: { blocker: 2, major: 1, minor: 0, nit: 0 } }), docs: lens({ raised: 1, severity: { blocker: 0, major: 0, minor: 1, nit: 0 } }) },
    { carried: 3, new: 1 },
  );
  const s = statsFrom([live]).reviewers;
  assert.deepEqual([s.security.blockers, s.security.soleChanges, s.docs.soleChanges, s.code.soleChanges], [2, 1, 0, 0]);
  assert.deepEqual([s.security.reopened, s.docs.reopened], [0, 0], 'CHANGES after CHANGES, or after no verdict, is no reopen');

  // Round 2 ran only security (review.onRework: narrow): code's previous verdict is round 1's PASS.
  const narrowed = { 1: { code: 'PASS', security: 'CHANGES' }, 2: { security: 'PASS' }, 3: { security: 'CHANGES', code: 'CHANGES' } };
  const n = statsFrom([reviewed('narrowed', narrowed)]).reviewers;
  assert.deepEqual([n.code.reopened, n.security.reopened, n.security.soleChanges, n.code.soleChanges], [1, 1, 1, 0]);

  // An archived record's verdicts count the same; its findings carry no severity and no carried/new.
  const archived = reviewed('archived', narrowed, { security: lens({ raised: 4 }) }, {}, true);
  const all = statsFrom([live, reviewed('narrowed', narrowed), archived]);
  assert.deepEqual([all.reviewers.security.blockers, all.reviewers.security.soleChanges, all.reviewers.security.reopened, all.reviewers.code.reopened], [2, 3, 2, 2]);
  assert.deepEqual([all.quality.findingsCarried, all.quality.findingsNew], [3, 1]);
  assert.equal(all.counts.archived, 1);

  const empty = statsFrom([]);
  assert.deepEqual([empty.quality.findingsCarried, empty.quality.findingsNew, empty.speed.timedJobs, empty.speed.medianHandoffMinutes], [0, 0, 0, null]);
  assert.deepEqual([empty.speed.stageMinutes, empty.speed.waitingMinutes], [{}, {}]);
});

test('cacheReadShare per role', () => {
  const bucket = (input: unknown, cacheRead: unknown, cacheWrite: unknown) => ({ tokens: 1, input, output: 0, cacheRead, cacheWrite, toolUses: 0, durationMs: 0, runs: 1, estCostUsd: 0 });
  const withUsage = (id: string, byRole: Record<string, unknown>): StatsSource => {
    const src = source(id, []);
    src.job.usage = { ...src.job.usage, byRole: byRole as JobUsage['byRole'], byModel: { 'claude-x': bucket(1, 1, 1) as JobUsage['byModel'][string] } };
    return src;
  };
  const s = statsFrom([
    withUsage('a', { builder: bucket(100, 800, 100), reviewer: bucket(0, 0, 0) }),
    // A field that is not a number reads as 0.
    withUsage('b', { builder: bucket(50, 'x', 50) }),
  ]);
  assert.equal(s.cost.byRole.builder.cacheReadShare, 0.727);
  assert.equal(s.cost.byRole.reviewer.cacheReadShare, null, 'null at 0');
  assert.ok(!('cacheReadShare' in s.cost.byModel['claude-x']), 'byRole rows only');
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
