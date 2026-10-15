// Reasoning effort per job (issue #121): runtime.effort, job.effort, the precedence helper, the
// v7 job shape and the CLI that writes it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { EFFORT_CASES } from './effort-cases.ts';
import { TRUST_ENV, daemonProblems, defaults, loadConfig, resolveEffort, trustDigest, validEffort } from '../lib/config.ts';
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

/** Every file under the job dir with its bytes, so a refusal can be shown to write nothing. */
const snapshot = (dir: string) => Object.fromEntries(fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
const jobsIn = (root: string) => fs.readdirSync(path.join(root, '.forge', 'jobs')).sort();

test('job new --effort sets the level and refuses unknown ones', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 't', '--effort', 'high');
    assert.equal(loadJob(s.root, id).effort, 'high');
    const created = fs.readFileSync(path.join(jobDir(s.root, id), 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'created');
    assert.equal(created.effort, 'high');
    const before = jobsIn(s.root);
    for (const [args, message] of [
      [['--effort', 'ultra'], 'unknown effort "ultra" (low, medium, high, xhigh, max)'],
      [['--effort=--dangerously-skip-permissions'], 'unknown effort "--dangerously-skip-permissions" (low, medium, high, xhigh, max)'],
      [['--effort'], 'missing value for --effort'],
      [['--effort', 'high', '--effort', 'low'], '--effort given more than once'],
    ] as const) {
      const r = s.raw({}, 'job', 'new', '--title', 'u', ...args);
      assert.equal(r.status, 2, args.join(' '));
      assert.ok(r.stderr.includes(message), `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual(jobsIn(s.root), before, `${args.join(' ')} creates no job dir`);
    }
    const plain = s.f('job', 'new', '--title', 'plain');
    assert.equal(loadJob(s.root, plain.id).effort, null);
    const plainCreated = JSON.parse(fs.readFileSync(path.join(jobDir(s.root, plain.id), 'events.jsonl'), 'utf8').split('\n')[0]);
    assert.equal('effort' in plainCreated, false, 'the created event names an effort only when one is set');
  } finally {
    s.cleanup();
  }
});

test('job effort sets, inherits and logs', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'e');
    const dir = jobDir(s.root, id);
    const effortEvents = () => fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'effort');
    assert.deepEqual(s.f('job', 'effort', id, 'medium'), { id, effort: 'medium', previous: null, changed: true });
    assert.equal(loadJob(s.root, id).effort, 'medium');
    assert.deepEqual(effortEvents().map(({ effort, previous, from }) => ({ effort, previous, from })), [{ effort: 'medium', previous: null, from: 'cli' }]);

    const unchanged = snapshot(dir);
    assert.deepEqual(s.f('job', 'effort', id, 'medium'), { id, effort: 'medium', previous: 'medium', changed: false });
    assert.deepEqual(snapshot(dir), unchanged, 'a no-op writes and logs nothing');

    assert.deepEqual(s.f('job', 'effort', id, 'xhigh'), { id, effort: 'xhigh', previous: 'medium', changed: true });
    assert.deepEqual(s.f('job', 'effort', id, '--inherit'), { id, effort: null, previous: 'xhigh', changed: true });
    assert.equal(loadJob(s.root, id).effort, null);
    assert.deepEqual(effortEvents().map((e) => e.effort), ['medium', 'xhigh', null]);

    // Usage errors exit 2 and a missing job exits 1 (docs/CLI.md "Exit codes").
    const usage = 'usage: forge job effort <id> low|medium|high|xhigh|max | --inherit';
    const before = snapshot(dir);
    for (const [args, message, status] of [
      [[id, 'ultra'], 'unknown effort "ultra" (low, medium, high, xhigh, max)', 2],
      [[id, 'HIGH'], 'unknown effort "HIGH" (low, medium, high, xhigh, max)', 2],
      [[id, 'high', '--inherit'], usage, 2],
      [[id], usage, 2],
      [[id, '--inherit', 'high'], usage, 2],
      [[id, 'high', 'low'], usage, 2],
      [['no-such-job', 'high'], 'no job "no-such-job"', 1],
      [[], 'missing job id', 2],
    ] as const) {
      const r = s.raw({}, 'job', 'effort', ...args);
      assert.equal(r.status, status, args.join(' '));
      assert.ok(r.stderr.includes(message), `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual(snapshot(dir), before, `${args.join(' ')} leaves job.json and events.jsonl byte-identical`);
    }
    assert.equal(fs.existsSync(path.join(s.root, '.forge', 'jobs', 'no-such-job')), false, 'an unknown id creates no dir');
  } finally {
    s.cleanup();
  }
});

test('effort is readable from get, list and show', () => {
  const s = scratch();
  try {
    const high = s.f('job', 'new', '--title', 'High', '--effort', 'high').id;
    const plain = s.f('job', 'new', '--title', 'Plain').id;
    // Strings print raw (the CLI's rule for every string result); null prints as JSON.
    assert.equal(s.raw({}, 'job', 'get', high, 'effort').stdout, 'high\n');
    assert.equal(s.raw({}, 'job', 'get', plain, 'effort').stdout, 'null\n');
    for (const args of [['job', 'list'], ['job', 'list', '--all']]) {
      const rows = s.f(...args);
      assert.equal(rows.find((r: any) => r.id === high).effort, 'high', args.join(' '));
      assert.equal(rows.find((r: any) => r.id === plain).effort, null, args.join(' '));
    }
    assert.equal(s.f('job', 'show', high).effort, 'high');
    assert.equal(s.f('job', 'show', plain).effort, null);
    assert.equal(s.f('job', 'show', high, '--full').effort, 'high');
  } finally {
    s.cleanup();
  }
});

test('set --field cannot write effort', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Locked');
    const before = snapshot(jobDir(s.root, id));
    for (const field of ['effort=max', 'effort=null', 'effort.x=1']) {
      const r = s.raw({}, 'job', 'set', id, '--field', field);
      assert.notEqual(r.status, 0, field);
      assert.ok(r.stderr.includes('--field effort is not settable; use forge job effort'), `${field}: ${r.stderr}`);
    }
    assert.deepEqual(snapshot(jobDir(s.root, id)), before);
  } finally {
    s.cleanup();
  }
});

test('a daemon session cannot set effort', () => {
  const s = scratch();
  try {
    const { id } = s.f('job', 'new', '--title', 'Daemon');
    const dir = jobDir(s.root, id);
    const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.root) };
    assert.equal(s.raw(daemon, 'job', 'get', id, 'effort').status, 0, 'the trust snapshot matches');
    const before = snapshot(dir);
    const jobs = jobsIn(s.root);
    for (const args of [['job', 'effort', id, 'high'], ['job', 'effort', id, '--inherit'], ['job', 'new', '--title', 't', '--effort', 'high'], ['job', 'new', '--title', 't', '--effort', 'ultra']]) {
      const r = s.raw(daemon, ...args);
      assert.notEqual(r.status, 0, args.join(' '));
      assert.ok(r.stderr.includes('a daemon session may not change'), `${args.join(' ')}: ${r.stderr}`);
      assert.deepEqual(snapshot(dir), before, `${args.join(' ')} writes nothing`);
      assert.deepEqual(jobsIn(s.root), jobs, `${args.join(' ')} creates no job`);
    }
    const r = s.raw(daemon, 'job', 'new', '--title', 't');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(loadJob(s.root, JSON.parse(r.stdout).id).effort, null);
  } finally {
    s.cleanup();
  }
});

test('agent frontmatter leaves effort to the session', () => {
  const dir = path.join(ROOT, 'agents');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 9, 'every role has a prompt');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text);
    assert.ok(front, `${f} has frontmatter`);
    // An agent-level effort would override the job's for every run of that role.
    assert.ok(!/^\s*effort\s*:/m.test(front[1]), `${f} sets no effort`);
  }
});
