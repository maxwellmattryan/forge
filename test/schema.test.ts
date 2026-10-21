// Config schema migrations that need a home of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { disclosureOf } from '../lib/config-fields.ts';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from '../lib/schema.ts';
import * as yaml from '../lib/yaml.ts';

test('v22 config migrates to v23', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 27);
  const v22 = { schemaVersion: 22, tracker: { kind: 'none' }, backing: [] };
  const m = migrateConfig(structuredClone(v22));
  assert.equal(m.from, 22);
  assert.deepEqual(m.config, { ...v22, schemaVersion: 27 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v22));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 22);
    assert.equal(loaded.config.schemaVersion, 27);
    assert.deepEqual(loaded.config.secrets, {}, 'secrets defaults to an empty map');
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('secrets'), 'command');
  assert.equal(disclosureOf('secrets.DB_PASSWORD.env'), 'command');
});

test('migrates to the environments version', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 27);
  const v24 = { schemaVersion: 24, tracker: { kind: 'none' }, backing: [], secrets: {}, outcomes: { windowDays: 14 } };
  const m = migrateConfig(structuredClone(v24));
  assert.equal(m.from, 24);
  assert.deepEqual(m.config, { ...v24, schemaVersion: 27 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v24));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 24);
    assert.equal(loaded.config.schemaVersion, 27);
    assert.deepEqual(loaded.config.environments, { maxRunning: null }, 'no cap by default');
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('environments.maxRunning'), 'plain');
});

test('v26 config migrates to v27 unchanged', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 27);
  const v26 = { schemaVersion: 26, tracker: { kind: 'none' }, pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } };
  const m = migrateConfig(structuredClone(v26));
  assert.equal(m.from, 26);
  assert.deepEqual(m.config, { ...v26, schemaVersion: 27 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v26));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 26);
    assert.equal(loaded.config.schemaVersion, 27);
    assert.equal(loaded.config.pipeline.maxTotalRounds, null);
    assert.equal(loaded.config.pr.maxCiReworks, 3);
    assert.deepEqual(loaded.config.daemon.jobBudget, { tokens: 600000000, usd: 150 });
  } finally {
    repo.cleanup();
  }
});

test('validates maxTotalRounds, maxCiReworks and daemon.jobBudget', () => {
  const problems = (edit: (c: any) => void, key: string) => {
    const c: any = defaults();
    edit(c);
    return validateConfig(c, process.cwd()).filter((p) => p.startsWith(key));
  };
  assert.deepEqual(problems(() => {}, 'pipeline.maxTotalRounds'), []);
  assert.deepEqual(problems((c) => (c.pipeline.maxTotalRounds = 8), 'pipeline.maxTotalRounds'), []);
  assert.equal(problems((c) => (c.pipeline.maxTotalRounds = 0), 'pipeline.maxTotalRounds').length, 1);
  assert.equal(problems((c) => (c.pipeline.maxTotalRounds = 2.5), 'pipeline.maxTotalRounds').length, 1);
  assert.deepEqual(problems((c) => (c.pr.maxCiReworks = 0), 'pr.maxCiReworks'), []);
  assert.equal(problems((c) => (c.pr.maxCiReworks = -1), 'pr.maxCiReworks').length, 1);
  assert.equal(problems((c) => (c.pr.maxCiReworks = 1.5), 'pr.maxCiReworks').length, 1);
  assert.deepEqual(problems((c) => (c.daemon.jobBudget = null), 'daemon.jobBudget'), []);
  assert.deepEqual(problems((c) => (c.daemon.jobBudget = { tokens: null, usd: 20, minutes: 90 }), 'daemon.jobBudget'), []);
  assert.equal(problems((c) => (c.daemon.jobBudget = { usd: -1 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = { changedLines: 5 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = { tokens: 1.5 }), 'daemon.jobBudget').length, 1);
  assert.equal(problems((c) => (c.daemon.jobBudget = [1]), 'daemon.jobBudget').length, 1);
});
