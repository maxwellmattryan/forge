// dashboard/src/lib/drawer.ts: the job drawer's tab order, default, keyboard moves and tab-switch scroll.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DRAWER_TAB, DRAWER_TABS, moveDrawerTab, tabScrollTop, type DrawerTab } from '../dashboard/src/lib/drawer.ts';

test('drawer tabs: order and default', () => {
  assert.deepEqual(DRAWER_TABS, ['thread', 'log', 'files', 'timeline', 'details']);
  assert.equal(DEFAULT_DRAWER_TAB, 'thread');
  assert.ok(DRAWER_TABS.includes(DEFAULT_DRAWER_TAB));
  const tab: DrawerTab = 'details';
  assert.ok(DRAWER_TABS.includes(tab));
});

test('moveDrawerTab wraps and handles Home/End', () => {
  assert.equal(moveDrawerTab('thread', 'ArrowRight'), 'log');
  assert.equal(moveDrawerTab('log', 'ArrowRight'), 'files');
  assert.equal(moveDrawerTab('timeline', 'ArrowRight'), 'details');
  assert.equal(moveDrawerTab('details', 'ArrowRight'), 'thread', 'Right wraps from the last tab to the first');
  assert.equal(moveDrawerTab('files', 'ArrowLeft'), 'log');
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
