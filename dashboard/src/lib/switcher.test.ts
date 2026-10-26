// The registered projects as the switcher, the Overview and the command bar list them: sorted, with their state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { switcherEntries } from './switcher.ts';
import type { MachineProjectSummary, ProjectsResponse } from './types.ts';

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
