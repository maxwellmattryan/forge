// The Thread's progress lines (dashboard/src/lib/thread-progress.ts): which job events become a line, how each reads its fields
// defensively, and how the lines merge between the messages.
import test from 'node:test';
import assert from 'node:assert/strict';
import { progressOf, plainLine, threadFeed, threadProgress } from '../dashboard/src/lib/thread-progress.ts';
import { threadItems } from '../dashboard/src/lib/thread.ts';

const ev = (type: string, o: Record<string, unknown> = {}, ts = '2026-10-22T10:00:00.000Z'): any => ({ v: 3, ts, type, ...o });
const side = (stage: string, state: string, waitingOn: string | null = null) => ({ stage, state, waitingOn });

test('progressOf: one row per event a person follows', () => {
  const rows: [string, any, unknown][] = [
    ['a new stage', ev('transition', { from: side('spec', 'running'), to: side('build', 'running') }), { kind: 'stage', stage: 'build' }],
    ['a parked gate', ev('transition', { from: side('spec', 'running'), to: side('spec', 'waiting', 'spec-approval'), reason: 'spec ready' }), { kind: 'waiting', on: 'spec-approval', reason: 'spec ready' }],
    ['an unknown wait', ev('transition', { from: side('spec', 'running'), to: side('spec', 'waiting', 'mystery') }), { kind: 'waiting', on: null, reason: null }],
    ['a block', ev('transition', { from: side('build', 'running'), to: side('build', 'blocked'), reason: 'tests' }), { kind: 'blocked', reason: 'tests' }],
    ['the end', ev('transition', { from: side('pr', 'waiting', 'pr-review'), to: side('done', 'done') }), { kind: 'ended', state: 'done', reason: null }],
    ['a failure', ev('transition', { from: side('build', 'running'), to: side('build', 'failed'), reason: 'gave up' }), { kind: 'ended', state: 'failed', reason: 'gave up' }],
    ['a second round', ev('round', { round: 2 }), { kind: 'round', round: 2 }],
    ["an agent's reply", ev('agent-end', { role: 'spec-writer', summary: 'SPEC: ready · size L' }), { kind: 'agent', role: 'spec-writer', summary: 'SPEC: ready · size L' }],
    ['an agent without one', ev('agent-end', { role: 'builder' }), { kind: 'agent', role: 'builder', summary: null }],
    ['checks', ev('verify', { round: 1, ok: false }), { kind: 'checks', round: 1, ok: false }],
    ['reviews', ev('verdicts', { round: 2, outcome: 'PASS' }), { kind: 'reviews', round: 2, pass: true }],
    ['the decision', ev('decision', { decision: 'ESCALATE', reason: 'protected path' }), { kind: 'decision', approve: false, reason: 'protected path' }],
    ['a PR', ev('pr-opened', { number: 372, url: 'https://example.test' }), { kind: 'pr-opened', number: 372 }],
    ['a merge', ev('pr-merged', { number: 372 }), { kind: 'pr-merged', number: 372 }],
    ['conflicts', ev('integrate-conflicts', { conflicts: ['a.ts', 'b.ts'] }), { kind: 'conflicts', count: 2 }],
    ['a note', ev('note', { text: 'needs a human edit' }), { kind: 'note', text: 'needs a human edit' }],
  ];
  for (const [name, e, want] of rows) assert.deepEqual(progressOf(e), want, name);
});

test('progressOf: no row for detail, repeats or malformed fields', () => {
  const rows: [string, any][] = [
    ['a command', ev('command', { name: 'test', ok: true })],
    ['a PR sync', ev('pr-synced')],
    ['a same-stage step', ev('transition', { from: side('build', 'queued'), to: side('build', 'running') })],
    ['the same wait again', ev('transition', { from: side('spec', 'waiting', 'input'), to: side('spec', 'waiting', 'input') })],
    ['the first round', ev('round', { round: 1 })],
    ['a bad role', ev('agent-end', { role: '<img onerror>' })],
    ['a round that is not a number', ev('verify', { round: '1', ok: true })],
    ['an unknown outcome', ev('verdicts', { round: 1, outcome: 'MAYBE' })],
    ['an unknown decision', ev('decision', { decision: 'SHIP' })],
    ['a PR without a number', ev('pr-opened', { number: 'x' })],
    ['no conflicts', ev('integrate-conflicts', { conflicts: [] })],
    ['an empty note', ev('note', { text: '  ' })],
  ];
  for (const [name, e] of rows) assert.equal(progressOf(e), null, name);
});

test('plainLine: one line of at most 300 characters', () => {
  assert.equal(plainLine('a\nb c\t\td'), 'a b c d');
  assert.equal(plainLine(42), null);
  assert.equal(plainLine('\n'), null);
  const long = plainLine('x'.repeat(400));
  assert.equal(long?.length, 300);
  assert.ok(long?.endsWith('…'));
});

test('threadProgress: oldest first, untimed events dropped', () => {
  const out = threadProgress([
    ev('pr-opened', { number: 2 }, '2026-10-22T12:00:00.000Z'),
    ev('note', { text: 'first' }, '2026-10-22T11:00:00.000Z'),
    ev('note', { text: 'no time' }, 'never'),
    ev('command', {}, '2026-10-22T11:30:00.000Z'),
  ]);
  assert.deepEqual(
    out.map((m) => m.line.kind),
    ['note', 'pr-opened'],
  );
  assert.notEqual(out[0].id, out[1].id);
});

test('threadFeed: progress lines merge between the messages by time, a message first on a tie', () => {
  const opening = { text: 'Build it', at: '2026-10-22T09:00:00.000Z', tracker: false };
  const requests: any[] = [{ id: '2026-10-22T11:00:00.000Z-approve', type: 'approve', status: 'done', from: 'dashboard', createdAt: '2026-10-22T11:00:00.000Z', result: null }];
  const items = threadItems(requests, opening, []);
  const ms = threadProgress([
    ev('note', { text: 'tie' }, '2026-10-22T11:00:00.000Z'),
    ev('note', { text: 'between' }, '2026-10-22T10:00:00.000Z'),
    ev('note', { text: 'after' }, '2026-10-22T12:00:00.000Z'),
  ]);
  const rows = threadFeed(items, ms);
  assert.deepEqual(
    rows.map((r) => (r.kind === 'message' ? r.item.id : (r.item.line as { text: string }).text)),
    ['request', 'between', '2026-10-22T11:00:00.000Z-approve', 'tie', 'after'],
  );
  assert.deepEqual(threadFeed(items, []).map((r) => r.kind), ['message', 'message'], 'no progress lines, only the messages');
});
