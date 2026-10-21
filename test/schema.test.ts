// Config schema migrations that need a home of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { loadConfig } from '../lib/config.ts';
import { disclosureOf } from '../lib/config-fields.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import * as yaml from '../lib/yaml.ts';

test('v22 config migrates to v23', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 24);
  const v22 = { schemaVersion: 22, tracker: { kind: 'none' }, backing: [] };
  const m = migrateConfig(structuredClone(v22));
  assert.equal(m.from, 22);
  assert.deepEqual(m.config, { ...v22, schemaVersion: 24 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v22));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 22);
    assert.equal(loaded.config.schemaVersion, 24);
    assert.deepEqual(loaded.config.secrets, {}, 'secrets defaults to an empty map');
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('secrets'), 'command');
  assert.equal(disclosureOf('secrets.DB_PASSWORD.env'), 'command');
});

test('migrates to the environments version', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 24);
  const v23 = { schemaVersion: 23, tracker: { kind: 'none' }, backing: [], secrets: {} };
  const m = migrateConfig(structuredClone(v23));
  assert.equal(m.from, 23);
  assert.deepEqual(m.config, { ...v23, schemaVersion: 24 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v23));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 23);
    assert.equal(loaded.config.schemaVersion, 24);
    assert.deepEqual(loaded.config.environments, { maxRunning: null }, 'no cap by default');
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('environments.maxRunning'), 'plain');
});
