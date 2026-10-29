// configOverrides: the delta `forge init write` puts in .forge/config.yml, checked against small
// hand-built bases and against the real defaults, with the deepMerge round trip in every row.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deepMerge } from '../shape.ts';
import { configOverrides, defaults } from './load.ts';

test('configOverrides is the smallest file that loads back to the config', () => {
  const base = {
    schemaVersion: 7,
    a: { x: 1, y: 'two', z: { deep: true } },
    list: [{ name: 'code', always: true }, { name: 'docs' }],
    nullable: 'set',
    empty: {},
  };
  const rows: { name: string; config: Record<string, any>; keep?: unknown; want: Record<string, any> }[] = [
    { name: 'equal to the base: schemaVersion only', config: structuredClone(base), want: { schemaVersion: 7 } },
    {
      name: 'keeps schemaVersion even when it differs, and nothing else equal',
      config: { ...structuredClone(base), schemaVersion: 9 },
      want: { schemaVersion: 9 },
    },
    {
      name: 'recurses into maps and drops equal leaves',
      config: deepMerge(base, { a: { y: 'three', z: { deep: false } } }),
      want: { schemaVersion: 7, a: { y: 'three', z: { deep: false } } },
    },
    {
      name: 'a list that differs is written whole',
      config: { ...structuredClone(base), list: [{ name: 'code', always: true }] },
      want: { schemaVersion: 7, list: [{ name: 'code', always: true }] },
    },
    {
      name: 'map key order inside list items is ignored',
      config: { ...structuredClone(base), list: [{ always: true, name: 'code' }, { name: 'docs' }] },
      want: { schemaVersion: 7 },
    },
    {
      name: 'list order is not',
      config: { ...structuredClone(base), list: [{ name: 'docs' }, { name: 'code', always: true }] },
      want: { schemaVersion: 7, list: [{ name: 'docs' }, { name: 'code', always: true }] },
    },
    {
      name: 'null over a non-null default is written',
      config: { ...structuredClone(base), nullable: null },
      want: { schemaVersion: 7, nullable: null },
    },
    {
      name: 'keys absent from the base are written whole',
      config: deepMerge(base, { extra: { p: 1, q: [] }, a: { added: { k: 'v' } } }),
      want: { schemaVersion: 7, a: { added: { k: 'v' } }, extra: { p: 1, q: [] } },
    },
    {
      name: 'an empty map with no differing keys is not written',
      config: deepMerge(base, { empty: {} }),
      want: { schemaVersion: 7 },
    },
    {
      name: 'every leaf the keep tree sets stays, even at its default',
      config: deepMerge(base, { a: { y: 'other' } }),
      keep: { a: { x: 1, z: { deep: true } }, list: [{ name: 'code', always: true }, { name: 'docs' }], nullable: 'set' },
      want: { schemaVersion: 7, a: { x: 1, y: 'other', z: { deep: true } }, list: [{ name: 'code', always: true }, { name: 'docs' }], nullable: 'set' },
    },
    {
      name: 'a keep tree that is not a map keeps nothing',
      config: structuredClone(base),
      keep: 'not a map',
      want: { schemaVersion: 7 },
    },
  ];
  for (const r of rows) {
    const got = configOverrides(r.config, r.keep, base);
    assert.deepEqual(got, r.want, r.name);
    assert.deepEqual(Object.keys(got)[0], 'schemaVersion', `${r.name}: schemaVersion comes first`);
    assert.deepEqual(deepMerge(base, got), r.config, `${r.name}: round trip`);
  }

  const d = defaults();
  const config = deepMerge(d, { commands: { test: 'npm test', dist: 'node build.mjs' }, git: { base: d.git.base } });
  const got = configOverrides(config);
  assert.deepEqual(got, { schemaVersion: d.schemaVersion, commands: { test: 'npm test', dist: 'node build.mjs' } }, 'against defaults()');
  assert.deepEqual(deepMerge(d, got), config, 'against defaults(): round trip');
});
