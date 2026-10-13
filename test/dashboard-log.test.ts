// The daemon log stream controller (dashboard/src/lib/daemon-log.ts) against a fake EventSource,
// visibility and storage: the /api/events lifecycle the old mountDaemon owned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonLog, LOG_KEY } from '../dashboard/src/lib/daemon-log.ts';
import { CLOSED_NOTE, EMPTY_NOTE, MAX_LINES } from '../dashboard/src/lib/daemon.ts';

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

function harness({ stored = '1', visible = true, storage }: any = {}) {
  const sources = [];
  const states = [];
  const env = { visible, changes: 0 };
  const items = new Map(stored == null ? [] : [[LOG_KEY, stored]]);
  const store = storage ?? { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, v) };
  const log = createDaemonLog({
    onState: (st) => states.push(st),
    onChange: () => env.changes++,
    connect: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    visible: () => env.visible,
    storage: store,
  });
  const live = () => sources.filter((s) => !s.closed);
  return { log, sources, states, env, items, live };
}

test('(a) sync opens exactly one /api/events source when open, shown, visible and not closed', () => {
  const h = harness();
  h.log.sync(true);
  h.log.sync(true);
  h.log.sync(true);
  assert.equal(h.sources.length, 1);
  assert.equal(h.sources[0].url, '/api/events');
  assert.equal(h.live().length, 1);

  const shut = harness({ stored: '0' });
  shut.log.sync(true);
  assert.equal(shut.sources.length, 0, 'a collapsed pane holds no slot');
  const hidden = harness({ visible: false });
  hidden.log.sync(true);
  assert.equal(hidden.sources.length, 0, 'a hidden tab holds no slot');
  const noBar = harness();
  noBar.log.sync(false);
  assert.equal(noBar.sources.length, 0, 'no bar, no stream');
});

test('(b) a line event appends through appendLine: dedupe, reset and cap', () => {
  const h = harness();
  h.log.sync(true);
  const src = h.sources[0];
  src.emit('line', { data: 'one', lastEventId: '1' });
  src.emit('line', { data: 'two', lastEventId: '2' });
  src.emit('line', { data: 'dupe', lastEventId: '2' });
  assert.deepEqual(h.log.lines, [{ seq: 1, line: 'one' }, { seq: 2, line: 'two' }]);
  src.emit('line', { data: 42, lastEventId: '7' });
  assert.deepEqual(h.log.lines.at(-1), { seq: 7, line: '42' }, 'data is stringified, the id numbered');
  src.emit('line', { data: 'restart', lastEventId: '0' });
  assert.deepEqual(h.log.lines, [{ seq: 0, line: 'restart' }], 'a lower seq means a fresh server');
  for (let i = 1; i <= MAX_LINES + 5; i++) src.emit('line', { data: String(i), lastEventId: String(i) });
  assert.equal(h.log.lines.length, MAX_LINES);
  assert.equal(h.log.lines[0].seq, 6);
});

test('(c) a state event calls onState with the parsed JSON; malformed JSON is ignored', () => {
  const h = harness();
  h.log.sync(true);
  h.sources[0].emit('state', { data: '{"status":"busy","enabled":false}' });
  h.sources[0].emit('state', { data: '{not json' });
  assert.deepEqual(h.states, [{ status: 'busy', enabled: false }]);
});

test('(d) error: CONNECTING changes nothing, CLOSED drops the source until toggle()', () => {
  const h = harness();
  h.log.sync(true);
  const src = h.sources[0];
  src.emit('line', { data: 'kept', lastEventId: '1' });
  src.readyState = 0;
  src.emit('error');
  assert.equal(h.log.closed, false, 'the browser reconnects with Last-Event-ID; no note');
  assert.equal(h.log.note, null);
  h.log.sync(true);
  assert.equal(h.sources.length, 1);

  src.readyState = 2;
  src.emit('error');
  assert.equal(h.log.closed, true);
  assert.equal(h.log.note, CLOSED_NOTE);
  assert.deepEqual(h.log.lines, [{ seq: 1, line: 'kept' }], 'lines stay above the note');
  h.log.sync(true);
  h.env.visible = false;
  h.log.visibilityChanged();
  h.env.visible = true;
  h.log.visibilityChanged();
  h.log.sync(true);
  assert.equal(h.sources.length, 1, 'nothing reopens a closed stream');

  h.log.toggle();
  h.log.toggle();
  assert.equal(h.log.closed, false);
  assert.equal(h.sources.length, 2, 'toggling Log off and on retries');
});

test('(e) an error from a source that is no longer current is ignored', () => {
  const h = harness();
  h.log.sync(true);
  const old = h.sources[0];
  h.log.toggle();
  h.log.toggle();
  assert.equal(h.sources.length, 2);
  old.readyState = 2;
  old.emit('error');
  assert.equal(h.log.closed, false);
  assert.equal(h.live().length, 1);
  assert.equal(h.live()[0], h.sources[1]);
});

test('(f) toggle flips open, clears closed, persists, and closes the source and lines when closing', () => {
  const h = harness();
  h.log.sync(true);
  h.sources[0].emit('line', { data: 'x', lastEventId: '1' });
  const before = h.env.changes;
  h.log.toggle();
  assert.equal(h.log.open, false);
  assert.equal(h.items.get(LOG_KEY), '0');
  assert.equal(h.sources[0].closed, true);
  assert.deepEqual(h.log.lines, []);
  assert.ok(h.env.changes > before, 'onChange fires');
  h.log.toggle();
  assert.equal(h.log.open, true);
  assert.equal(h.items.get(LOG_KEY), '1');
  assert.equal(h.live().length, 1, 'reopens with the last shown');
  h.sources[1].readyState = 2;
  h.sources[1].emit('error');
  assert.equal(h.log.closed, true);
  h.log.toggle();
  assert.equal(h.log.closed, false, 'toggle clears closed');
});

test('(g) hidden closes the source; visible reopens it unless closed', () => {
  const h = harness();
  h.log.sync(true);
  h.env.visible = false;
  h.log.visibilityChanged();
  assert.equal(h.live().length, 0);
  h.env.visible = true;
  h.log.visibilityChanged();
  assert.equal(h.live().length, 1);
  assert.equal(h.sources.length, 2);
  h.sources[1].readyState = 2;
  h.sources[1].emit('error');
  h.env.visible = false;
  h.log.visibilityChanged();
  h.env.visible = true;
  h.log.visibilityChanged();
  assert.equal(h.sources.length, 2, 'a closed stream stays closed');
});

test('(h) sync(false) closes the source when the bar is hidden', () => {
  const h = harness();
  h.log.sync(true);
  h.sources[0].emit('line', { data: 'x', lastEventId: '1' });
  h.log.sync(false);
  assert.equal(h.live().length, 0);
  assert.deepEqual(h.log.lines, []);
  h.log.sync(true);
  assert.equal(h.live().length, 1);
  h.log.dispose();
  assert.equal(h.live().length, 0, 'dispose closes it');
});

test('(i) the initial open state comes from forge.daemonLog; a throwing storage reads as closed', () => {
  assert.equal(harness({ stored: '1' }).log.open, true);
  assert.equal(harness({ stored: '0' }).log.open, false);
  assert.equal(harness({ stored: null }).log.open, false);
  assert.equal(harness({ stored: 'true' }).log.open, false);
  const boom = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const h = harness({ storage: boom });
  assert.equal(h.log.open, false);
  h.log.toggle();
  assert.equal(h.log.open, true, 'toggle still works without storage');
});

test('(j) note: closed note, else empty note without lines, else none', () => {
  const h = harness();
  assert.equal(h.log.note, EMPTY_NOTE);
  h.log.sync(true);
  assert.equal(h.log.note, EMPTY_NOTE);
  h.sources[0].emit('line', { data: 'x', lastEventId: '1' });
  assert.equal(h.log.note, null);
  h.sources[0].readyState = 2;
  h.sources[0].emit('error');
  assert.equal(h.log.note, CLOSED_NOTE);
});
