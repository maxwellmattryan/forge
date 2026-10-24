// spendLedger reads each job's CLI copy of events.jsonl, never the job folder's mirror.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir, logEvent } from '#core/job/store.ts';
import { spendLedger } from './spend.ts';

test('repo spend reads the CLI copy', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const config = defaults();
  // $1 per input token, so a run's input is its cost.
  config.usage.pricing = { models: { 'usd-model': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } } };
  const job = createJob(r.dir, config, { title: 'spender' });
  const run = (usd: number) => ({ role: 'builder', model: 'usd-model', usage: { input: usd, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: usd } });
  logEvent(r.dir, job.id, 'agent-end', run(3));
  fs.appendFileSync(path.join(jobDir(r.dir, job.id), 'events.jsonl'), `${JSON.stringify({ v: 2, ts: new Date().toISOString(), type: 'agent-end', ...run(500) })}\n`);
  const { buckets } = spendLedger(r.dir, config, { write: false })[job.id];
  assert.deepEqual(
    Object.values(buckets).reduce((n, b) => ({ runs: n.runs + b.runs, usd: n.usd + b.usd }), { runs: 0, usd: 0 }),
    { runs: 1, usd: 3 },
  );
});
