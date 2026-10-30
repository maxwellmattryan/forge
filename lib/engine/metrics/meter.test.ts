// The supervisor's meter in-process: deltas per spawn against claude's cumulative cost, and the meter file's
// writer and tolerant reader; and the session-usage ledger beside it (its validator, the inbox's and office's file,
// a lane's pricing). Every time is passed explicitly, so no row reads the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { estimateCost } from '#integrations/claude/pricing.ts';
import {
  SESSION_USAGE_VERSION,
  appendMeter,
  appendSessionUsage,
  laneOf,
  lastMeterAt,
  lastMeterCum,
  meterDelta,
  meterFile,
  meterTodayUsd,
  readMeter,
  readMeterChecked,
  readSessionUsage,
  sessionUsageFile,
  sessionUsageOf,
  sessionUsagePayload,
} from './meter.ts';
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
  assert.deepEqual(readMeterChecked(root, 'no-such-job'), { records: [], problem: null }, 'missing is no records, not a problem');
  assert.deepEqual(readMeterChecked(root, '_office'), { records, problem: null });

  assert.throws(() => readMeter(root, '../x'), /invalid meter scope/);
  assert.throws(() => appendMeter(root, rec('../x', '2026-10-24T00:00:00.000Z', 1)), /invalid meter scope/);
  assert.equal(fs.existsSync(path.join(root, '.forge', 'runtime', 'x.jsonl')), false);

  // Oversized: not read, and said so (sparse, so the test writes nothing).
  fs.truncateSync(meterFile(root, '_office'), 64 * 1024 * 1024 + 1);
  assert.deepEqual(readMeter(root, '_office'), []);
  assert.match(readMeterChecked(root, '_office').problem ?? '', /_office\.jsonl is over 64 MiB$/);

  if (process.platform !== 'win32') {
    const target = path.join(root, 'target.txt');
    fs.writeFileSync(target, 'keep\n');
    fs.symlinkSync(target, meterFile(root, 'linked'));
    assert.throws(() => appendMeter(root, rec('linked', '2026-10-24T00:00:00.000Z', 1)));
    assert.deepEqual(readMeter(root, 'linked'), []);
    assert.match(readMeterChecked(root, 'linked').problem ?? '', /linked\.jsonl can't be read \(ELOOP\)$/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep\n', 'the link target is unchanged');
  }

  const meterDir = path.dirname(meterFile(root, '_office'));
  fs.rmSync(meterDir, { recursive: true });
  fs.writeFileSync(meterDir, '');
  assert.deepEqual(readMeterChecked(root, '_office'), { records: [], problem: `${meterDir} is not a directory` });
});

const scratch = (t: { after: (fn: () => void) => void }): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-usage-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const TS = '2026-10-20T10:00:00.000Z';
const usage = { input: 10, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 370 };
const usageLine = (o: Record<string, unknown>) => JSON.stringify({ v: SESSION_USAGE_VERSION, ts: TS, scope: '_inbox', session: null, turn: 1, model: 'claude-opus-5-5', usage, numTurns: 2, durationMs: 100, ok: true, ...o });

test('the session-usage ledger is read tolerantly and never through a link', (t) => {
  // The validator: a job event or a runtime line, normalised; totalTokens is always the counts' sum.
  const good = { model: 'claude-opus-5-5', input: 10, output: 20, cacheRead: 300, cacheWrite: 40, totalTokens: 370, ts: TS };
  assert.deepEqual(sessionUsageOf({ type: 'session-usage', ts: TS, model: 'claude-opus-5-5', usage: { ...usage, totalTokens: 1e12 } }), good);
  assert.deepEqual(sessionUsageOf({ ts: TS, model: '__proto__', usage }), { ...good, model: null }, 'an unusable model reads null');
  for (const [name, e] of [
    ['another event type', { type: 'agent-end', ts: TS, usage }],
    ['a bad ts', { ts: 'yesterday', usage }],
    ['no usage', { ts: TS }],
    ['a negative count', { ts: TS, usage: { ...usage, input: -1 } }],
    ['a string count', { ts: TS, usage: { ...usage, output: '20' } }],
    ['a non-finite count', { ts: TS, usage: { ...usage, cacheRead: Infinity } }],
  ] as const)
    assert.equal(sessionUsageOf(e), null, name);

  // Only the inbox and office have a runtime file: no other scope ever names a path.
  const root = scratch(t);
  for (const scope of ['_inbox', '_office']) assert.equal(sessionUsageFile(root, scope), path.join(root, '.forge', 'runtime', 'session-usage', `${scope}.jsonl`));
  for (const scope of ['job-1', '_gates', '_chat-0123456789ab', '../_inbox', '_inbox/../x', '']) assert.throws(() => sessionUsageFile(root, scope), /invalid session-usage scope/, scope);

  // Lines that break the record rules are dropped; the rest read in order.
  const payload = sessionUsagePayload({ model: 'claude-opus-5-5', input: 10, output: 20, cacheRead: 300, cacheWrite: 40, numTurns: 2, durationMs: 100 }, null, 1, true);
  assert.deepEqual(payload.usage, usage);
  appendSessionUsage(root, '_inbox', payload);
  fs.appendFileSync(
    sessionUsageFile(root, '_inbox'),
    [
      usageLine({ v: 99 }),
      usageLine({ scope: '_office' }),
      usageLine({ ts: 'never' }),
      usageLine({ usage: { ...usage, input: -5 } }),
      '{"v":1,"ts":"2026-10-20T10:00:00.000Z","scope":"_inbox","usage":{"input":1e400,"output":0,"cacheRead":0,"cacheWrite":0}}',
      'not json',
      '',
      usageLine({ ts: '2026-10-21T10:00:00.000Z', model: 'claude-sonnet-5-5' }),
    ].join('\n') + '\n',
  );
  const read = readSessionUsage(root, '_inbox');
  assert.deepEqual(read.map((r) => r.model), ['claude-opus-5-5', 'claude-sonnet-5-5']);
  assert.equal(readSessionUsage(root, '_office').length, 0, 'a missing file has no records');

  // A lane prices each record with today's table and honours `since`.
  const priced = (model: string) => estimateCost({ model, ...usage }).usd;
  assert.deepEqual(laneOf(read, undefined, null), { tokens: 740, estCostUsd: Math.round((priced('claude-opus-5-5') + priced('claude-sonnet-5-5')) * 1e4) / 1e4, turns: 2 });
  assert.equal(laneOf([read[1], { ...read[1], ts: '2026-10-19T10:00:00.000Z' }], undefined, Date.parse('2026-10-20T00:00:00.000Z')).turns, 1, 'a record before since is left out');
  assert.equal(laneOf([{ ...read[0], model: 'not-a-priced-model' }], undefined, null).estCostUsd, 0, 'an unpriced model counts $0');

  // A linked file reads as none, and an append through it writes nothing at its target.
  const linked = scratch(t);
  const target = path.join(linked, 'elsewhere.jsonl');
  fs.writeFileSync(target, usageLine({}) + '\n');
  fs.mkdirSync(path.dirname(sessionUsageFile(linked, '_inbox')), { recursive: true });
  fs.symlinkSync(target, sessionUsageFile(linked, '_inbox'));
  assert.deepEqual(readSessionUsage(linked, '_inbox'), []);
  assert.throws(() => appendSessionUsage(linked, '_inbox', payload));
  assert.equal(fs.readFileSync(target, 'utf8'), usageLine({}) + '\n', 'nothing written through the link');

  // An oversized file, and a session-usage dir that is a link or a file, read as none.
  const big = scratch(t);
  const bigFile = sessionUsageFile(big, '_office');
  fs.mkdirSync(path.dirname(bigFile), { recursive: true });
  fs.writeFileSync(bigFile, usageLine({ scope: '_office' }) + '\n');
  fs.truncateSync(bigFile, 64 * 1024 * 1024 + 1);
  assert.deepEqual(readSessionUsage(big, '_office'), []);
  const dirLink = scratch(t);
  const realDir = path.join(dirLink, 'real');
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(realDir, '_inbox.jsonl'), usageLine({}) + '\n');
  fs.mkdirSync(path.join(dirLink, '.forge', 'runtime'), { recursive: true });
  fs.symlinkSync(realDir, path.join(dirLink, '.forge', 'runtime', 'session-usage'));
  assert.deepEqual(readSessionUsage(dirLink, '_inbox'), [], 'a linked session-usage dir');
  assert.throws(() => appendSessionUsage(dirLink, '_inbox', payload), /is not a directory/);
  const dirFile = scratch(t);
  fs.mkdirSync(path.join(dirFile, '.forge', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(dirFile, '.forge', 'runtime', 'session-usage'), '');
  assert.deepEqual(readSessionUsage(dirFile, '_inbox'), [], 'a session-usage path that is a file');
});
