// Config schema migrations that need a home of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { defaults, loadConfig, validateConfig } from '../lib/config.ts';
import { disclosureOf } from '../lib/config-fields.ts';
import { CONFIG_SCHEMA_VERSION, JOB_SCHEMA_VERSION, migrateConfig, normalizeJob } from '../lib/schema.ts';
import { leaseStatus, loadJob, updateJob } from '../lib/jobs.ts';
import * as yaml from '../lib/yaml.ts';

test('v22 config migrates to v23', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 28);
  const v22 = { schemaVersion: 22, tracker: { kind: 'none' }, backing: [] };
  const m = migrateConfig(structuredClone(v22));
  assert.equal(m.from, 22);
  assert.deepEqual(m.config, { ...v22, schemaVersion: 28 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v22));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 22);
    assert.equal(loaded.config.schemaVersion, 28);
    assert.deepEqual(loaded.config.secrets, {}, 'secrets defaults to an empty map');
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('secrets'), 'command');
  assert.equal(disclosureOf('secrets.DB_PASSWORD.env'), 'command');
});

test('migrates to the environments version', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 28);
  const v24 = { schemaVersion: 24, tracker: { kind: 'none' }, backing: [], secrets: {}, outcomes: { windowDays: 14 } };
  const m = migrateConfig(structuredClone(v24));
  assert.equal(m.from, 24);
  assert.deepEqual(m.config, { ...v24, schemaVersion: 28 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v24));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 24);
    assert.equal(loaded.config.schemaVersion, 28);
    assert.deepEqual(loaded.config.environments, { maxRunning: null }, 'no cap by default');
  } finally {
    repo.cleanup();
  }
  assert.equal(disclosureOf('environments.maxRunning'), 'plain');
});

test('v26 config migrates to v27 unchanged', () => {
  assert.equal(CONFIG_SCHEMA_VERSION, 28);
  const v26 = { schemaVersion: 26, tracker: { kind: 'none' }, pipeline: { maxRounds: 2 }, pr: { enabled: false }, daemon: { enabled: true } };
  const m = migrateConfig(structuredClone(v26));
  assert.equal(m.from, 26);
  assert.deepEqual(m.config, { ...v26, schemaVersion: 28 }, 'nothing but schemaVersion changes');
  const repo = tempRepo();
  try {
    const cfg = path.join(repo.dir, '.forge', 'config.yml');
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, yaml.stringify(v26));
    const loaded = loadConfig(repo.dir);
    assert.equal(loaded.migratedFrom, 26);
    assert.equal(loaded.config.schemaVersion, 28);
    assert.equal(loaded.config.pipeline.maxTotalRounds, null);
    assert.equal(loaded.config.pr.maxCiReworks, 3);
    assert.deepEqual(loaded.config.daemon.jobBudget, { tokens: 600000000, usd: 150 });
  } finally {
    repo.cleanup();
  }
});

test('job v16 owner migrates to lease', () => {
  const repo = tempRepo();
  try {
    const dir = path.join(repo.dir, '.forge', 'jobs', 'old-job');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'job.json');
    const owner = { session: 'S-old', host: 'laptop.local', since: '2026-10-01T10:00:00.000Z', heartbeat: '2026-10-01T11:00:00.000Z' };
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 16, id: 'old-job', title: 'Old', state: 'running', owner }));
    const loaded = loadJob(repo.dir, 'old-job');
    assert.deepEqual(loaded.lease, { driver: 'S-old', epoch: 1, since: owner.since, renewedAt: owner.heartbeat, expiresAt: '2026-10-01T11:30:00.000Z' });
    assert.equal('owner' in loaded, false);
    // Written back as v17, with no owner.
    updateJob(repo.dir, 'old-job', () => {});
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(written.schemaVersion, JOB_SCHEMA_VERSION);
    assert.equal(JOB_SCHEMA_VERSION, 17);
    assert.equal('owner' in written, false);
    assert.deepEqual(written.lease, loaded.lease);

    // No owner: no driver, epoch 0. An unparseable heartbeat keeps the driver but reads as expired.
    assert.deepEqual(normalizeJob({ schemaVersion: 16, id: 'x', owner: null }).lease, { driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null });
    const garbled = normalizeJob({ schemaVersion: 16, id: 'x', owner: { session: 'S', host: 'h', since: 'x', heartbeat: 'not a time' } });
    assert.deepEqual([garbled.lease.driver, garbled.lease.expiresAt, leaseStatus(garbled).status], ['S', null, 'expired']);
    // A current-version file is read field by field: a partial or planted lease never reads as live by accident.
    assert.deepEqual(normalizeJob({ schemaVersion: 17, id: 'x' }).lease, { driver: null, epoch: 0, since: null, renewedAt: null, expiresAt: null });
    assert.deepEqual(normalizeJob({ schemaVersion: 17, id: 'x', lease: { driver: 'S', epoch: -2, expiresAt: 42 } }).lease, { driver: 'S', epoch: 0, since: null, renewedAt: null, expiresAt: null });
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
