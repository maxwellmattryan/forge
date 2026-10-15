// Reasoning effort per job (issue #121): runtime.effort, job.effort, the precedence helper, the
// v7 job shape and the CLI that writes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { EFFORT_CASES } from './effort-cases.ts';
import { daemonProblems, defaults, loadConfig, resolveEffort, validEffort } from '../lib/config.ts';
import { doctor } from '../lib/doctor.ts';
import { createJob, jobDir, loadJob } from '../lib/jobs.ts';
import { EFFORTS, JOB_SCHEMA_VERSION, normalizeJob } from '../lib/schema.ts';
import { setIn } from '../lib/yaml.ts';
import { EFFORTS as DASH_EFFORTS } from '../dashboard/src/lib/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'bin', 'forge');
const INVALID = 'runtime.effort must be one of low | medium | high | xhigh | max, or null (got "ultra")';

function scratch() {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const raw = (extra: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...env, ...extra } });
  const f = (...args: string[]) => {
    const r = raw({}, ...args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return r.stdout.trim();
    }
  };
  const answersFile = path.join(path.dirname(repo.dir), `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(answersFile, JSON.stringify({ worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
  f('init', 'write', '--answers', answersFile);
  const configFile = path.join(repo.dir, '.forge', 'config.yml');
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answersFile, { force: true });
  };
  return { root: repo.dir, f, raw, configFile, cleanup };
}

test('effort levels, default and resolution', () => {
  assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(DASH_EFFORTS, EFFORTS, 'the dashboard mirrors the engine list');
  assert.equal(defaults().runtime.effort, null);
  for (const c of EFFORT_CASES) {
    const config = defaults();
    (config.runtime as any).effort = c.config;
    assert.deepEqual(resolveEffort(config, { effort: c.job }), { level: c.level, source: c.source }, `job ${JSON.stringify(c.job)} / config ${JSON.stringify(c.config)}`);
  }
  const config = defaults();
  config.runtime.effort = 'medium';
  assert.deepEqual(resolveEffort(config), { level: 'medium', source: 'config' }, 'no job: the config default');
  assert.deepEqual(resolveEffort(config, null), { level: 'medium', source: 'config' });
  assert.equal(validEffort('xhigh'), 'xhigh');
  for (const bad of ['ultra', '', ' high', 'HIGH', 1, null, undefined, {}, ['high']]) assert.equal(validEffort(bad), null, JSON.stringify(bad));
});

test('reads a v6 job', () => {
  const s = scratch();
  try {
    assert.equal(JOB_SCHEMA_VERSION, 7);
    const job = createJob(s.root, defaults(), { title: 'Old v6' });
    const file = path.join(jobDir(s.root, job.id), 'job.json');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete raw.effort;
    raw.schemaVersion = 6;
    fs.writeFileSync(file, JSON.stringify(raw));
    const loaded = loadJob(s.root, job.id);
    assert.equal(loaded.schemaVersion, 7);
    assert.equal(loaded.effort, null);
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 6 }).effort, null);
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 6, effort: 'low' }).effort, 'low', 'a v6 job that somehow has a valid level keeps it');
    assert.equal(normalizeJob({ id: 'x', schemaVersion: 8 })._unsupported, true);

    const migrated = s.f('migrate');
    assert.ok(migrated.changed.includes(path.relative(s.root, file)));
    const rewritten = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(rewritten.schemaVersion, 7);
    assert.equal(rewritten.effort, null);

    for (const bad of ['ultra', '--dangerously-skip-permissions', 5, 'high --add-dir /', { level: 'high' }]) {
      fs.writeFileSync(file, JSON.stringify({ ...rewritten, effort: bad }));
      assert.equal(loadJob(s.root, job.id).effort, null, `${JSON.stringify(bad)} loads as null`);
    }
    fs.writeFileSync(file, JSON.stringify({ ...rewritten, effort: 'xhigh' }));
    assert.equal(loadJob(s.root, job.id).effort, 'xhigh');
  } finally {
    s.cleanup();
  }
});

test('an invalid runtime.effort is refused by validate, doctor and the daemon', async () => {
  const s = scratch();
  try {
    fs.writeFileSync(s.configFile, setIn(fs.readFileSync(s.configFile, 'utf8'), ['runtime', 'effort'], 'ultra'));
    const r = s.raw({}, 'config', 'validate');
    assert.equal(r.status, 1);
    assert.ok(JSON.parse(r.stdout).problems.includes(INVALID), r.stdout);

    const { config } = loadConfig(s.root);
    assert.equal(config.runtime.effort, 'ultra' as any, 'read as written');
    assert.equal(resolveEffort(config).level, null, 'but never used');
    assert.ok(daemonProblems(config, s.root).includes(INVALID));
    config.pr.enabled = false;
    const report = await doctor(s.root, config, true);
    const check = report.checks.find((c) => c.name === 'config valid');
    assert.equal(check?.ok, false);
    assert.ok(check?.detail.includes(INVALID), check?.detail);

    for (const level of [...EFFORTS, null]) {
      config.runtime.effort = level;
      assert.deepEqual(daemonProblems(config, s.root).filter((p) => p.startsWith('runtime.effort')), [], String(level));
    }
    (config.runtime as any).effort = '--add-dir=/';
    assert.deepEqual(daemonProblems(config, s.root).filter((p) => p.startsWith('runtime.effort')), ['runtime.effort must be one of low | medium | high | xhigh | max, or null (got "--add-dir=/")']);
  } finally {
    s.cleanup();
  }
});
