// The chat log's controller, driven with a fake EventSource and fake pages: the first load pages forward and merges by n,
// line events and reopens catch up from the newest n with coalesced fetches, state frames reach onState, a hidden
// document holds no stream, the buffer keeps the newest MAX_ENTRIES, and nothing changes after dispose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatLog } from './chat-log.ts';
import { setProject } from './project.ts';
import { MAX_ENTRIES } from './session-log.ts';
import type { ChatEntry } from './chats.ts';
import type { LogSource } from './daemon-log.ts';
import type { ChatLogPage } from './types.ts';

setProject('web');
const ID = '0123456789ab';

class FakeSource implements LogSource {
  readyState = 0;
  closed = false;
  url: string;
  private listeners = new Map<string, ((e: { data?: unknown; lastEventId?: string }) => void)[]>();
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, l: (e: { data?: unknown; lastEventId?: string }) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), l]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type: string, e: { data?: unknown; lastEventId?: string } = {}): void {
    for (const l of this.listeners.get(type) ?? []) l(e);
  }
}

const entry = (n: number): ChatEntry => ({ v: 1, n, at: '2026-10-26T10:00:00.000Z', kind: 'session', line: `{"n":${n}}` });
const range = (from: number, to: number): ChatEntry[] => Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
const tick = () => new Promise((r) => setImmediate(r));

/** A log whose pages the test answers one at a time, in order. */
function harness() {
  const asked: number[] = [];
  const pending: { resolve: (p: ChatLogPage) => void; reject: (e: Error) => void }[] = [];
  const sources: FakeSource[] = [];
  const states: unknown[] = [];
  let changes = 0;
  let shownDoc = true;
  let clock = 0;
  const log = createChatLog({
    id: ID,
    token: 'tok',
    onChange: () => changes++,
    onState: (st) => states.push(st),
    connect: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    fetchPage: (after) => {
      asked.push(after);
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
    visible: () => shownDoc,
    now: () => clock,
  });
  const answer = async (entries: ChatEntry[], more = false) => {
    const p = pending.shift();
    assert.ok(p, 'a fetch is waiting');
    p.resolve({ id: ID, entries, more });
    await tick();
  };
  const fail = async (msg: string) => {
    pending.shift()!.reject(new Error(msg));
    await tick();
  };
  return {
    log,
    asked,
    pending,
    sources,
    states,
    answer,
    fail,
    changes: () => changes,
    setVisible: (v: boolean) => (shownDoc = v),
    advance: (ms: number) => (clock += ms),
    ns: () => log.entries.map((e) => e.n),
  };
}

test('the chat log loads, follows the session stream and catches up', async () => {
  // (a) The first load pages from -1 while `more`, merging by n and keeping n order; then it dials the chat's stream.
  const h = harness();
  h.log.sync(true);
  assert.equal(h.log.loading, true);
  assert.deepEqual(h.asked, [-1]);
  await h.answer(range(0, 2), true);
  assert.deepEqual(h.asked, [-1, 2]);
  assert.equal(h.sources.length, 0, 'no stream before the first load is in');
  await h.answer([entry(1), entry(2), entry(3), entry(4)]);
  assert.deepEqual(h.ns(), [0, 1, 2, 3, 4]);
  assert.equal(h.log.loading, false);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0]!.url, `/api/p/web/events?session=_chat-${ID}`);
  assert.equal(h.log.lastLiveAt, null, 'a page load is never live');
  const src = h.sources[0]!;

  // The first open fetches nothing; a reconnect's open catches up.
  src.emit('open');
  assert.deepEqual(h.asked, [-1, 2]);
  src.emit('open');
  assert.deepEqual(h.asked, [-1, 2, 4]);
  await h.answer([]);

  // (b) A line event fetches after the newest n; three during one in-flight fetch cause exactly one more.
  h.advance(5000);
  src.emit('line', { data: 'x', lastEventId: '5' });
  assert.deepEqual(h.asked.slice(-1), [4]);
  src.emit('line');
  src.emit('line');
  src.emit('line');
  assert.equal(h.pending.length, 1, 'coalesced while one runs');
  await h.answer([entry(5)]);
  assert.deepEqual(h.asked.slice(-2), [4, 5]);
  await h.answer([entry(6)]);
  assert.equal(h.pending.length, 0, 'exactly one more');
  assert.deepEqual(h.ns(), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(h.log.lastLiveAt, 5000, 'a line fetched well after the open is live');
  assert.equal(h.log.arrivedAt(6), 5000);
  assert.equal(h.log.arrivedAt(2), null);

  // (c) A state frame reaches onState parsed; bad JSON is ignored.
  src.emit('state', { data: '{"status":"busy","permissions":[]}' });
  src.emit('state', { data: '{not json' });
  assert.deepEqual(h.states, [{ status: 'busy', permissions: [] }]);

  // (g) An error while CONNECTING is the browser's own reconnect.
  src.readyState = 0;
  src.emit('error');
  assert.equal(h.log.closed, false);

  // (d) Hidden: the stream closes and nothing is fetched. Shown again: it fetches after the newest n, never -1, then redials.
  const asked = h.asked.length;
  h.setVisible(false);
  h.log.visibilityChanged();
  assert.ok(src.closed);
  assert.equal(h.asked.length, asked);
  assert.deepEqual(h.ns(), [0, 1, 2, 3, 4, 5, 6], 'the entries stay');
  h.setVisible(true);
  h.log.visibilityChanged();
  assert.deepEqual(h.asked.slice(asked), [6]);
  assert.equal(h.sources.length, 1, 'catches up before it redials');
  await h.answer([entry(7)]);
  assert.equal(h.sources.length, 2);
  assert.deepEqual(h.ns(), [0, 1, 2, 3, 4, 5, 6, 7]);
  const src2 = h.sources[1]!;

  // A line on the old, closed stream does nothing.
  src.emit('line');
  assert.equal(h.pending.length, 0);

  // (f) A failed fetch sets the error; the next good one clears it.
  src2.emit('line');
  await h.fail('chat log unreadable');
  assert.equal(h.log.error, 'chat log unreadable');
  src2.emit('line');
  await h.answer([]);
  assert.equal(h.log.error, null);

  // (g) An error with readyState CLOSED is final.
  src2.readyState = 2;
  src2.emit('error');
  assert.equal(h.log.closed, true);

  // (h) After dispose the stream is closed, and a fetch that resolves late changes nothing.
  h.log.refresh();
  assert.equal(h.pending.length, 1, 'a send still fetches after the stream closed');
  h.log.dispose();
  const before = h.changes();
  await h.answer([entry(8)]);
  assert.deepEqual(h.ns(), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(h.changes(), before);
  h.log.refresh();
  h.log.sync(true);
  assert.equal(h.pending.length, 0);
});

test('the chat log keeps the newest MAX_ENTRIES and reports the trim', async () => {
  // (e) Past MAX_ENTRIES the oldest entries are dropped and `trimmed` is true.
  const h = harness();
  h.log.sync(true);
  await h.answer(range(0, 2999), true);
  assert.equal(h.log.trimmed, false);
  await h.answer(range(3000, 5999));
  assert.equal(h.log.entries.length, MAX_ENTRIES);
  assert.equal(h.log.entries[0]!.n, 6000 - MAX_ENTRIES);
  assert.equal(h.log.entries.at(-1)!.n, 5999);
  assert.equal(h.log.trimmed, true);
});

test('a failed first load sets the error, dials nothing, and a refresh starts it again', async () => {
  // (f) on the first load.
  const h = harness();
  h.log.sync(true);
  await h.fail('no chat 0123456789ab');
  assert.equal(h.log.error, 'no chat 0123456789ab');
  assert.equal(h.log.loading, false);
  assert.equal(h.sources.length, 0);
  h.log.refresh();
  assert.deepEqual(h.asked, [-1, -1]);
  await h.answer([entry(0)]);
  assert.equal(h.log.error, null);
  assert.equal(h.sources.length, 1);
  // Unshown: the stream closes; a hidden document never starts it.
  h.log.sync(false);
  assert.ok(h.sources[0]!.closed);
  h.setVisible(false);
  h.log.sync(true);
  assert.equal(h.pending.length, 0);
});
