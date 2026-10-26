// The Settings tabs a page offers with and without a selected project, the tab it opens on, and the arrow keys' walk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SETTINGS_TABS, moveTab, openingTab, settingsTabsFor } from './settings.ts';

test('settingsTabsFor and moveTab', () => {
  const none = settingsTabsFor(false);
  assert.deepEqual(
    none.map((t) => t.id),
    ['general', 'about'],
    'no project: only General and About',
  );
  assert.equal(settingsTabsFor(true), SETTINGS_TABS, 'a project: every tab');

  const rows: [string, readonly (typeof SETTINGS_TABS)[number][], string | undefined, string, string][] = [
    ['a saved unavailable tab opens General', none, undefined, 'pipeline', 'general'],
    ['an unknown saved tab opens General', none, undefined, 'nope', 'general'],
    ['a saved offered tab', none, undefined, 'about', 'about'],
    ['start wins when offered', SETTINGS_TABS, 'pipeline', 'about', 'pipeline'],
    ['start not offered: the saved tab', none, 'pipeline', 'about', 'about'],
    ['a saved project tab with a project', SETTINGS_TABS, undefined, 'daemon', 'daemon'],
  ];
  for (const [name, tabs, start, saved, want] of rows) assert.equal(openingTab(tabs, start, saved), want, name);

  // The walk wraps over the offered tabs only.
  assert.equal(moveTab('general', 'ArrowDown', none), 'about');
  assert.equal(moveTab('about', 'ArrowDown', none), 'general');
  assert.equal(moveTab('general', 'ArrowUp', none), 'about');
  assert.equal(moveTab('about', 'Home', none), 'general');
  assert.equal(moveTab('general', 'End', none), 'about');
  assert.equal(moveTab('general', 'Enter', none), null);
  // Every tab, as before.
  assert.equal(moveTab('general', 'ArrowDown'), 'pipeline');
  assert.equal(moveTab('general', 'ArrowUp'), 'about');
  assert.equal(moveTab('diagnostics', 'End'), 'about');
});
