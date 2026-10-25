// Preferences: the machine's are shared as `forge.<key>`, the rest are per project, reading the old unscoped key when the
// project has no value of its own. localStorage is a stub on globalThis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pref, prefKey } from './prefs.ts';
import { setProject } from './project.ts';

function stubStorage(throws = false): Map<string, string> {
  const store = new Map<string, string>();
  const fail = (): never => {
    throw new Error('storage is off');
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => (throws ? fail() : (store.get(k) ?? null)),
      setItem: (k: string, v: string) => (throws ? fail() : void store.set(k, v)),
    },
  });
  return store;
}

test('project prefs are per project and machine prefs are shared', (t) => {
  t.after(() => setProject(null));
  const store = stubStorage();
  setProject('a');
  pref.set('layout', 'table');
  assert.equal(pref.get('layout', 'board'), 'table');
  assert.equal(store.get('forge.p/a/layout'), 'table');
  setProject('b');
  assert.equal(pref.get('layout', 'board'), 'board', "a's layout is not read under b");

  pref.set('theme', 'ash');
  pref.set('sidebarWidth', '300');
  setProject(null);
  pref.set('lastProject', 'b');
  assert.deepEqual([store.get('forge.theme'), store.get('forge.sidebarWidth'), store.get('forge.lastProject')], ['ash', '300', 'b']);
  setProject('a');
  assert.equal(pref.get('theme', 'forge'), 'ash', 'the same theme under every project');

  store.set('forge.filter', 'all');
  assert.equal(pref.get('filter', 'active'), 'all', 'no own value: the legacy key');
  pref.set('filter', 'done');
  assert.equal(pref.get('filter', 'active'), 'done', 'its own value wins');
  assert.equal(store.get('forge.filter'), 'all', 'the legacy key is left alone');

  setProject(null);
  const before = [...store];
  pref.set('window', '7');
  assert.deepEqual([...store], before, 'a project pref written with no project changes nothing');
  assert.equal(pref.get('window', '30'), '30');
});

test('prefKey', () => {
  assert.equal(prefKey('theme', 'web'), 'forge.theme');
  assert.equal(prefKey('theme', null), 'forge.theme');
  assert.equal(prefKey('layout', 'web'), 'forge.p/web/layout');
  assert.equal(prefKey('layout', null), null);
  for (const bad of ['../x', 'A', 'a/b', '']) assert.equal(prefKey('layout', bad), null, bad);
});

test('storage that throws gives the default', (t) => {
  t.after(() => setProject(null));
  stubStorage(true);
  setProject('a');
  assert.equal(pref.get('layout', 'board'), 'board');
  assert.equal(pref.get('theme', 'forge'), 'forge');
  assert.doesNotThrow(() => pref.set('layout', 'table'));
});
