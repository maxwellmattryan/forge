// The Office page's Office runs table: rows newest first with their outcome tones, mandate and token text, malformed
// runs dropped, at most 50 kept with reasons cut, and the header's off, live and paused states.
import test from 'node:test';
import assert from 'node:assert/strict';
import { officeRunRows, officeRunsHeader } from './runs.ts';

const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const run = (over: Record<string, unknown> = {}) => ({
  request: '1761800000000-abc',
  type: 'draft',
  mandate: 'g1',
  status: 'done',
  outcome: 'drafted',
  reason: 'drafted: 3 issues in 2 waves',
  startedAt: '2026-10-30T11:58:00.000Z',
  endedAt: '2026-10-30T11:59:00.000Z',
  calls: 1,
  usd: 0.42,
  tokens: 123_456,
  ...over,
});

test('officeRunRows: newest first, with tone, mandate and token text', () => {
  const runs = [
    run({ request: '1-old', type: 'direct', mandate: null, outcome: 'directed', reason: 'started 2, resumed 0', startedAt: '2026-10-30T10:00:00.000Z' }),
    run({ request: '2-new', status: 'running', outcome: null, reason: null, startedAt: '2026-10-30T11:59:30.000Z', tokens: 0, usd: 0 }),
    run({ request: '3-mid', outcome: 'failed', reason: 'forge:drafter exit: claude closed (code 1) without a result' }),
  ];
  assert.deepEqual(
    officeRunRows({ runs }, NOW).map((r) => [r.key, r.type, r.mandate, r.outcome, r.tone, r.reason, r.started, r.tokens, r.usd]),
    [
      ['2-new', 'draft', 'g1', 'running', 'live', null, '30s ago', '0', '$0.000'],
      ['3-mid', 'draft', 'g1', 'failed', 'bad', 'forge:drafter exit: claude closed (code 1) without a result', '2m ago', '123k', '$0.420'],
      ['1-old', 'direct', null, 'directed', 'ok', 'started 2, resumed 0', '2h ago', '123k', '$0.420'],
    ],
  );
  const tones = Object.fromEntries(['drafted', 'stale', 'refused', 'requeued'].map((o) => [o, officeRunRows({ runs: [run({ outcome: o })] }, NOW)[0]?.tone]));
  assert.deepEqual(tones, { drafted: 'ok', stale: 'muted', refused: 'warn', requeued: 'muted' });
});

test('officeRunRows drops malformed runs and keeps 50', () => {
  const bad: [string, Record<string, unknown>][] = [
    ['an unknown type', { type: 'gate' }],
    ['an unknown outcome', { outcome: 'approve' }],
    ['a done run with no outcome', { outcome: null }],
    ['a draft with no mandate', { mandate: null }],
    ['a direct run with a mandate', { type: 'direct' }],
    ['a forged mandate id', { mandate: 'G 1' }],
    ['no request', { request: '' }],
    ['a start that is no time', { startedAt: 'yesterday' }],
    ['negative tokens', { tokens: -1 }],
    ['infinite spend', { usd: Infinity }],
    ['an unknown status', { status: 'queued' }],
  ];
  for (const [name, over] of bad) assert.deepEqual(officeRunRows({ runs: [run(over)] }, NOW), [], name);
  for (const o of [null, undefined, 'x', { runs: 'x' }, { runs: [null, 3, 'x', []] }]) assert.deepEqual(officeRunRows(o, NOW), [], JSON.stringify(o));
  assert.equal(officeRunRows({ runs: [run({ reason: 'r'.repeat(500) })] }, NOW)[0].reason?.length, 200);
  assert.equal(officeRunRows({ runs: Array.from({ length: 80 }, (_, i) => run({ request: `${i}-r` })) }, NOW).length, 50);
});

test('officeRunsHeader: off, live, and paused', () => {
  assert.deepEqual(officeRunsHeader(undefined), { enabled: false, live: 0, held: null }, 'an older server reads as off');
  // An older server's state for the retired office session has no `enabled` or `live` of its own kind.
  assert.deepEqual(officeRunsHeader({ scope: '_office', status: 'busy' }), { enabled: false, live: 0, held: null });
  assert.deepEqual(officeRunsHeader({ enabled: true, live: 1, held: null, runs: [] }), { enabled: true, live: 1, held: null });
  const cap = { reason: 'daily-cap', until: null, message: 'daemon stopped: the office runs and gate runs spent $1.05 of the $1.00 daily cap' };
  assert.deepEqual(officeRunsHeader({ enabled: true, live: 0, held: cap }).held, { kind: 'cap', message: cap.message });
  for (const reason of ['retry', 'limit'])
    assert.deepEqual(officeRunsHeader({ enabled: true, live: 0, held: { reason, until: '2026-10-30T13:00:00.000Z', message: 'x' } }).held, { kind: 'until', until: '2026-10-30T13:00:00.000Z' }, reason);
  assert.equal(officeRunsHeader({ enabled: true, held: { reason: 'retry', until: 'soon', message: 'x' } }).held, null);
});
