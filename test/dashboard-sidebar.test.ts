// The sidebar's width, its icon-only rail and the separator's keys (dashboard/src/lib/sidebar.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, SIDEBAR_RAIL, clampSidebarWidth, railTipPlace, readSidebar, sidebarDrag, sidebarKey, sidebarShown } from '../dashboard/src/lib/sidebar.ts';
import { PANE_GUTTER } from '../dashboard/src/lib/drawer.ts';

test('clampSidebarWidth falls back and clamps', () => {
  assert.deepEqual([SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT, SIDEBAR_RAIL], [184, 360, 236, 64]);
  assert.equal(SIDEBAR_DEFAULT, PANE_GUTTER, 'the default is the drawer gutter');
  for (const bad of [NaN, Infinity, -Infinity]) assert.equal(clampSidebarWidth(bad), 236, String(bad));
  assert.equal(clampSidebarWidth(100), 184);
  assert.equal(clampSidebarWidth(184), 184);
  assert.equal(clampSidebarWidth(250.6), 251, 'whole px');
  assert.equal(clampSidebarWidth(360), 360);
  assert.equal(clampSidebarWidth(9999), 360);
});

test('sidebarDrag snaps below the minimum to the rail', () => {
  assert.deepEqual(sidebarDrag(183.9), { compact: true });
  assert.deepEqual(sidebarDrag(64), { compact: true });
  assert.deepEqual(sidebarDrag(-50), { compact: true });
  assert.deepEqual(sidebarDrag(184), { compact: false, width: 184 }, 'exactly the minimum stays expanded');
  assert.deepEqual(sidebarDrag(300.4), { compact: false, width: 300 });
  assert.deepEqual(sidebarDrag(500), { compact: false, width: 360 }, 'past the maximum clamps');
});

test('sidebarKey steps, snaps, toggles and ignores other keys', () => {
  const at = (width: number, compact = false) => ({ width, compact });
  assert.deepEqual(sidebarKey(at(236), 'ArrowRight', false), at(252));
  assert.deepEqual(sidebarKey(at(236), 'ArrowRight', true), at(300));
  assert.deepEqual(sidebarKey(at(350), 'ArrowRight', false), at(360), 'clamped to the maximum');
  assert.deepEqual(sidebarKey(at(236), 'ArrowLeft', false), at(220));
  assert.deepEqual(sidebarKey(at(300), 'ArrowLeft', true), at(236), 'Shift steps 64');
  assert.deepEqual(sidebarKey(at(236), 'ArrowLeft', true), at(236, true), 'a Shift step below the minimum snaps to the rail');
  assert.deepEqual(sidebarKey(at(184), 'ArrowLeft', false), at(184, true), 'left from the minimum snaps to the rail');
  assert.deepEqual(sidebarKey(at(200), 'ArrowLeft', false), at(184));
  assert.deepEqual(sidebarKey(at(200), 'ArrowLeft', true), at(200, true), 'a step below the minimum snaps, keeping the width');
  assert.deepEqual(sidebarKey(at(300, true), 'ArrowRight', false), at(184), 'right from the rail gives the minimum');
  assert.deepEqual(sidebarKey(at(300, true), 'ArrowRight', true), at(184));
  assert.deepEqual(sidebarKey(at(300, true), 'ArrowLeft', false), at(300, true), 'left on the rail stays on it');
  assert.deepEqual(sidebarKey(at(300), 'Home', false), at(300, true));
  assert.deepEqual(sidebarKey(at(300, true), 'End', false), at(360));
  assert.deepEqual(sidebarKey(at(300), 'Enter', false), at(300, true), 'Enter collapses');
  assert.deepEqual(sidebarKey(at(300, true), 'Enter', false), at(300), 'and restores the last expanded width');
  for (const key of ['ArrowUp', 'ArrowDown', 'Tab', ' ', 'Escape', 'a', 'PageUp']) assert.equal(sidebarKey(at(236), key, false), null, key);
});

test('readSidebar tolerates missing, bad and throwing storage', () => {
  const from = (store: Record<string, string>) => (k: string, d: string) => store[k] ?? d;
  assert.deepEqual(readSidebar(from({})), { width: 236, compact: false }, 'missing: the defaults');
  assert.deepEqual(readSidebar(from({ sidebarWidth: '300', sidebarCompact: '1' })), { width: 300, compact: true });
  assert.deepEqual(readSidebar(from({ sidebarWidth: 'wide', sidebarCompact: 'yes' })), { width: 236, compact: false }, 'garbage: the defaults');
  assert.deepEqual(readSidebar(from({ sidebarWidth: '', sidebarCompact: '0' })), { width: 236, compact: false }, 'empty: the default');
  assert.deepEqual(readSidebar(from({ sidebarWidth: '9000' })), { width: 360, compact: false }, 'out of range clamps');
  assert.deepEqual(readSidebar(from({ sidebarWidth: '10' })), { width: 184, compact: false });
  assert.deepEqual(
    readSidebar(() => {
      throw new Error('SecurityError');
    }),
    { width: 236, compact: false },
    'a throwing getter gives the defaults',
  );
});

test('sidebarShown is the rail or the width', () => {
  assert.equal(sidebarShown({ width: 300, compact: true }), 64);
  assert.equal(sidebarShown({ width: 300, compact: false }), 300);
  assert.equal(sidebarShown({ width: NaN, compact: false }), 236);
  assert.equal(sidebarShown({ width: 1000, compact: false }), 360);
});

test('railTipPlace puts the tooltip 8px right of the control, at its middle', () => {
  assert.deepEqual(railTipPlace({ top: 100, right: 56, height: 36 }), { top: 118, left: 64 });
});
