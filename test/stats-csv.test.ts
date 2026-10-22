import test from 'node:test';
import assert from 'node:assert/strict';
import { forgeAsync, forgeInProcess } from './helpers.ts';
import { createJob, setJob } from '../lib/jobs.ts';
import { statsCsv } from '../lib/stats.ts';
import { parseArgs } from '../lib/commands/args.ts';
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
    const lines = (text: string) => {
      assert.ok(text.endsWith('\r\n'), 'CRLF line ends');
      assert.ok(!/[^\r]\n/.test(text), 'every line ends in CRLF');
      return text.split('\r\n').slice(0, -1);
    };
    const csv = (...args: string[]) => lines(statsCsv(s.root, s.config, parseArgs(['stats', '--csv', ...args]).flags));

    // The one spawn: routing, the exit code and what reaches stdout.
    const r = await forgeAsync(s.root, ['stats', '--csv']);
    assert.equal(r.status, 0, r.stderr);
    const cliRows = lines(r.stdout);
    assert.equal(cliRows[0], 'job,kind,title,runs,tokens,input,output,cache_read,cache_write,usd');
    assert.equal(cliRows.find((l) => l.startsWith(a.id + ',')), `${a.id},feature,"'=HYPERLINK(""x"")",2,3.5,3.5,0,0,0,3.5000`, 'a formula title is quoted and starts with an apostrophe');

    const byJob = csv();
    assert.deepEqual(byJob, cliRows, 'the function is what the CLI prints');
    assert.ok(byJob.some((l) => l.startsWith(`${ev.id},eval,`)), 'eval jobs count');
    assert.deepEqual(byJob.slice(1).map((l) => l.split(',')[0]), byJob.slice(1).map((l) => l.split(',')[0]).sort(), 'rows sort by key');

    assert.deepEqual(csv('--by', 'role'), ['role,runs,tokens,input,output,cache_read,cache_write,usd', 'builder,2,1.75,1.75,0,0,0,1.7500', 'planner,1,3,3,0,0,0,3.0000', 'reviewer:code,1,2,2,0,0,0,2.0000']);
    assert.deepEqual(csv('--by', 'model'), ['model,runs,tokens,input,output,cache_read,cache_write,usd', 'usd-model,4,6.75,6.75,0,0,0,6.7500']);
    assert.deepEqual(csv('--by', 'day'), ['day,runs,tokens,input,output,cache_read,cache_write,usd', `${iso(1).slice(0, 10)},4,6.75,6.75,0,0,0,6.7500`]);
    assert.deepEqual(csv('--by', 'role', '--since', iso(1, 12)), ['role,runs,tokens,input,output,cache_read,cache_write,usd', 'reviewer:code,1,2,2,0,0,0,2.0000'], '--since filters by event time');
    assert.deepEqual(csv('--include-evals', '--by', 'model'), csv('--by', 'model'), '--include-evals changes nothing');

    const budget = (await forgeInProcess(s.root, ['budget'])).data as any;
    const total = csv('--by', 'day').slice(1).reduce((n, l) => n + Number(l.split(',').at(-1)), 0);
    assert.equal(total, budget.spent.monthUsd, "the usd sum matches forge budget's month spend");

    for (const args of [['--csv', '--json'], ['--by', 'role'], ['--csv', '--by', 'week'], ['--csv', '--since', 'yesterday']]) {
      const res = await forgeInProcess(s.root, ['stats', ...args]);
      assert.deepEqual({ status: res.status, code: res.error?.code }, { status: 2, code: 'usage' }, `${args.join(' ')} exits 2`);
    }
  } finally {
    s.cleanup();
  }
});
