// The supervisor's meter in-process: deltas per spawn against claude's cumulative cost, and the meter file's
// writer and tolerant reader. Every time is passed explicitly, so no row reads the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { appendMeter, lastMeterAt, lastMeterCum, meterDelta, meterFile, meterTodayUsd, readMeter } from './meter.ts';
import type { MeterCum, MeterRecord } from './meter.ts';
import type { ModelCost, SessionCost } from '#integrations/claude/types.ts';

const m = (usd: number, tokens = 0): ModelCost => ({ usd, input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 });
const cost = (usd: number | null, models: Record<string, ModelCost> = {}): SessionCost => ({ usd, models });
const cum = (usd: number, models: Record<string, ModelCost> = {}): MeterCum => ({ usd, models });

test('meter deltas are taken per spawn from claude\'s cumulative cost', () => {
  const rows: { name: string; base: MeterCum | null; cost: SessionCost; usd: number; tokens?: number; models?: Record<string, ModelCost>; flags?: Record<string, true> }[] = [
    { name: 'a fresh spawn', base: cum(0), cost: cost(1), usd: 1 },
    { name: 'a later result', base: cum(1), cost: cost(2.5), usd: 1.5 },
    { name: 'a reset', base: cum(3, { a: m(3, 30) }), cost: cost(0.4, { a: m(0.4, 4) }), usd: 0.4, tokens: 4, models: { a: m(0.4, 4) }, flags: { reset: true } },
    { name: 'an unknown baseline rebases', base: null, cost: cost(9, { a: m(9, 90) }), usd: 0, tokens: 0, models: {}, flags: { rebased: true } },
    { name: 'a model new since the base counts in full', base: cum(1, { a: m(1, 10) }), cost: cost(3, { a: m(1, 10), b: m(2, 20) }), usd: 2, tokens: 20, models: { a: m(0, 0), b: m(2, 20) } },
    { name: 'a model whose count fell clamps to 0', base: cum(1, { a: m(1, 10) }), cost: cost(1.5, { a: { usd: 1.5, input: 5, output: 7, cacheRead: 0, cacheWrite: 0 } }), usd: 0.5, tokens: 7, models: { a: { usd: 0.5, input: 0, output: 7, cacheRead: 0, cacheWrite: 0 } } },
    { name: 'tokens sum every count', base: cum(0), cost: cost(1, { a: { usd: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, b: m(0, 10) }), usd: 1, tokens: 20 },
    { name: 'no total: the models\' sum', base: cum(1, { a: m(1) }), cost: cost(null, { a: m(1.25), b: m(0.5) }), usd: 0.75 },
  ];
  for (const row of rows) {
    const d = meterDelta(row.base, row.cost);
    assert.equal(d.usd, row.usd, row.name);
    if (row.tokens !== undefined) assert.equal(d.tokens, row.tokens, row.name);
    if (row.models) assert.deepEqual(d.models, row.models, row.name);
    assert.deepEqual({ rebased: d.rebased, reset: d.reset }, { rebased: undefined, reset: undefined, ...row.flags }, row.name);
  }
  // The rebased record becomes the baseline: the next result is measured from it.
  const rebased = meterDelta(null, cost(9));
  assert.equal(meterDelta(rebased.cum, cost(10.5)).usd, 1.5);
  assert.deepEqual(meterDelta(null, cost(null, { a: m(1), b: m(2) })).cum.usd, 3, 'cum.usd is the models\' sum without a total');
});

/** A valid record of `scope` at `ts` with `usd`. */
const rec = (scope: string, ts: string, usd: number, sessionId: string | null = 's1'): MeterRecord => ({
  v: 1,
  ts,
  scope,
  sessionId,
  spawnId: 'p1',
  turn: 1,
  ...meterDelta(cum(0), cost(usd, { a: m(usd, 1) })),
  cum: cum(usd + 100, { a: m(usd + 100, 1) }),
});

test('the meter file is the supervisor\'s, read tolerantly', (t) => {
  const r = tempRepo();
  t.after(r.cleanup);
  const root = r.dir;
  appendMeter(root, rec('_office', '2026-10-23T23:59:00.000Z', 1));
  appendMeter(root, rec('_office', '2026-10-24T00:01:00.000Z', 2));
  const file = meterFile(root, '_office');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).v, 1);

  const good = rec('_office', '2026-10-24T05:00:00.000Z', 4, 's2');
  const junk = [
    'not json',
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, scope: '_inbox' }),
    JSON.stringify({ ...good, usd: -1 }),
    JSON.stringify({ ...good, tokens: 'many' }),
    JSON.stringify({ ...good, models: { a: { ...m(1), input: -3 } } }),
    JSON.stringify({ ...good, cum: { usd: null, models: {} } }),
    JSON.stringify({ ...good, ts: 'yesterday' }),
  ];
  fs.appendFileSync(file, junk.join('\n') + '\n' + JSON.stringify(good) + '\n');
  const records = readMeter(root, '_office');
  assert.deepEqual(records.map((x) => x.usd), [1, 2, 4], 'only valid records of this scope');

  assert.equal(meterTodayUsd(records, Date.parse('2026-10-24T12:00:00.000Z')), 6, 'the UTC day of at');
  assert.equal(meterTodayUsd(records, Date.parse('2026-10-23T12:00:00.000Z')), 1);
  assert.deepEqual(lastMeterCum(records, 's1'), rec('_office', '2026-10-24T00:01:00.000Z', 2).cum);
  assert.deepEqual(lastMeterCum(records, 's2')?.usd, 104);
  assert.equal(lastMeterCum(records, 'other'), null);
  assert.equal(lastMeterCum(records, null), null);
  assert.equal(lastMeterAt(records), '2026-10-24T05:00:00.000Z');
  assert.equal(lastMeterAt([]), null);
  assert.deepEqual(readMeter(root, 'no-such-job'), [], 'a missing file');

  assert.throws(() => readMeter(root, '../x'), /invalid meter scope/);
  assert.throws(() => appendMeter(root, rec('../x', '2026-10-24T00:00:00.000Z', 1)), /invalid meter scope/);
  assert.equal(fs.existsSync(path.join(root, '.forge', 'runtime', 'x.jsonl')), false);

  if (process.platform !== 'win32') {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, meterFile(root, 'linked'));
    assert.throws(() => appendMeter(root, rec('linked', '2026-10-24T00:00:00.000Z', 1)));
    assert.deepEqual(readMeter(root, 'linked'), []);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n', 'the link target is unchanged');
  }
});
