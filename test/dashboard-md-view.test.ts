// dashboard/src/lib/md-view.ts: the Rendered/Raw choice per surface and when a string may go through md().
import test from 'node:test';
import assert from 'node:assert/strict';
import { MD_MAX, MD_SURFACES, MD_VIEWS, PROSE_KINDS, mdPrefKey, readMdView, renderable } from '../dashboard/src/lib/md-view.ts';

test("readMdView reads only 'raw' as raw", () => {
  for (const saved of [null, undefined, '', 'bogus', 'RAW', 'rendered', ' raw']) assert.equal(readMdView(saved), 'rendered', String(saved));
  assert.equal(readMdView('raw'), 'raw');
});

test('surfaces, views, prose kinds and pref keys', () => {
  assert.deepEqual(MD_SURFACES, ['files', 'thread', 'session']);
  assert.deepEqual(MD_VIEWS, ['rendered', 'raw']);
  assert.deepEqual(PROSE_KINDS, ['text', 'thinking']);
  assert.equal(mdPrefKey('thread'), 'mdView.thread');
  assert.deepEqual(MD_SURFACES.map(mdPrefKey), ['mdView.files', 'mdView.thread', 'mdView.session']);
});

test('renderable honours the view and the 20k cap', () => {
  assert.equal(MD_MAX, 20000);
  assert.equal(renderable('x'.repeat(20000), 'rendered'), true);
  assert.equal(renderable('x'.repeat(20001), 'rendered'), false);
  assert.equal(renderable('x', 'raw'), false);
  assert.equal(renderable('', 'rendered'), true);
});
