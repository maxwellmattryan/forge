// The Foreman popover's gate activity list: rows newest first with their outcome tones, target and token text, malformed
// runs dropped, and the header's off, live-of-parallel and paused states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateRunRows, gateRunsHeader } from './gate-runs.ts';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const run = (over: Record<string, unknown> = {}) => ({
  request: '1761480000000-abc',
  gate: 'spec-approval',
  job: 'add-json-flag',
  mandate: null,
  status: 'done',
  outcome: 'approve',
  reason: 'the spec covers the request',
  startedAt: '2026-10-26T11:58:00.000Z',
  endedAt: '2026-10-26T11:59:00.000Z',
  attempts: 1,
  usd: 0.42,
  tokens: 123_456,
  ...over,
});

test('gateRunRows: newest first, with tone, target and token text', () => {
  const runs = [
    run({ request: '1-old', outcome: 'escalated', reason: 'needs a person', startedAt: '2026-10-26T10:00:00.000Z' }),
    run({ request: '2-new', status: 'running', outcome: null, reason: null, startedAt: '2026-10-26T11:59:30.000Z', tokens: 0, usd: 0 }),
    run({ request: '3-mid', gate: 'milestone-approval', job: null, mandate: 'g1', outcome: 'failed', reason: 'the assistant exited without a verdict' }),
  ];
  const rows = gateRunRows({ runs }, NOW);
  assert.deepEqual(
    rows.map((r) => [r.key, r.label, r.job, r.mandate, r.outcome, r.tone, r.reason, r.started, r.tokens, r.usd]),
    [
      ['2-new', 'Spec approval', 'add-json-flag', null, 'running', 'live', null, '30s ago', '0', '$0.000'],
      ['3-mid', 'Milestone draft', null, 'g1', 'failed', 'bad', 'the assistant exited without a verdict', '2m ago', '123k', '$0.420'],
      ['1-old', 'Spec approval', 'add-json-flag', null, 'escalated', 'you', 'needs a person', '2h ago', '123k', '$0.420'],
    ],
  );
  const tones = Object.fromEntries(['approve', 'revise', 'rework', 'no-action', 'reserved', 'refused', 'stale', 'requeued', 'shelved'].map((o) => [o, gateRunRows({ runs: [run({ outcome: o })] }, NOW)[0]?.tone]));
  assert.deepEqual(tones, { approve: 'ok', revise: 'info', rework: 'info', 'no-action': 'muted', reserved: 'you', refused: 'warn', stale: 'muted', requeued: 'muted', shelved: 'warn' });
  // A senior pass that shelved the job: its two children's turns, and the reason it shelved.
  const shelved = gateRunRows({ runs: [run({ outcome: 'shelved', attempts: 4, reason: 'senior pass escalated: needs a person' })] }, NOW)[0];
  assert.deepEqual([shelved.label, shelved.outcome, shelved.tone, shelved.reason], ['Spec approval', 'shelved', 'warn', 'senior pass escalated: needs a person']);
});

test('gateRunRows drops malformed runs', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['an unknown gate', { gate: 'merge' }],
    ['an unknown outcome', { outcome: 'approved' }],
    ['a done run with no outcome', { outcome: null }],
    ['no target', { job: null, mandate: null }],
    ['both targets', { mandate: 'g1' }],
    ['a job id with a slash', { job: '../x' }],
    ['a forged mandate id', { job: null, mandate: 'G 1' }],
    ['no request', { request: '' }],
    ['a start that is no time', { startedAt: 'yesterday' }],
    ['negative tokens', { tokens: -1 }],
    ['tokens as text', { tokens: '12' }],
    ['infinite spend', { usd: Infinity }],
    ['an unknown status', { status: 'queued' }],
  ];
  for (const [name, over] of bad) assert.deepEqual(gateRunRows({ runs: [run(over)] }, NOW), [], name);
  for (const g of [null, undefined, 'x', { runs: 'x' }, { runs: [null, 3, 'x', []] }]) assert.deepEqual(gateRunRows(g, NOW), [], JSON.stringify(g));
  // A long reason is cut to 200 characters; one that is only whitespace reads as none.
  assert.equal(gateRunRows({ runs: [run({ reason: 'r'.repeat(500) })] }, NOW)[0].reason?.length, 200);
  assert.equal(gateRunRows({ runs: [run({ reason: '   ' })] }, NOW)[0].reason, null);
  // At most the 50 kept.
  assert.equal(gateRunRows({ runs: Array.from({ length: 80 }, (_, i) => run({ request: `${i}-r` })) }, NOW).length, 50);
});

test('gateRunsHeader: off, live of parallel, and paused', () => {
  assert.deepEqual(gateRunsHeader(undefined), { enabled: false, live: 0, parallel: 0, held: null }, 'an older server reads as off');
  assert.deepEqual(gateRunsHeader({ enabled: true, parallel: 2, live: 1, held: null, runs: [] }), { enabled: true, live: 1, parallel: 2, held: null });
  const cap = { reason: 'daily-cap', until: null, message: 'daemon stopped: the office session and its gate runs spent $1.05 of the $1.00 daily cap' };
  assert.deepEqual(gateRunsHeader({ enabled: true, parallel: 2, live: 0, held: cap }).held, { kind: 'cap', message: cap.message });
  for (const reason of ['retry', 'limit'])
    assert.deepEqual(gateRunsHeader({ enabled: true, parallel: 2, live: 0, held: { reason, until: '2026-10-26T13:00:00.000Z', message: 'x' } }).held, { kind: 'until', until: '2026-10-26T13:00:00.000Z' }, reason);
  assert.equal(gateRunsHeader({ enabled: true, held: { reason: 'retry', until: 'soon', message: 'x' } }).held, null, 'a hold with no time shows none');
  assert.equal(gateRunsHeader({ enabled: true, held: { reason: 'other', until: null, message: 'x' } }).held, null);
});
