// dashboard/src/lib/drawer.ts: the job drawer's tab order, default, keyboard moves and tab-switch scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARD_MIN, DEFAULT_DRAWER_TAB, DRAWER_TABS, PANE_DEFAULT, PANE_MIN, clampPaneWidth, moveDrawerTab, paneKey, paneMax, paneMode, tabScrollTop, type DrawerTab } from '../dashboard/src/lib/drawer.ts';

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

test('tabScrollTop lands a new tab under the stuck strip', () => {
  assert.equal(tabScrollTop(40, 120), 40, 'above the head: unchanged');
  assert.equal(tabScrollTop(120, 120), 120, 'exactly at the strip');
  assert.equal(tabScrollTop(900, 120), 120, 'past the head: the head height, so the new tab starts under the strip');
  assert.equal(tabScrollTop(0, 120), 0, 'at the top');
  assert.equal(tabScrollTop(0, 0), 0);
  assert.equal(tabScrollTop(300, 0), 0, 'no head: the top');
  assert.equal(tabScrollTop(-10, 120), 0, 'a negative scroll clamps to 0');
  assert.equal(tabScrollTop(50, -5), 0, 'a negative head clamps to 0');
});

test('pane width clamps, steps and picks its mode', () => {
  assert.deepEqual([PANE_MIN, BOARD_MIN, PANE_DEFAULT], [360, 320, 640]);
  // Mode: split from md up once the main column holds both minimums (680px), else full.
  assert.equal(paneMode(680, true), 'split', 'exactly PANE_MIN + BOARD_MIN');
  assert.equal(paneMode(679, true), 'full', 'one px short');
  assert.equal(paneMode(1204, true), 'split');
  assert.equal(paneMode(1204, false), 'full', 'below md always full');
  assert.equal(paneMode(0, true), 'full', 'not measured yet');
  // Clamp: [PANE_MIN, available - BOARD_MIN], whole px; a bad stored value takes the default.
  assert.equal(paneMax(1204), 884);
  assert.equal(paneMax(600), PANE_MIN, 'never under the minimum');
  assert.equal(clampPaneWidth(640, 1204), 640);
  assert.equal(clampPaneWidth(100, 1204), 360, 'up to the minimum');
  assert.equal(clampPaneWidth(2000, 1204), 884, 'down to the maximum');
  assert.equal(clampPaneWidth(884, 1204), 884, 'the maximum itself');
  assert.equal(clampPaneWidth(360, 1204), 360, 'the minimum itself');
  assert.equal(clampPaneWidth(500.6, 1204), 501, 'whole px');
  assert.equal(clampPaneWidth(Number.NaN, 1204), 640, 'NaN takes the default');
  assert.equal(clampPaneWidth(Number('wide'), 1204), 640);
  assert.equal(clampPaneWidth(2000, Infinity), 2000, 'unmeasured: only the minimum applies');
  assert.equal(clampPaneWidth(640, 800), 480, 'a narrow column re-clamps the stored width');
  // Keys: Left widens, Right narrows, by 16 or 64 with Shift; Home and End go to the ends; all clamped.
  assert.equal(paneKey(640, 'ArrowLeft', false, 1204), 656);
  assert.equal(paneKey(640, 'ArrowLeft', true, 1204), 704);
  assert.equal(paneKey(640, 'ArrowRight', false, 1204), 624);
  assert.equal(paneKey(640, 'ArrowRight', true, 1204), 576);
  assert.equal(paneKey(880, 'ArrowLeft', false, 1204), 884, 'Left stops at the maximum');
  assert.equal(paneKey(884, 'ArrowLeft', true, 1204), 884);
  assert.equal(paneKey(370, 'ArrowRight', false, 1204), 360, 'Right stops at the minimum');
  assert.equal(paneKey(360, 'ArrowRight', true, 1204), 360);
  assert.equal(paneKey(640, 'Home', false, 1204), 360);
  assert.equal(paneKey(640, 'End', false, 1204), 884);
  assert.equal(paneKey(640, 'Home', true, 1204), 360, 'Shift does not change Home');
  for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'Escape', 'a']) assert.equal(paneKey(640, key, false, 1204), null, JSON.stringify(key));
});
