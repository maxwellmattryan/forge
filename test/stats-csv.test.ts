import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeAsync } from './helpers.ts';
import { createJob, setJob } from '../lib/jobs.ts';
import { budgetRepo, spend } from './repo-budget-fixture.ts';

test('forge stats --csv', async () => {
  const s = budgetRepo({});
  try {
    const now = new Date();
    const iso = (d: number, h = 12) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), d, h)).toISOString();
    const a = createJob(s.root, s.config, { title: '=HYPERLINK("x")' });
    const ev = createJob(s.root, s.config, { title: 'Eval run', kind: 'eval' });
    setJob(s.root, ev.id, { stage: 'done', state: 'done' });
    spend(s.root, a.id, 1.5, iso(1, 9), 'builder');
    spend(s.root, a.id, 2, iso(1, 15), 'reviewer:code');
    spend(s.root, ev.id, 0.25, iso(1, 10), 'builder');
    spend(s.root, s.spender, 3, iso(1, 11), 'planner');
    const csv = async (...args: string[]) => {
      const r = await forgeAsync(s.root, ['stats', '--csv', ...args]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.endsWith('\r\n'), 'CRLF line ends');
      assert.ok(!/[^\r]\n/.test(r.stdout), 'every line ends in CRLF');
      return r.stdout.split('\r\n').slice(0, -1);
    };

    const byJob = await csv();
    assert.equal(byJob[0], 'job,kind,title,runs,tokens,input,output,cache_read,cache_write,usd');
    const rowA = byJob.find((l) => l.startsWith(a.id + ','));
    assert.equal(rowA, `${a.id},feature,"'=HYPERLINK(""x"")",2,3.5,3.5,0,0,0,3.5000`, 'a formula title is quoted and starts with an apostrophe');
    assert.ok(byJob.some((l) => l.startsWith(`${ev.id},eval,`)), 'eval jobs count');
    assert.deepEqual(byJob.slice(1).map((l) => l.split(',')[0]), byJob.slice(1).map((l) => l.split(',')[0]).sort(), 'rows sort by key');

    assert.deepEqual(await csv('--by', 'role'), ['role,runs,tokens,input,output,cache_read,cache_write,usd', 'builder,2,1.75,1.75,0,0,0,1.7500', 'planner,1,3,3,0,0,0,3.0000', 'reviewer:code,1,2,2,0,0,0,2.0000']);
    assert.deepEqual(await csv('--by', 'model'), ['model,runs,tokens,input,output,cache_read,cache_write,usd', 'usd-model,4,6.75,6.75,0,0,0,6.7500']);
    assert.deepEqual(await csv('--by', 'day'), ['day,runs,tokens,input,output,cache_read,cache_write,usd', `${iso(1).slice(0, 10)},4,6.75,6.75,0,0,0,6.7500`]);
    assert.deepEqual(await csv('--by', 'role', '--since', iso(1, 12)), ['role,runs,tokens,input,output,cache_read,cache_write,usd', 'reviewer:code,1,2,2,0,0,0,2.0000'], '--since filters by event time');
    assert.deepEqual(await csv('--include-evals', '--by', 'model'), await csv('--by', 'model'), '--include-evals changes nothing');

    const budget = JSON.parse((await forgeAsync(s.root, ['budget'])).stdout);
    const total = (await csv('--by', 'day')).slice(1).reduce((n, l) => n + Number(l.split(',').at(-1)), 0);
    assert.equal(total, budget.spent.monthUsd, "the usd sum matches forge budget's month spend");

    for (const args of [['--csv', '--json'], ['--by', 'role'], ['--csv', '--by', 'week'], ['--csv', '--since', 'yesterday']]) {
      const r = await forgeAsync(s.root, ['stats', ...args]);
      assert.equal(r.status, 2, `${args.join(' ')} exits 2`);
    }
  } finally {
    s.cleanup();
  }
});
