// dashboard/src/lib/menu.ts: where the session log's popovers open.
import test from 'node:test';
import assert from 'node:assert/strict';
import { keepFocus, parkFocus, placeMenu } from '../dashboard/src/lib/menu.ts';

const VIEW = { vw: 1440, vh: 900 };

test('placeMenu opens below, right-aligned', () => {
  // A 256×200 panel under a trigger at x 900..1000, y 100..128.
  assert.deepEqual(placeMenu({ top: 100, bottom: 128, right: 1000, ...VIEW, width: 256, height: 200 }), { left: 744, top: 132 });
  assert.deepEqual(placeMenu({ top: 100, bottom: 128, right: 1000, ...VIEW, width: 256, height: 200, gap: 10 }), { left: 744, top: 138 }, 'the gap is configurable');
  // Fits exactly below: stays below.
  assert.deepEqual(placeMenu({ top: 600, bottom: 628, right: 1000, ...VIEW, width: 256, height: 260 }), { left: 744, top: 632 });
});

test('placeMenu flips above', () => {
  // Near the bottom: 900 - 828 - 4 - 8 = 60 below, 800 - 4 - 8 = 788 above.
  assert.deepEqual(placeMenu({ top: 800, bottom: 828, right: 1000, ...VIEW, width: 256, height: 200 }), { left: 744, top: 596 });
  // Too tall for below but above has less room: stays below, clamped to the bottom gutter.
  assert.deepEqual(placeMenu({ top: 300, bottom: 328, right: 1000, ...VIEW, width: 256, height: 600 }), { left: 744, top: 292 });
});

test('placeMenu clamps to the gutter', () => {
  // A trigger at the left edge: the panel's left stays 8px in.
  assert.equal(placeMenu({ top: 100, bottom: 128, right: 40, ...VIEW, width: 256, height: 200 }).left, 8);
  // A trigger past the right edge: the panel's right edge stays 8px in.
  assert.equal(placeMenu({ top: 100, bottom: 128, right: 1500, ...VIEW, width: 256, height: 200 }).left, 1440 - 8 - 256);
  // A phone narrower than the panel: it shrinks to the viewport less both gutters and starts at the gutter.
  assert.equal(placeMenu({ top: 100, bottom: 128, right: 200, vw: 240, vh: 600, width: 256, height: 200 }).left, 8);
  // A panel taller than the viewport sits at the top gutter.
  assert.equal(placeMenu({ top: 300, bottom: 328, right: 1000, vw: 1440, vh: 400, width: 256, height: 500 }).top, 8);
  // A trigger above the viewport top (scrolled): the panel stays 8px in.
  assert.equal(placeMenu({ top: -60, bottom: -32, right: 1000, ...VIEW, width: 256, height: 200 }).top, 8);
});

/** A stand-in for the DOM bits parkFocus and keepFocus touch: focus() records itself as the document's active element. */
function fakeDom() {
  const doc = { activeElement: null as unknown, body: { name: 'body' } as unknown };
  type Node = { name: string; focus(): void; [k: string]: unknown };
  const node = (name: string, extra: Record<string, unknown> = {}): Node => {
    const n: Node = { name, ...extra, focus: () => void (doc.activeElement = n) };
    return n;
  };
  return { doc, node };
}

test('parkFocus holds focus on the panel while a choice saves, then returns it to the checked radio', () => {
  const { doc, node } = fakeDom();
  const checked = node('checked');
  const selectors: string[] = [];
  const panel = node('panel', { querySelector: (s: string) => (selectors.push(s), checked) });
  const radio = node('radio', { closest: (s: string) => (s === '[role="dialog"]' ? panel : null) });
  radio.focus();
  const restore = parkFocus(radio as any, doc as any);
  assert.equal(doc.activeElement, panel, 'focus moves to the panel before the radios are disabled, so it never falls to <body>');
  restore();
  assert.equal(doc.activeElement, checked, 'then back to the checked radio');
  assert.deepEqual(selectors, ['input[type="radio"]:checked:not(:disabled)']);
});

test('parkFocus leaves focus alone once it moved on, and without a panel', () => {
  const { doc, node } = fakeDom();
  const checked = node('checked');
  const panel = node('panel', { querySelector: () => checked });
  const radio = node('radio', { closest: () => panel });
  const restore = parkFocus(radio as any, doc as any);
  const elsewhere = node('elsewhere');
  elsewhere.focus(); // Escape closed the panel and refocused its button, or a click went elsewhere.
  restore();
  assert.equal(doc.activeElement, elsewhere, 'the restore does not steal focus back');
  const loose = node('loose', { closest: () => null });
  loose.focus();
  parkFocus(loose as any, doc as any)();
  assert.equal(doc.activeElement, loose, 'outside a dialog, nothing moves');
  parkFocus(null, doc as any)();
});

test('keepFocus refocuses a button that disabled itself, only if it had focus and nothing took it', () => {
  const { doc, node } = fakeDom();
  const button = node('button');
  button.focus();
  let restore = keepFocus(button as any, doc as any);
  doc.activeElement = doc.body; // Disabled while pending: the browser drops focus to <body>.
  restore();
  assert.equal(doc.activeElement, button);
  restore = keepFocus(button as any, doc as any);
  const other = node('other');
  other.focus();
  restore();
  assert.equal(doc.activeElement, other, 'focus that moved on stays put');
  doc.activeElement = doc.body;
  restore = keepFocus(button as any, doc as any);
  restore();
  assert.equal(doc.activeElement, doc.body, 'a button clicked without focus (Safari) is not focused afterwards');
});
