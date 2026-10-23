// A station terminal's life (dashboard/src/lib/station.ts): the pilot lamp per session and stream state, the cursor, and
// when output counts as streaming, struck or live.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STREAM_MS, STRIKE_MS, cursorState, isLiveLine, lampState, streaming, struck, type LampState } from '../dashboard/src/lib/station.ts';
import { SETTLE_MS } from '../dashboard/src/lib/motion.ts';

test('lampState: one row per session and stream case', () => {
  const prompt = { running: true, status: 'busy', permissions: [{ id: 'p1' }] };
  // Session fields arrive partial and untrusted, so the rows give only what each case needs.
  const rows: [string, any, LampState][] = [
    ['a permission prompt', { kind: 'session', session: prompt, waiting: false, streaming: true }, 'you'],
    ['a permission prompt beats an open tool', { kind: 'session', session: prompt, waiting: true, streaming: false }, 'you'],
    ['busy', { kind: 'session', session: { running: true, status: 'busy' }, waiting: false, streaming: false }, 'working'],
    ['busy, streaming', { kind: 'session', session: { running: true, status: 'busy' }, waiting: false, streaming: true }, 'working'],
    ['busy on an open tool call', { kind: 'session', session: { running: true, status: 'busy' }, waiting: true, streaming: true }, 'waiting'],
    ['kept by its agents', { kind: 'session', session: { running: true, status: 'idle', kept: 'agents' }, waiting: false, streaming: false }, 'waiting'],
    ['running, between turns', { kind: 'session', session: { running: true, status: 'idle' }, waiting: false, streaming: false }, 'done'],
    ['failing', { kind: 'session', session: { running: true, status: 'idle', lastError: 'boom' }, waiting: false, streaming: false }, 'idle'],
    ['no session', { kind: 'session', session: null, waiting: false, streaming: false }, 'idle'],
    ['stopped', { kind: 'session', session: { running: false, status: 'off', wanted: false }, waiting: false, streaming: false }, 'idle'],
    ['standby', { kind: 'session', session: { running: false, status: 'off', sessionId: 'abc' }, waiting: false, streaming: false }, 'idle'],
    ['held', { kind: 'session', session: { running: false, status: 'off', held: 'budget' }, waiting: false, streaming: false }, 'idle'],
    ['waiting for a slot', { kind: 'session', session: { running: false, status: 'off', waiting: true }, waiting: false, streaming: false }, 'idle'],
    ['error', { kind: 'session', session: { running: false, status: 'off', lastError: 'exit 1' }, waiting: false, streaming: false }, 'idle'],
    ['a prompt on a stopped session', { kind: 'session', session: { running: false, permissions: [{ id: 'p' }] }, waiting: false, streaming: false }, 'idle'],
    ['stream ended', { kind: 'stream', ended: true, waiting: true, streaming: true }, 'done'],
    ['stream on an open tool call', { kind: 'stream', ended: false, waiting: true, streaming: true }, 'waiting'],
    ['stream streaming', { kind: 'stream', ended: false, waiting: false, streaming: true }, 'working'],
    ['stream quiet', { kind: 'stream', ended: false, waiting: false, streaming: false }, 'idle'],
  ];
  for (const [name, input, want] of rows) assert.equal(lampState(input), want, name);
});

test('cursorState, streaming, struck and isLiveLine', () => {
  assert.equal(cursorState('working', true), 'blink');
  for (const lamp of ['working', 'waiting', 'you'] as const) assert.equal(cursorState(lamp, false), 'hold', `${lamp}, quiet`);
  for (const lamp of ['waiting', 'you'] as const) assert.equal(cursorState(lamp, true), 'hold', `${lamp}, streaming`);
  for (const lamp of ['done', 'idle', 'fault'] as const) for (const s of [true, false]) assert.equal(cursorState(lamp, s), 'off', `${lamp}, ${s}`);

  assert.equal(streaming(null, 5000), false, 'no live line yet');
  assert.equal(streaming(1000, 1000 + STREAM_MS - 1), true);
  assert.equal(streaming(1000, 1000 + STREAM_MS), false);

  assert.equal(struck(null, 5000), false);
  assert.equal(struck(undefined, 5000), false);
  assert.equal(struck(1000, 1000 + STRIKE_MS - 1), true);
  assert.equal(struck(1000, 1000 + STRIKE_MS), false);

  assert.equal(isLiveLine(null, 5000), false, 'no stream open');
  assert.equal(isLiveLine(1000, 1000 + SETTLE_MS - 1), false, 'the backlog a (re)open replays');
  assert.equal(isLiveLine(1000, 1000 + SETTLE_MS), true);
});
