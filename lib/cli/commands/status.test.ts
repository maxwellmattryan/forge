// `forge status` and the stats summary: shelved jobs are set apart, listed last and counted on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, parkedAt, tempRepo } from '../../../test/helpers.ts';
import { statsFrom } from '#engine/metrics/stats.ts';
import { listJobs } from '#core/job/store.ts';
import { statsSections, statusRows, statusView } from './status.ts';
import { stats as renderStats, status } from './render/status.ts';
import type { Stats } from '#core/types.ts';

test('shelved jobs come last and read as shelved', () => {
  const repo = tempRepo();
  try {
    const escalated = parkedAt(repo.dir, 'escalation', { reason: 'touches billing' }).id;
    const queued = jobAt(repo.dir, 'build', { state: 'queued' }).id;
    // The newest, so listJobs puts it first.
    const shelved = parkedAt(repo.dir, 'shelved').id;
    const rows = statusRows(repo.dir, false);
    const others = listJobs(repo.dir).map((j) => j.id).filter((id) => id !== shelved);
    assert.deepEqual(others.sort(), [escalated, queued].sort());
    assert.deepEqual(rows.map((r) => r.id), [...others, shelved], "listJobs' order, shelved last");
    assert.deepEqual(rows.map((r) => r.shelved?.reason ?? null), [null, null, 'set aside']);
    assert.ok(rows[2].shelved?.at);
    const view = statusView(repo.dir, false);
    assert.equal(view[2].reason, 'shelved: set aside');
    const lines = (status(view, { color: false, now: Date.now() }) ?? '').split('\n');
    const line = lines.find((l) => l.startsWith(shelved)) ?? '';
    assert.match(line, /\bshelved\b/, line);
    assert.ok(!line.includes('waiting:shelved'), line);
    assert.ok(lines.find((l) => l.startsWith(escalated))?.includes('waiting:escalation'));
  } finally {
    repo.cleanup();
  }
});

test('the stats summary reads an older stats object without the review and timing figures', () => {
  const s = statsFrom([]);
  const lens = { reviews: 2, changes: 1, blockers: 3, soleChanges: 1, reopened: 1, changeRate: 0.5, disputeRate: null, missRate: null } as Stats['reviewers'][string];
  const full = statsSections({
    ...s,
    quality: { ...s.quality, findingsCarried: 4, findingsNew: 2 },
    speed: {
      ...s.speed,
      stageMinutes: { spec: 4.1, build: 22.5 },
      waitingMinutes: { 'spec-approval': 41 },
      medianHandoffMinutes: 3.5,
      stalledMinutes: 0,
      handoffSeconds: { withoutCommand: { median: 12, p90: 40, n: 9 }, withCommand: { median: null, p90: null, n: 0 } },
      minutesPerExtraRound: { median: 18, p90: 30, n: 4 },
      timedJobs: 7,
    },
    cost: {
      ...s.cost,
      byRole: { builder: { tokens: 1, estCostUsd: 0, runs: 1, cacheReadShare: 0.912 }, reviewer: { tokens: 1, estCostUsd: 0, runs: 1, cacheReadShare: null } },
      orchestrator: {
        tokens: 30,
        estCostUsd: 1.75,
        turns: 6,
        byLane: { job: { tokens: 10, estCostUsd: 1.25, turns: 4 }, inbox: { tokens: 10, estCostUsd: 0.3, turns: 1 }, office: { tokens: 10, estCostUsd: 0.2, turns: 1 } },
        coverage: { jobs: 5, withUsage: 3, agentUsd: 9 },
      },
    },
    reviewers: { security: lens },
  });
  const text = [...full.quality, ...full.speed, ...full.cost].join('\n');
  for (const want of [
    'orchestrator $1.75 (job $1.25 · inbox $0.3 · office $0.2) · 6 turns · session usage on 3/5 jobs',
    'rounds 2+ findings carried 4, new 2',
    'working minutes by stage (median over 7 done jobs) spec 4.1 · build 22.5',
    'parked minutes (median) spec-approval 41',
    'between agents 3.5 min/job · stalled 0 min/job · agent gaps 12s (p90 40s, n 9) without a command, — with one',
    'agent start — foreground, — background · extra round 18 min (p90 30)',
    'cache-read share builder 91%',
  ])
    assert.ok(text.includes(want), want);
  assert.equal(full.reviewers[0][1], '50% changes, 3 blockers, sole 1, reopened 1, — disputed, — missed');

  const { stageMinutes: _1, waitingMinutes: _2, medianHandoffMinutes: _3, stalledMinutes: _4, handoffSeconds: _5, agentStartSeconds: _6, minutesPerExtraRound: _7, timedJobs: _8, ...speed } = s.speed;
  const { findingsCarried: _9, findingsNew: _10, ...quality } = s.quality;
  const { soleChanges: _11, reopened: _12, ...olderLens } = lens;
  const { orchestrator: _13, ...olderCost } = s.cost;
  const olderStats = { ...s, quality, speed, reviewers: { security: olderLens }, cost: { ...olderCost, byRole: { builder: { tokens: 1, estCostUsd: 0, runs: 1 } } } } as unknown as Stats;
  assert.match(renderStats(olderStats, { color: false, now: Date.now() }) ?? '', /Speed/, 'the human renderer');
  const older = statsSections(olderStats);
  const olderText = [...older.quality, ...older.speed, ...older.cost].join('\n');
  for (const want of ['findings carried 0, new 0', 'by stage (median over 0 done jobs) —', 'parked minutes (median) —', 'between agents — min/job · stalled — min/job · agent gaps — without a command, — with one', 'extra round —'])
    assert.ok(olderText.includes(want), want);
  assert.ok(!olderText.includes('cache-read share'), 'no share, no line');
  assert.ok(!olderText.includes('orchestrator'), 'no orchestrator figure, no line');
  assert.match(older.reviewers[0][1], /3 blockers, sole 0, reopened 0/);
});

test('the stats jobs line names shelved', () => {
  const s = statsFrom([]);
  assert.match(statsSections({ ...s, counts: { ...s.counts, active: 3, waiting: 1, shelved: 2 } }).jobs[0], /\(active 3, done 0, waiting 1, shelved 2, cancelled 0\)$/);
  const { shelved: _, ...older } = s.counts;
  assert.match(statsSections({ ...s, counts: older }).jobs[0], /waiting 0, shelved 0, cancelled 0\)$/, 'an older stats.json reads as 0');
});
