// dailyTotals buckets a repo's shipped jobs (live and archived) and its ledger cost by UTC day over a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { jobAt, tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { EVENT_SCHEMA_VERSION } from '#core/job/schema.ts';
import { listJobs } from '#core/job/store.ts';
import { jobFiles } from '#core/paths.ts';
import { archiveJob } from '../ops/retention.ts';
import { appendMeter } from './meter.ts';
import { dailyTotals } from './daily.ts';
import { periodTotals, spendLedger } from './spend.ts';

/** $1 per input token, so a run's input is its cost. */
function usdConfig() {
  const config = defaults();
  config.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  return config;
}

const AT = Date.parse('2026-10-20T12:00:00.000Z');

test('dailyTotals buckets shipped jobs and cost by UTC day', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const root = r.dir;
  const config = usdConfig();
  const done = (title: string, finishedAt: string, o: { kind?: string; state?: 'done' | 'cancelled' } = {}) =>
    jobAt(root, 'done', { config, title, state: o.state ?? 'done', create: o.kind ? { kind: o.kind } : {}, fields: { finishedAt } }).id;

  const shipped = done('shipped yesterday', '2026-10-19T10:00:00.000Z');
  const archived = done('shipped today, archived', '2026-10-20T01:00:00.000Z');
  done('an eval', '2026-10-19T10:00:00.000Z', { kind: 'eval' });
  done('cancelled', '2026-10-19T10:00:00.000Z', { state: 'cancelled' });
  done('before the window', '2026-10-01T10:00:00.000Z');
  archiveJob(root, archived, 'cli', { config });
  assert.ok(!listJobs(root).some((j) => j.id === archived), 'archived, not live');

  // Reported: $3 on the 18th from the shipped job. Metered: the office's $5 on the 20th, and $9 before the window.
  const e = { v: EVENT_SCHEMA_VERSION, ts: '2026-10-18T09:00:00.000Z', type: 'agent-end', role: 'builder', model: 'usd-model', usage: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 3 } };
  for (const file of jobFiles(root, shipped, 'events.jsonl')) fs.appendFileSync(file, JSON.stringify(e) + '\n');
  const meter = (ts: string, usd: number) => {
    const models = { 'usd-model': { usd, input: usd, output: 0, cacheRead: 0, cacheWrite: 0 } };
    appendMeter(root, { v: 1, ts, scope: '_office', sessionId: null, spawnId: 's', turn: 1, usd, tokens: usd, models, cum: { usd, models } });
  };
  meter('2026-10-20T10:00:00.000Z', 5);
  meter('2026-10-02T10:00:00.000Z', 9);

  const got = dailyTotals(root, config, { days: 7, at: AT });
  assert.deepEqual(got.days, ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']);
  assert.deepEqual(got.shipped, [0, 0, 0, 0, 0, 1, 1], 'the live one on the 19th, the archived one on the 20th');
  assert.deepEqual(got.costUsd, [0, 0, 0, 0, 3, 0, 5]);
  const period = periodTotals(spendLedger(root, config, { write: false }), AT);
  assert.deepEqual([got.dayUsd, got.monthUsd], [period.dayUsd, period.monthUsd]);
  assert.deepEqual([got.dayUsd, got.monthUsd], [5, 17]);
});
