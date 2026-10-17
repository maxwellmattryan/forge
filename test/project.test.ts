// projectGraph (lib/project.ts): the config-derived graph GET /api/project serves (issue #175).
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectGraph, repoGraph } from '../lib/project.ts';
import { componentProblems } from '../lib/components.ts';

const g = (components: unknown) => projectGraph({ components } as any);

test('empty and single-repo configs', () => {
  assert.deepEqual(g([]), { components: [], backing: [], edges: [], problems: 0 });
  assert.deepEqual(g(undefined), { components: [], backing: [], edges: [], problems: 0 });
  const single = g([
    { name: 'web', path: 'web', kind: 'app' },
    { name: 'api', path: 'api', kind: 'service', repo: null },
    { name: 'core', path: 'core', kind: 'library', repo: '  ' },
  ]);
  assert.deepEqual(single, {
    components: [
      { name: 'api', repo: null, kind: 'service', path: 'api' },
      { name: 'core', repo: null, kind: 'library', path: 'core' },
      { name: 'web', repo: null, kind: 'app', path: 'web' },
    ],
    backing: [],
    edges: [],
    problems: 0,
  });
});

test('multi-repo graph with build, runtime and backing edges', () => {
  const components = [
    { name: 'web', path: 'web', kind: 'app', dependsOn: [{ component: 'api', type: 'runtime' }, { component: 'ui', type: 'build' }, { component: 'api', type: 'runtime' }] },
    { name: 'api', path: 'api', kind: 'service', repo: ' acme/backend ', dependsOn: [{ backing: ' postgres ', type: 'runtime' }, { backing: 'redis', type: 'runtime' }, { component: 'ui', type: 'build' }] },
    { name: 'ui', path: 'ui', kind: 'library', repo: 'acme/design', dependsOn: [{ backing: 'postgres', type: 'build' }], commands: { test: 'secret-cmd' }, owners: ['@a'], notes: 'n' },
  ];
  const r = g(components);
  assert.deepEqual(r.components, [
    { name: 'api', repo: 'acme/backend', kind: 'service', path: 'api' },
    { name: 'ui', repo: 'acme/design', kind: 'library', path: 'ui' },
    { name: 'web', repo: null, kind: 'app', path: 'web' },
  ]);
  assert.deepEqual(r.backing, ['postgres', 'redis']);
  assert.deepEqual(r.edges, [
    { from: 'api', to: 'postgres', target: 'backing', type: 'runtime' },
    { from: 'api', to: 'redis', target: 'backing', type: 'runtime' },
    { from: 'api', to: 'ui', target: 'component', type: 'build' },
    { from: 'ui', to: 'postgres', target: 'backing', type: 'build' },
    { from: 'web', to: 'api', target: 'component', type: 'runtime' },
    { from: 'web', to: 'ui', target: 'component', type: 'build' },
  ]);
  assert.equal(r.problems, 0);
  for (const c of r.components) assert.deepEqual(Object.keys(c), ['name', 'repo', 'kind', 'path']);
});

test('bad entries are dropped, not thrown on', () => {
  const components = [
    'not a map',
    null,
    ['list'],
    { name: '../evil', path: '.', kind: 'app' },
    { name: 42, path: '.', kind: 'app' },
    { name: 'a', path: 'a', kind: 'app', dependsOn: [
      { component: 'b', type: 'runtime' },
      { component: 'ghost', type: 'build' },
      { component: 'a', type: 'runtime' },
      { backing: '', type: 'runtime' },
      { backing: '   ', type: 'runtime' },
      { backing: 'pg', type: 'sometimes' },
      { backing: 'pg', component: 'b', type: 'build' },
      {},
      'edge',
      null,
      { component: 'kindless', type: 'build' },
    ] },
    { name: 'a', path: 'other', kind: 'service' },
    { name: 'b', path: 7, kind: 'library', dependsOn: 'nope' },
    { name: 'kindless', path: '.', kind: 'daemon' },
    { name: 'c', path: '.', kind: 'service', repo: 5, dependsOn: [{ component: 'a', type: 'runtime' }] },
  ];
  let r: ReturnType<typeof projectGraph> | undefined;
  assert.doesNotThrow(() => (r = g(components)));
  assert.deepEqual(r!.components, [
    { name: 'a', repo: null, kind: 'app', path: 'a' },
    { name: 'b', repo: null, kind: 'library', path: '.' },
    { name: 'c', repo: null, kind: 'service', path: '.' },
  ]);
  assert.deepEqual(r!.backing, []);
  assert.deepEqual(r!.edges, [
    { from: 'a', to: 'b', target: 'component', type: 'runtime' },
    { from: 'c', to: 'a', target: 'component', type: 'runtime' },
  ]);
  assert.ok(r!.problems > 0);
  assert.equal(r!.problems, componentProblems({ components }).length);
  // A components value that is not a list draws nothing and still counts its problem.
  assert.deepEqual(g('oops'), { components: [], backing: [], edges: [], problems: 1 });
});

test('repoGraph: one row per valid repos entry, with the components that depend on it', () => {
  const config = {
    repos: [{ name: 'lib' }, { name: '../evil' }, { name: 'lib' }, { name: 'tools' }, 'junk'],
    components: [
      { name: 'app', path: '.', kind: 'service', dependsOn: [{ component: 'core', type: 'build' }, { component: 'cli', type: 'runtime' }] },
      { name: 'core', path: '.', kind: 'library', repo: 'lib', dependsOn: [{ component: 'util', type: 'build' }] },
      { name: 'util', path: 'u', kind: 'library', repo: 'lib' },
      { name: 'cli', path: '.', kind: 'app', repo: 'tools', dependsOn: [{ component: 'core', type: 'runtime' }] },
    ],
  };
  assert.deepEqual(repoGraph(config as any), [
    { repo: 'lib', components: ['core', 'util'], usedBy: [{ component: 'app', repo: null, type: 'build' }, { component: 'cli', repo: 'tools', type: 'runtime' }] },
    { repo: 'tools', components: ['cli'], usedBy: [{ component: 'app', repo: null, type: 'runtime' }] },
  ]);
  assert.deepEqual(repoGraph({ components: [] } as any), []);
  assert.deepEqual(repoGraph({ repos: 'x', components: [] } as any), []);
});
