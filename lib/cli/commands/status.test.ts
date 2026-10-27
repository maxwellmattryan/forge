// `forge status` and the stats summary: shelved jobs are set apart, listed last and counted on their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import { jobAt, parkedAt, tempRepo } from '../../../test/helpers.ts';
import { statsFrom } from '#engine/metrics/stats.ts';
import { listJobs } from '#core/job/store.ts';
import { statsSections, statusRows, statusView } from './status.ts';
import { status } from './render/status.ts';

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

test('the stats jobs line names shelved', () => {
  const s = statsFrom([]);
  assert.match(statsSections({ ...s, counts: { ...s.counts, active: 3, waiting: 1, shelved: 2 } }).jobs[0], /\(active 3, done 0, waiting 1, shelved 2, cancelled 0\)$/);
  const { shelved: _, ...older } = s.counts;
  assert.match(statsSections({ ...s, counts: older }).jobs[0], /waiting 0, shelved 0, cancelled 0\)$/, 'an older stats.json reads as 0');
});
