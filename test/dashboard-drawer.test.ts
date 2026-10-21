// dashboard/src/lib/drawer.ts: the job drawer's tab order, default and keyboard moves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DRAWER_TAB, DRAWER_TABS, PANE_DEFAULT, PANE_GUTTER, PANE_MIN, clampPaneWidth, moveDrawerTab, paneKey, paneMax, type DrawerTab } from '../dashboard/src/lib/drawer.ts';

test('drawer tabs: order and default', () => {
  assert.deepEqual(DRAWER_TABS, ['thread', 'log', 'agents', 'files', 'timeline', 'details']);
  assert.equal(DEFAULT_DRAWER_TAB, 'thread');
  assert.ok(DRAWER_TABS.includes(DEFAULT_DRAWER_TAB));
  const tab: DrawerTab = 'details';
  assert.ok(DRAWER_TABS.includes(tab));
});

test('moveDrawerTab wraps and handles Home/End', () => {
  assert.equal(moveDrawerTab('thread', 'ArrowRight'), 'log');
  assert.equal(moveDrawerTab('log', 'ArrowRight'), 'agents');
  assert.equal(moveDrawerTab('agents', 'ArrowRight'), 'files');
  assert.equal(moveDrawerTab('timeline', 'ArrowRight'), 'details');
  assert.equal(moveDrawerTab('details', 'ArrowRight'), 'thread', 'Right wraps from the last tab to the first');
  assert.equal(moveDrawerTab('files', 'ArrowLeft'), 'agents');
  assert.equal(moveDrawerTab('agents', 'ArrowLeft'), 'log');
  assert.equal(moveDrawerTab('log', 'ArrowLeft'), 'thread');
  assert.equal(moveDrawerTab('thread', 'ArrowLeft'), 'details', 'Left wraps from the first tab to the last');
  for (const from of DRAWER_TABS) {
    assert.equal(moveDrawerTab(from, 'Home'), 'thread', `Home from ${from}`);
    assert.equal(moveDrawerTab(from, 'End'), 'details', `End from ${from}`);
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a', 'Escape']) assert.equal(moveDrawerTab(from, key), null, `${JSON.stringify(key)} from ${from}`);
  }
  // A full lap either way comes back to the start.
  let at: DrawerTab = 'files';
  for (let i = 0; i < DRAWER_TABS.length; i++) at = moveDrawerTab(at, 'ArrowRight') ?? at;
  assert.equal(at, 'files');
  for (let i = 0; i < DRAWER_TABS.length; i++) at = moveDrawerTab(at, 'ArrowLeft') ?? at;
  assert.equal(at, 'files');
});

test('pane width clamps to the viewport and steps', () => {
  assert.deepEqual([PANE_MIN, PANE_DEFAULT, PANE_GUTTER], [360, 640, 236]);
  // Clamp: [PANE_MIN, viewport - PANE_GUTTER], whole px; a bad stored value takes the default.
  assert.equal(paneMax(1204), 968);
  assert.equal(paneMax(500), 360, 'never under the minimum');
  assert.equal(clampPaneWidth(640, 1204), 640);
  assert.equal(clampPaneWidth(100, 1204), 360, 'up to the minimum');
  assert.equal(clampPaneWidth(2000, 1204), 968, 'down to the maximum');
  assert.equal(clampPaneWidth(968, 1204), 968, 'the maximum itself');
  assert.equal(clampPaneWidth(360, 1204), 360, 'the minimum itself');
  assert.equal(clampPaneWidth(500.6, 1204), 501, 'whole px');
  assert.equal(clampPaneWidth(Number.NaN, 1204), 640, 'NaN takes the default');
  assert.equal(clampPaneWidth(Number('wide'), 1204), 640);
  assert.equal(clampPaneWidth(2000, Infinity), 2000, 'unmeasured: only the minimum applies');
  assert.equal(clampPaneWidth(640, 800), 564, 'a narrow window re-clamps the stored width');
  // Keys: Left widens (the separator is the left edge), Right narrows, Shift steps 64.
  assert.equal(paneKey(640, 'ArrowLeft', false, 1204), 656);
  assert.equal(paneKey(640, 'ArrowLeft', true, 1204), 704);
  assert.equal(paneKey(640, 'ArrowRight', false, 1204), 624);
  assert.equal(paneKey(640, 'ArrowRight', true, 1204), 576);
  assert.equal(paneKey(960, 'ArrowLeft', false, 1204), 968, 'Left stops at the maximum');
  assert.equal(paneKey(968, 'ArrowLeft', true, 1204), 968);
  assert.equal(paneKey(370, 'ArrowRight', false, 1204), 360, 'Right stops at the minimum');
  assert.equal(paneKey(360, 'ArrowRight', true, 1204), 360);
  assert.equal(paneKey(640, 'Home', false, 1204), 360);
  assert.equal(paneKey(640, 'End', false, 1204), 968);
  assert.equal(paneKey(640, 'Home', true, 1204), 360, 'Shift does not change Home');
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'Escape', 'a']) assert.equal(paneKey(640, key, false, 1204), null, JSON.stringify(key));
});

test('paneMax stops at the given sidebar gutter', () => {
  // The rail (64) and a wide sidebar (360) move the drawer's edge; leaving the gutter out keeps the default 236.
  assert.equal(paneMax(1204, 64), 1140);
  assert.equal(paneMax(1204, 360), 844);
  assert.equal(paneMax(1204, 236), paneMax(1204));
  assert.equal(paneMax(400, 64), 360, 'never under the minimum');
  assert.equal(clampPaneWidth(2000, 1204, 64), 1140);
  assert.equal(clampPaneWidth(2000, 1204, 360), 844);
  assert.equal(clampPaneWidth(2000, 1204), 968, 'the old two-argument call uses 236');
  assert.equal(paneKey(1130, 'ArrowLeft', false, 1204, 64), 1140, 'Left stops at the rail gutter');
  assert.equal(paneKey(640, 'End', false, 1204, 360), 844);
  assert.equal(paneKey(640, 'End', false, 1204), 968);
});
