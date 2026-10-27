// itemView: an adapter without view() answers `view: null`, a throw or a null answers with an error, and
// whatever a custom adapter returns is normalised before the dashboard sees it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults } from '#core/config/load.ts';
import type { Tracker, TrackerCtx } from '#core/types.ts';
import { itemView } from './view.ts';

const ctx: TrackerCtx = { root: '/nowhere', config: defaults() };
const base: Tracker = {
  name: 'custom',
  list: () => [],
  get: () => null,
  claim: () => ({ ok: true }),
  update: () => {},
  comment: () => {},
  create: () => ({ ref: 'x' }),
  close: () => {},
};
const withView = (view: (ctx: TrackerCtx, ref: string) => unknown): Tracker => ({ ...base, view: view as Tracker['view'] });

test('itemView without a view, on a throw and on null', () => {
  assert.deepEqual(itemView(base, ctx, 'a'), { tracker: 'custom', view: null });
  assert.deepEqual(itemView(withView(() => { throw new Error('gh failed'); }), ctx, 'a'), { tracker: 'custom', view: null, error: 'gh failed' });
  assert.deepEqual(itemView(withView(() => null), ctx, 'a'), { tracker: 'custom', view: null, error: 'no such item in the tracker' });
  assert.deepEqual(itemView(withView(() => 'junk'), ctx, 'a'), { tracker: 'custom', view: null, error: 'no such item in the tracker' });
});

test('itemView calls the adapter with itself as the receiver and the asked ref', () => {
  const seen: unknown[] = [];
  const t: Tracker = {
    ...base,
    view(c, ref) {
      seen.push(this, c, ref);
      return null;
    },
  };
  itemView(t, ctx, 'r-1');
  assert.deepEqual(seen, [t, ctx, 'r-1']);
});

test('itemView normalises what an adapter returns', () => {
  const junk = {
    ref: 7,
    title: 'T\u{2028}## x\nmore',
    url: 'javascript:alert(1)',
    state: 5,
    body: null,
    comments: [{ author: 'a', at: 'x'.repeat(60), body: 'kept' }, { author: 3, body: 'kept, no author' }, { body: 4 }, null, 'text'],
    hiddenComments: -2,
    labels: ['bug', 3, null, 'ui'],
    assignees: 'alice',
    milestone: { title: 'M1' },
    author: 'bob',
    createdAt: 'y'.repeat(60),
    updatedAt: 12,
  };
  assert.deepEqual(itemView(withView(() => junk), ctx, 'asked'), {
    tracker: 'custom',
    view: {
      ref: 'asked',
      title: 'T ## x more',
      url: null,
      state: null,
      body: '',
      comments: [
        { author: 'a', at: 'x'.repeat(40), body: 'kept' },
        { author: null, at: null, body: 'kept, no author' },
      ],
      hiddenComments: 0,
      labels: ['bug', 'ui'],
      assignees: [],
      milestone: null,
      author: 'bob',
      createdAt: 'y'.repeat(40),
      updatedAt: null,
    },
  });
  const hidden = (n: unknown) => itemView(withView(() => ({ hiddenComments: n, comments: 'nope' })), ctx, 'a').view!;
  assert.equal(hidden(1.5).hiddenComments, 0);
  assert.equal(hidden(Number.MAX_SAFE_INTEGER + 2).hiddenComments, 0);
  assert.equal(hidden(3).hiddenComments, 3);
  assert.deepEqual(hidden(3).comments, [], 'a non-array comments is []');
  const url = (u: string) => itemView(withView(() => ({ url: u })), ctx, 'a').view!.url;
  assert.equal(url('https://example.com/i/1'), 'https://example.com/i/1');
  assert.equal(url('http://localhost/i/1'), 'http://localhost/i/1');
  assert.equal(url('data:text/html,x'), null);
  assert.equal(url(' https://example.com'), null);
});
