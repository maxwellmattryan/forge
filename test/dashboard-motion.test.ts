// The dashboard's motion helpers (dashboard/src/lib/motion.ts): the reduced-motion guard every Svelte transition goes
// through, and the settle rule that keeps a page load, a reconnect or a stream (re)open from animating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MOTION, SETTLE_MS, motion, prefersReducedMotion, settled } from '../dashboard/src/lib/motion.ts';

test('motion zeroes a transition when instant and passes it through otherwise', () => {
  let calls = 0;
  const fn = () => {
    calls++;
    return { duration: MOTION.base, css: (t: number) => `opacity: ${t}` };
  };
  const node = {} as Element;
  const opts = { direction: 'in' as const };
  assert.deepEqual(motion(fn, () => true)(node, undefined, opts), { duration: 0 }, 'instant: a 0ms transition');
  assert.equal(calls, 0, 'and fn is never called');
  const out = motion(fn, () => false)(node, undefined, opts) as { duration: number };
  assert.equal(out.duration, MOTION.base, 'otherwise what fn returns');
  assert.equal(calls, 1);

  // The default reads prefers-reduced-motion on every call, and a missing or throwing matchMedia counts as no preference.
  const g = globalThis as { matchMedia?: unknown };
  const saved = g.matchMedia;
  try {
    delete g.matchMedia;
    assert.equal(prefersReducedMotion(), false, 'no matchMedia');
    g.matchMedia = () => {
      throw new Error('boom');
    };
    assert.equal(prefersReducedMotion(), false, 'a throwing matchMedia');
    let reduce = true;
    g.matchMedia = (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' && reduce });
    assert.deepEqual(motion(fn)(node, undefined, opts), { duration: 0 }, 'reduced motion by default');
    reduce = false;
    assert.equal((motion(fn)(node, undefined, opts) as { duration: number }).duration, MOTION.base, 'read on every call');
  } finally {
    if (saved === undefined) delete g.matchMedia;
    else g.matchMedia = saved;
  }
});

test('settled waits out the first data, a reconnect and a stream open', () => {
  const ready = 10_000;
  assert.equal(settled(50_000, null), false, 'no data yet');
  assert.equal(settled(ready + SETTLE_MS - 1, ready), false, 'within the window after the first data or a reconnect');
  assert.equal(settled(ready + SETTLE_MS, ready), true, 'after it');
  assert.equal(settled(20_000, ready, 19_500), false, 'within the window after a stream open');
  assert.equal(settled(20_000, ready, 19_000), true, 'after the stream open');
  assert.equal(settled(20_000, ready, null, 19_200), false, 'any open mark counts, null ones are ignored');
  assert.equal(settled(20_000, ready, null, null), true, 'only null marks');
});
