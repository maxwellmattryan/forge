// The registered projects as the switcher, the Overview and the command bar list them: sorted, with their state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADD_PROJECT, othersWaiting, selectionOpenable, switcherChoice, switcherEntries, switcherKey, switcherKeyShortcuts, switcherOptions, switcherShortcutLabel, type SwitcherEntry } from './switcher.ts';
import { PROJECT_NAME_SOURCE, type MachineProjectSummary, type ProjectsResponse } from '../core/types.ts';
import type { Route } from './routes.ts';

const project = (name: string, over: Partial<MachineProjectSummary> = {}): MachineProjectSummary => ({
  name,
  path: `/src/${name}`,
  status: 'ok',
  loaded: true,
  jobs: { active: 2, waiting: 1 },
  latest: null,
  daemon: { enabled: true, wanted: true, foreman: false, office: 'off', live: 1, maxConcurrent: 3 },
  ...over,
});
const response = (projects: MachineProjectSummary[]): ProjectsResponse => ({ error: null, machine: { maxConcurrent: 4, live: 1, launchPermissionMode: null }, projects });

test('switcherEntries', () => {
  assert.deepEqual(switcherEntries(null), [], 'before the list loads');
  assert.deepEqual(switcherEntries(response([])), []);
  const entries = switcherEntries(
    response([
      project('web', { jobs: { active: 0, waiting: 0 } }),
      project('gone', { status: 'missing', loaded: false, jobs: null, daemon: null }),
      project('api'),
      project('fresh', { status: 'not-initialized', loaded: false, jobs: null, daemon: null }),
      project('broken', { loaded: false, jobs: null, daemon: null }),
    ]),
  );
  assert.deepEqual(
    entries.map((e) => e.name),
    ['api', 'broken', 'fresh', 'gone', 'web'],
    'sorted by name',
  );
  const by = Object.fromEntries(entries.map((e) => [e.name, e]));
  assert.deepEqual(by.api, { name: 'api', path: '/src/api', state: 'ok', openable: true, waiting: 1, active: 2, daemon: { live: 1, maxConcurrent: 3 } });
  assert.deepEqual([by.web.state, by.web.openable, by.web.waiting], ['ok', true, 0]);
  assert.deepEqual([by.gone.state, by.gone.openable, by.gone.waiting, by.gone.daemon], ['missing', false, 0, null], 'missing is never openable');
  assert.deepEqual([by.fresh.state, by.fresh.openable], ['unavailable', false], 'not loaded is unavailable');
  assert.deepEqual([by.broken.state, by.broken.openable], ['unavailable', false]);
});

test('switcherOptions', () => {
  assert.ok(!new RegExp(PROJECT_NAME_SOURCE).test(ADD_PROJECT), 'Add project can never be a registered name');
  const labels = { add: 'Add project', hint: (e: SwitcherEntry) => (e.openable ? undefined : `hint ${e.name}`) };
  const add = { value: ADD_PROJECT, label: 'Add project', icon: 'command', action: true };
  assert.deepEqual(switcherOptions([], labels, null), [{ ...add, separator: false }], 'alone, with no rule');
  const entries = switcherEntries(
    response([
      project('web'),
      project('gone', { status: 'missing', loaded: false, jobs: null, daemon: null }),
      project('api'),
      project('idle', { jobs: { active: 1, waiting: 0 } }),
    ]),
  );
  // api is current and waits; web waits; idle waits on nothing; gone is missing.
  assert.deepEqual(switcherOptions(entries, labels, 'api'), [
    { value: 'api', label: 'api', disabled: false, hint: undefined, badge: false },
    { value: 'gone', label: 'gone', disabled: true, hint: 'hint gone', badge: false },
    { value: 'idle', label: 'idle', disabled: false, hint: undefined, badge: false },
    { value: 'web', label: 'web', disabled: false, hint: undefined, badge: true },
    { ...add, separator: true },
  ]);
  assert.deepEqual(
    switcherOptions(entries, labels, null).map((o) => o.badge),
    [true, false, false, true, undefined],
    'nothing selected: every waiting openable project, never Add project',
  );
});

test('othersWaiting', () => {
  assert.equal(othersWaiting([], 'api'), 0);
  assert.equal(othersWaiting([], null), 0);
  const entries = switcherEntries(
    response([
      project('api', { jobs: { active: 0, waiting: 2 } }),
      project('web', { jobs: { active: 0, waiting: 3 } }),
      project('idle', { jobs: { active: 4, waiting: 0 } }),
      project('gone', { status: 'missing', loaded: false, jobs: null, daemon: null }),
    ]),
  );
  assert.equal(othersWaiting(entries, 'api'), 3, 'the current project is excluded');
  assert.equal(othersWaiting(entries, 'web'), 2);
  assert.equal(othersWaiting(entries, null), 5, 'nothing selected: every openable project');
  const onlyCurrent = switcherEntries(response([project('api', { jobs: { active: 0, waiting: 2 } }), project('idle', { jobs: { active: 0, waiting: 0 } })]));
  assert.equal(othersWaiting(onlyCurrent, 'api'), 0, 'only the current project waits');
  // A non-openable entry is ignored even if it reports waiting jobs.
  const closed: SwitcherEntry = { name: 'broken', path: '/src/broken', state: 'unavailable', openable: false, waiting: 7, active: 0, daemon: null };
  assert.equal(othersWaiting([...onlyCurrent, closed], 'api'), 0, 'non-openable entries never count');
});

test('switcherChoice', () => {
  const page: Route = { scope: 'project', project: 'api', view: 'issues' };
  const overview: Route = { scope: 'global', view: 'overview' };
  const machine: Route = { scope: 'global', view: 'machine' };
  // Add project opens the dialog wherever it is chosen, and never navigates.
  assert.deepEqual(switcherChoice(ADD_PROJECT, 'api', page), { add: true });
  assert.deepEqual(switcherChoice(ADD_PROJECT, null, overview), { add: true });
  assert.deepEqual(switcherChoice(ADD_PROJECT, null, machine), { add: true });
  assert.deepEqual(switcherChoice(ADD_PROJECT, 'api', machine), { add: true });
  assert.equal(switcherChoice('api', 'api', page), null, 'the current project');
  assert.deepEqual(switcherChoice('web', 'api', page), { hash: '#/p/web/issues' }, 'the same view');
  assert.deepEqual(switcherChoice('web', null, overview), { hash: '#/p/web/pipeline' }, 'Pipeline from a global page');
  assert.deepEqual(switcherChoice('web', null, machine), { hash: '#/p/web/pipeline' });
});

test('selectionOpenable', () => {
  const entries = switcherEntries(response([project('web'), project('gone', { status: 'missing', loaded: false, jobs: null, daemon: null })]));
  assert.equal(selectionOpenable(entries, 'web'), true);
  assert.equal(selectionOpenable(entries, 'gone'), false, 'moved or deleted: its directory is missing');
  assert.equal(selectionOpenable(entries, 'old-name'), false, 'renamed or removed: not registered');
  assert.equal(selectionOpenable([], 'web'), false);
});

test('switcherKey', () => {
  const none = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
  const cmd = { ...none, key: 'o', metaKey: true, mac: true };
  const ctrl = { ...none, key: 'o', ctrlKey: true, mac: false };
  assert.equal(switcherKey(cmd), 'toggle', 'Cmd+O on a Mac');
  assert.equal(switcherKey(ctrl), 'toggle', 'Ctrl+O elsewhere');
  assert.equal(switcherKey({ ...cmd, key: 'O' }), 'toggle', 'Caps Lock');
  assert.equal(switcherKey({ ...ctrl, key: 'O' }), 'toggle', 'Caps Lock');
  assert.equal(switcherKey({ ...none, key: 'o', ctrlKey: true, mac: true }), null, 'Ctrl+O on a Mac');
  assert.equal(switcherKey({ ...none, key: 'o', metaKey: true, mac: false }), null, 'Meta+O elsewhere');
  assert.equal(switcherKey({ ...cmd, ctrlKey: true }), null, 'Cmd+Ctrl+O on a Mac');
  assert.equal(switcherKey({ ...ctrl, metaKey: true }), null, 'Cmd+Ctrl+O elsewhere');
  for (const base of [cmd, ctrl]) {
    assert.equal(switcherKey({ ...base, altKey: true }), null, 'Alt held');
    assert.equal(switcherKey({ ...base, shiftKey: true }), null, 'Shift held');
    assert.equal(switcherKey({ ...none, key: 'o', mac: base.mac }), null, 'a bare o');
    assert.equal(switcherKey({ ...base, key: 'k' }), null, 'another key');
    assert.equal(switcherKey({ ...base, key: ',' }), null, 'another key');
    for (const flag of ['palette', 'settings', 'addProject', 'drawer', 'repeat'] as const) {
      assert.equal(switcherKey({ ...base, [flag]: true }), 'block', `${flag} blocks`);
    }
    assert.equal(switcherKey({ ...base, composing: true }), null, 'composing');
    assert.equal(switcherKey({ ...base, composing: true, palette: true, settings: true, addProject: true, drawer: true, repeat: true }), null, 'composing, whatever else is set');
    assert.equal(switcherKey({ ...base, key: 'k', palette: true }), null, 'a blocked state is not the chord');
  }
});

test('switcher shortcut labels', () => {
  assert.equal(switcherShortcutLabel('MacIntel'), '⌘O');
  assert.equal(switcherShortcutLabel('iPad'), '⌘O');
  assert.equal(switcherShortcutLabel('Win32'), 'Ctrl O');
  assert.equal(switcherShortcutLabel(''), 'Ctrl O');
  assert.equal(switcherKeyShortcuts('MacIntel'), 'Meta+O');
  assert.equal(switcherKeyShortcuts('Linux x86_64'), 'Control+O');
});
