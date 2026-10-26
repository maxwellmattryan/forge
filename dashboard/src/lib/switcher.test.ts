// The registered projects as the switcher, the Overview and the command bar list them: sorted, with their state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADD_PROJECT, selectionOpenable, switcherChoice, switcherEntries, switcherOptions, type SwitcherEntry } from './switcher.ts';
import { PROJECT_NAME_SOURCE, type MachineProjectSummary, type ProjectsResponse } from './types.ts';
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
const response = (projects: MachineProjectSummary[]): ProjectsResponse => ({ error: null, machine: { maxConcurrent: 4, source: 'auto', live: 1 }, projects });

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
  assert.deepEqual(switcherOptions([], labels), [{ ...add, separator: false }], 'alone, with no rule');
  const entries = switcherEntries(response([project('web'), project('gone', { status: 'missing', loaded: false, jobs: null, daemon: null }), project('api')]));
  assert.deepEqual(switcherOptions(entries, labels), [
    { value: 'api', label: 'api', disabled: false, hint: undefined },
    { value: 'gone', label: 'gone', disabled: true, hint: 'hint gone' },
    { value: 'web', label: 'web', disabled: false, hint: undefined },
    { ...add, separator: true },
  ]);
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
