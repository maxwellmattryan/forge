// Components (config schemaVersion 9): `services` folds into `components`, run and verify pick the
// same commands as before, and validation rejects malformed components and build cycles.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, tempRepo } from './helpers.ts';
import { defaults, loadConfig } from '../lib/config.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import { servicesToComponents } from '../lib/components.ts';
import * as yaml from '../lib/yaml.ts';

const SERVICE = { name: 'api', path: 'svc/api', commands: { test: 't' }, owners: ['@a'], notes: 'n' };
const COMPONENT = { ...SERVICE, kind: 'service', dependsOn: [] };

describe('components migration', { concurrency: 4 }, () => {
  test('migration maps services to service components', () => {
    assert.equal(CONFIG_SCHEMA_VERSION, 9);
    const { config, from } = migrateConfig({ schemaVersion: 8, services: [structuredClone(SERVICE)] });
    assert.equal(from, 8);
    assert.deepEqual(config, { schemaVersion: 9, components: [COMPONENT] });
    assert.equal('services' in config, false);
    assert.deepEqual(servicesToComponents({ services: [{ name: 'web' }, { name: 'x', path: '' }] }).components, [
      { name: 'web', path: '.', kind: 'service', dependsOn: [] },
      { name: 'x', path: '.', kind: 'service', dependsOn: [] },
    ]);
    // Pure and idempotent; a config that already has components is left alone.
    const once = servicesToComponents({ services: [SERVICE] });
    assert.deepEqual(servicesToComponents(once), once);
    const both = { services: [SERVICE], components: [] };
    assert.equal(servicesToComponents(both), both);
    // A bad entry is kept for validation to name.
    assert.deepEqual(servicesToComponents({ services: ['nope'] }).components, ['nope']);
    // An unversioned config that still says services folds the same way.
    assert.deepEqual(migrateConfig({ services: [structuredClone(SERVICE)] }).config.components, [COMPONENT]);
  });

  test('a v8 services config loads and migrates to components', async () => {
    const repo = tempRepo();
    try {
      const cfg = path.join(repo.dir, '.forge', 'config.yml');
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, yaml.stringify({ schemaVersion: 8, tracker: { kind: 'none' }, services: [SERVICE] }));
      const loaded = loadConfig(repo.dir);
      assert.equal(loaded.migratedFrom, 8);
      assert.deepEqual(loaded.config.components, [COMPONENT]);
      assert.equal('services' in loaded.config, false);
      assert.equal('services' in defaults(), false);
      const m = await forgeAsync(repo.dir, ['migrate']);
      assert.equal(m.status, 0, m.stderr);
      assert.deepEqual(JSON.parse(m.stdout).changed, ['.forge/config.yml']);
      const text = fs.readFileSync(cfg, 'utf8');
      assert.match(text, /^schemaVersion: 9$/m);
      assert.match(text, /^components:$/m);
      assert.doesNotMatch(text, /^services:/m);
      assert.deepEqual(yaml.parse(text).components, [COMPONENT]);
    } finally {
      repo.cleanup();
    }
  });
});
