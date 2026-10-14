// The session log controller (dashboard/src/lib/daemon-log.ts) against a fake EventSource, fetch and
// visibility: the latest page first, then /api/events?session=, merged by offset.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOSED_NOTE, LOG_KEY, createSessionLog, eventsUrl } from '../dashboard/src/lib/daemon-log.ts';
import { MAX_ENTRIES } from '../dashboard/src/lib/session-log.ts';

class FakeSource {
  declare url: any;
  declare readyState: any;
  declare closed: any;
  declare listeners: any;
  constructor(url) {
    this.url = url;
    this.readyState = 1;
    this.closed = false;
    /** @type {Record<string, Function[]>} */
    this.listeners = {};
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  emit(type, { data, lastEventId }: any = {}) {
    for (const fn of this.listeners[type] ?? []) fn({ data, lastEventId });
  }
}

const tick = () => new Promise((r) => setImmediate(r));
const pageOf = (offsets, more = false, end?) => ({ scope: 'job-a', lines: offsets.map((o) => ({ offset: o, line: `l${o}` })), start: offsets[0] ?? end ?? 0, end: end ?? (offsets.length ? offsets.at(-1) + 10 : 0), more });

function harness({ visible = true, pages = [] as any[], scope = 'job-a' } = {}) {
  const sources = [];
  const states = [];
  const fetches = [];
  const env = { visible, changes: 0, pages };
  const log = createSessionLog({
    scope,
    onState: (st) => states.push(st),
    onChange: () => env.changes++,
    connect: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    fetchPage: async (sc, before) => {
      fetches.push({ scope: sc, before });
      const p = env.pages.shift();
      if (p instanceof Error) throw p;
      return p ?? pageOf([]);
    },
    visible: () => env.visible,
  });
  const live = () => sources.filter((s) => !s.closed);
  const offsets = () => log.entries.map((e) => e.offset);
  return { log, sources, states, fetches, env, live, offsets };
}

test('fetches the latest page before connecting to the encoded session stream', async () => {
  const h = harness({ pages: [pageOf([100, 110, 120])], scope: 'job a/../x' });
  h.log.sync(true);
  assert.equal(h.log.loading, true);
  assert.equal(h.sources.length, 0, 'nothing connects before the page arrives');
  assert.deepEqual(h.fetches, [{ scope: 'job a/../x', before: undefined }]);
  await tick();
  assert.equal(h.log.loading, false);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].url, '/api/events?session=job%20a%2F..%2Fx');
  assert.equal(eventsUrl('_inbox'), '/api/events?session=_inbox');
  assert.deepEqual(h.offsets(), [100, 110, 120]);
  h.log.sync(true);
  h.log.sync(true);
  assert.equal(h.sources.length, 1, 'one stream however often it syncs');
  assert.equal(LOG_KEY, 'forge.daemonLog');
});

test('merges live lines by offset: no duplicates, nothing older than the window, in order', async () => {
  const h = harness({ pages: [pageOf([100, 110, 120])] });
  h.log.sync(true);
  await tick();
  const src = h.sources[0];
  src.emit('line', { data: 'l110 again', lastEventId: '110' });
  src.emit('line', { data: 'old', lastEventId: '50' });
  src.emit('line', { data: 'l140', lastEventId: '140' });
  src.emit('line', { data: 'l130', lastEventId: '130' });
  assert.deepEqual(h.offsets(), [100, 110, 120, 130, 140]);
  assert.equal(h.log.entries[1].line, 'l110', 'a replayed line never replaces the one we have');
  src.emit('state', { data: '{"scope":"job-a","status":"busy"}' });
  src.emit('state', { data: '{oops' });
  assert.deepEqual(h.states, [{ scope: 'job-a', status: 'busy' }]);
});

test('loads older pages with before', async () => {
  const h = harness({ pages: [pageOf([300, 310], true), pageOf([200, 210, 300], true), pageOf([100], false)] });
  h.log.sync(true);
  await tick();
  assert.equal(h.log.more, true);
  await h.log.loadOlder();
  assert.deepEqual(h.fetches.at(-1), { scope: 'job-a', before: 300 });
  assert.deepEqual(h.offsets(), [200, 210, 300, 310], 'older lines go in front, duplicates dropped');
  assert.equal(h.log.more, true);
  await h.log.loadOlder();
  assert.deepEqual(h.fetches.at(-1).before, 200);
  assert.deepEqual(h.offsets(), [100, 200, 210, 300, 310]);
  assert.equal(h.log.more, false);
  const n = h.fetches.length;
  await h.log.loadOlder();
  assert.equal(h.fetches.length, n, 'nothing more to load');
});

test('caps the buffer at MAX_ENTRIES and sets more', async () => {
  const h = harness({ pages: [pageOf([0])] });
  h.log.sync(true);
  await tick();
  const src = h.sources[0];
  for (let i = 1; i <= MAX_ENTRIES + 5; i++) src.emit('line', { data: `l${i}`, lastEventId: String(i * 10) });
  assert.equal(h.log.entries.length, MAX_ENTRIES);
  assert.equal(h.log.entries[0].offset, 60, 'the oldest are dropped');
  assert.equal(h.log.more, true);
});

test('refetches on reconnect and replaces the buffer when the log was reset', async () => {
  const h = harness({ pages: [pageOf([100, 110]), pageOf([110, 120, 130]), pageOf([5, 15], false, 25)] });
  h.log.sync(true);
  await tick();
  const src = h.sources[0];
  src.emit('open');
  assert.equal(h.fetches.length, 1, 'the first open is the initial connect');
  src.readyState = 0;
  src.emit('error');
  src.readyState = 1;
  src.emit('open');
  await tick();
  assert.equal(h.fetches.length, 2, 'a reconnect refetches the latest page');
  assert.deepEqual(h.offsets(), [100, 110, 120, 130], 'and fills the gap by offset');
  src.emit('open');
  await tick();
  assert.deepEqual(h.offsets(), [5, 15], 'a page ending before our newest line means the log was reset');
  // A live line the file hasn't flushed yet: the page ends before it but shares offsets, so it merges.
  src.emit('line', { data: 'l35', lastEventId: '35' });
  h.env.pages.push(pageOf([5, 15], false, 25));
  src.emit('open');
  await tick();
  assert.deepEqual(h.offsets(), [5, 15, 35], 'a flush lag is not a reset');
});

test('a fetch error shows, and no stream opens', async () => {
  const h = harness({ pages: [new Error('no session log')] });
  h.log.sync(true);
  await tick();
  assert.equal(h.log.error, 'no session log');
  assert.equal(h.log.loading, false);
  assert.equal(h.sources.length, 0);
});

test('opens nothing while hidden or unshown, and closes when hidden', async () => {
  const hidden = harness({ visible: false });
  hidden.log.sync(true);
  await tick();
  assert.equal(hidden.fetches.length + hidden.sources.length, 0, 'a hidden document holds no slot');
  const unshown = harness();
  unshown.log.sync(false);
  await tick();
  assert.equal(unshown.fetches.length + unshown.sources.length, 0, 'an unshown tab holds no slot');

  const h = harness({ pages: [pageOf([1]), pageOf([1, 2])] });
  h.log.sync(true);
  await tick();
  assert.equal(h.live().length, 1);
  h.env.visible = false;
  h.log.visibilityChanged();
  assert.equal(h.live().length, 0, 'hidden closes the stream');
  h.env.visible = true;
  h.log.visibilityChanged();
  await tick();
  assert.equal(h.live().length, 1, 'visible again reopens it');
  h.log.sync(false);
  assert.equal(h.live().length, 0, 'the drawer closing closes it');

  // A page that resolves after the tab closed is dropped and connects nothing.
  const late = harness({ pages: [pageOf([1])] });
  late.log.sync(true);
  late.log.sync(false);
  await tick();
  assert.equal(late.sources.length, 0);
  assert.deepEqual(late.offsets(), []);
});

test('CLOSED is final until the tab is reopened; CONNECTING changes nothing; stale sources are ignored', async () => {
  const h = harness({ pages: [pageOf([1])] });
  h.log.sync(true);
  await tick();
  const src = h.sources[0];
  src.readyState = 0;
  src.emit('error');
  assert.equal(h.log.closed, false);
  assert.equal(h.log.note, null);
  src.readyState = 2;
  src.emit('error');
  assert.equal(h.log.closed, true);
  assert.equal(h.log.note, CLOSED_NOTE);
  h.log.sync(true);
  h.log.visibilityChanged();
  await tick();
  assert.equal(h.sources.length, 1, 'nothing reconnects on its own');
  src.emit('line', { data: 'late', lastEventId: '99' });
  assert.deepEqual(h.offsets(), [1], 'a dropped source no longer feeds the buffer');
  h.log.dispose();
});
