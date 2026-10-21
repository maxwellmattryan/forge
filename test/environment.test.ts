// A job's environment in-process (issue #198): lib/environment.ts and lib/environment-record.ts
// against the in-memory docker fake (test/fixtures/fake-docker.mjs), injected with setDockerRunner.
// These tests change process.env (a fake gh on PATH), so none runs concurrently.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { backingUp, setDockerRunner } from '../lib/backing.ts';
import type { DockerRunner } from '../lib/backing.ts';
import { loadConfig } from '../lib/config.ts';
import { environmentState, environmentsFile, readEnvironments } from '../lib/environment-record.ts';
import { ensureEnvironment, pickVictims, stopEnvironment } from '../lib/environment-lifecycle.ts';
import { setFocus } from '../lib/focus.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { syncPr } from '../lib/pr.ts';
import { emptyState, handle } from './fixtures/fake-docker.mjs';
import { repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const PG = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], volumes: ['/var/lib/postgresql/data'] };

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  const file = path.join(dir, '.forge', 'config.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify([PG])}`));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

/** The in-memory docker, every call recorded. */
function fakeDocker() {
  const state = emptyState();
  const calls: string[][] = [];
  const runner: DockerRunner = (args, opts = {}) => {
    calls.push(args);
    const r = handle(state, args, opts.input);
    return { ok: r.status === 0, ...r };
  };
  return { state, calls, runner };
}

// A stand-in `gh` that answers `pr view` with $FAKE_PR_STATE, as test/pr.test.ts's does.
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr view") printf '{"number":7,"url":"https://github.com/o/r/pull/7","state":"%s","isDraft":false,"headRefOid":"abc123","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"","statusCheckRollup":[],"mergedAt":null,"closedAt":null,"headRefName":"forge/x","baseRefName":"main"}' "$FAKE_PR_STATE" ;;
  "repo view") echo o/r ;;
  "api graphql") echo '{"data":{"repository":{"pullRequest":{}}}}' ;;
esac
`;

/** Writes the environment record by hand: `jobs` maps id → [state, usedAt]. */
function seedRecord(root: string, jobs: Record<string, [string, string]>) {
  const file = environmentsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, jobs: Object.fromEntries(Object.entries(jobs).map(([id, [state, usedAt]]) => [id, { state, usedAt }])) }));
}
const at = (min: number) => new Date(Date.now() - (60 - min) * 60_000).toISOString();

test('LRU eviction skips the focused job', () => {
  const r = template();
  const docker = fakeDocker();
  const prev = setDockerRunner(docker.runner);
  try {
    const config = loadConfig(r.dir).config;
    config.environments = { maxRunning: 2 };
    const [a, b, f, c] = ['A job', 'B job', 'F job', 'C job'].map((title) => createJob(r.dir, config, { title }));
    // Up without the cap, so no eviction happens while seeding.
    const free = { ...config, environments: { maxRunning: null } };
    for (const j of [a, b, f]) assert.equal(ensureEnvironment(r.dir, free, j, 'cli', docker.runner).ok, true);
    // F is the oldest and still never stopped: it is focused.
    seedRecord(r.dir, { [f.id]: ['running', at(0)], [a.id]: ['running', at(1)], [b.id]: ['running', at(2)] });
    setFocus(r.dir, f.id);

    const up = ensureEnvironment(r.dir, config, c, 'cli', docker.runner);
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.deepEqual(up.evicted, [a.id, b.id], 'oldest usedAt first');
    const running = (id: string) => docker.state.containers[`forge-${id}-postgres`].running;
    assert.equal(running(a.id), false);
    assert.equal(running(b.id), false);
    assert.equal(running(f.id), true, 'the focused job is never stopped');
    assert.equal(running(c.id), true);
    const rec = readEnvironments(r.dir).jobs;
    assert.deepEqual(Object.keys(rec).filter((id) => rec[id].state === 'running').sort(), [c.id, f.id].sort());
    const upEv = readEvents(r.dir, c.id).filter((e) => e.type === 'environment-up').at(-1)!;
    assert.deepEqual(upEv.evicted, [a.id, b.id]);
    for (const v of [a.id, b.id]) {
      const stop = readEvents(r.dir, v).filter((e) => e.type === 'environment-stop').at(-1)!;
      assert.equal(stop.trigger, 'evict');
      assert.equal(stop.by, c.id);
      assert.equal(stop.ok, true);
    }
    assert.ok(docker.state.volumes[`forge-${a.id}-postgres-0`], 'eviction never removes a volume');

    // Only C and the focused F left besides: the cap is exceeded rather than stop either.
    const solo = createJob(r.dir, config, { title: 'D job' });
    seedRecord(r.dir, { [f.id]: ['running', at(0)], [c.id]: ['running', at(1)] });
    const cap1 = { ...config, environments: { maxRunning: 1 } };
    const d = ensureEnvironment(r.dir, cap1, solo, 'cli', docker.runner);
    assert.deepEqual(d.evicted, [c.id]);
    const again = ensureEnvironment(r.dir, cap1, solo, 'cli', docker.runner);
    assert.deepEqual(again.evicted, [], 'only the job itself and the focused one run');
    assert.equal(running(f.id), true);
  } finally {
    setDockerRunner(prev);
    r.cleanup();
  }
});

test('pickVictims orders by usedAt and protects self and focus', () => {
  const rec = { v: 1 as const, jobs: { x: { state: 'running' as const, usedAt: at(3) }, y: { state: 'running' as const, usedAt: at(1) }, z: { state: 'stopped' as const, usedAt: at(0) }, me: { state: 'running' as const, usedAt: at(0) } } };
  assert.deepEqual(pickVictims(rec, 'me', 1, null), ['y', 'x']);
  assert.deepEqual(pickVictims(rec, 'me', 1, 'y'), ['x']);
  assert.deepEqual(pickVictims(rec, 'me', 3, null), []);
  assert.deepEqual(pickVictims(rec, 'me', null, null), [], 'no cap, no victims');
});

test('tampered record is read safely', { skip: process.platform === 'win32' }, () => {
  const r = template();
  try {
    const config = loadConfig(r.dir).config;
    const job = createJob(r.dir, config, { title: 'tampered' });
    const file = environmentsFile(r.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const future = new Date(Date.now() + 365 * 864e5).toISOString();
    fs.writeFileSync(file, JSON.stringify({ v: 1, jobs: { [job.id]: { state: 'running', usedAt: future }, '../x': { state: 'running', usedAt: future }, '-rf': { state: 'running' }, bad: { state: 'gone' }, old: { state: 'stopped', usedAt: 'never' } } }));
    const rec = readEnvironments(r.dir);
    assert.deepEqual(Object.keys(rec.jobs).sort(), [job.id, 'old'].sort(), 'invalid ids and states are dropped');
    assert.ok(Date.parse(rec.jobs[job.id].usedAt) <= Date.now(), 'a future usedAt reads as now');
    assert.equal(rec.jobs.old.usedAt, new Date(0).toISOString(), 'an unparseable usedAt reads as the epoch');
    // A symlink and a FIFO read as empty, without blocking or throwing.
    const target = path.join(r.dir, 'elsewhere.json');
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    assert.deepEqual(readEnvironments(r.dir).jobs, {});
    fs.rmSync(file);
    execFileSync('mkfifo', [file]);
    assert.deepEqual(readEnvironments(r.dir).jobs, {});
    assert.equal(environmentState(r.dir, job.id), null);
  } finally {
    r.cleanup();
  }
});

test('tampered record never protects a job or reaches docker', { skip: process.platform === 'win32' }, () => {
  const r = template();
  const docker = fakeDocker();
  const prev = setDockerRunner(docker.runner);
  try {
    const config = loadConfig(r.dir).config;
    config.environments = { maxRunning: 1 };
    const x = createJob(r.dir, config, { title: 'claims the future' });
    const c = createJob(r.dir, config, { title: 'starts' });
    const future = new Date(Date.now() + 365 * 864e5).toISOString();
    const file = environmentsFile(r.dir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: 1, jobs: { [x.id]: { state: 'running', usedAt: future }, '../x': { state: 'running', usedAt: '1970-01-01T00:00:00.000Z' }, '-rf': { state: 'running' } } }));
    const up = ensureEnvironment(r.dir, config, c, 'cli', docker.runner);
    assert.deepEqual(up.evicted, [x.id], 'a future usedAt does not keep a job running');
    for (const argv of docker.calls) for (const a of argv) assert.ok(!a.includes('../x') && a !== '-rf' && !a.includes('forge--rf'), `planted id in ${argv.join(' ')}`);
    assert.deepEqual(Object.keys(readEnvironments(r.dir).jobs).sort(), [c.id, x.id].sort(), 'planted ids are dropped on write');

    // A symlink in the record's place is replaced, never written through; a FIFO never blocks.
    const target = path.join(r.dir, 'elsewhere.json');
    fs.writeFileSync(target, '{"keep":true}');
    fs.rmSync(file);
    fs.symlinkSync(target, file);
    assert.equal(ensureEnvironment(r.dir, config, c, 'cli', docker.runner).ok, true);
    assert.equal(fs.readFileSync(target, 'utf8'), '{"keep":true}');
    fs.rmSync(file);
    execFileSync('mkfifo', [file]);
    assert.equal(ensureEnvironment(r.dir, config, c, 'cli', docker.runner).ok, true);
    assert.equal(environmentState(r.dir, c.id), 'running');
  } finally {
    setDockerRunner(prev);
    r.cleanup();
  }
});

test('pr sync done and cancelled tear down', { skip: process.platform === 'win32' }, () => {
  const r = template();
  const bin = path.join(r.dir, '..', `fakebin-${path.basename(r.dir)}`);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const saved = { ...process.env };
  const docker = fakeDocker();
  const prev = setDockerRunner(docker.runner);
  try {
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    const config = loadConfig(r.dir).config;
    config.tracker.github.repo = 'o/r';
    for (const [prState, finished] of [['MERGED', 'done'], ['CLOSED', 'cancelled']] as const) {
      const job = createJob(r.dir, config, { title: `sync ${prState}` });
      const up = backingUp(r.dir, config, job, docker.runner);
      assert.ok(up.every((s) => s.ok), JSON.stringify(up));
      setJob(r.dir, job.id, { fields: { pr: { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN' } } });
      assert.ok(docker.state.containers[`forge-${job.id}-postgres`]);
      process.env.FAKE_PR_STATE = prState;
      syncPr(r.dir, config, job.id);
      assert.equal(loadJob(r.dir, job.id).state, finished);
      assert.equal(docker.state.containers[`forge-${job.id}-postgres`], undefined, `${prState}: container removed`);
      assert.equal(docker.state.volumes[`forge-${job.id}-postgres-0`], undefined, `${prState}: volume removed`);
      const down = readEvents(r.dir, job.id).filter((e) => e.type === 'environment-down');
      assert.equal(down.length, 1, prState);
      assert.equal(down[0].trigger, finished);
      assert.equal(down[0].ok, true);
      // A second sync of a finished job tears nothing down again.
      syncPr(r.dir, config, job.id);
      assert.equal(readEvents(r.dir, job.id).filter((e) => e.type === 'environment-down').length, 1);
    }
  } finally {
    setDockerRunner(prev);
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    fs.rmSync(bin, { recursive: true, force: true });
    r.cleanup();
  }
});

test('stop signals no pid that runtime.json should not name', { skip: process.platform === 'win32' }, () => {
  const r = template();
  const docker = fakeDocker();
  const config = loadConfig(r.dir).config;
  const j = createJob(r.dir, config, { title: 'planted pids' });
  const file = path.join(r.dir, '.forge', 'jobs', j.id, 'runtime.json');
  const kill = process.kill;
  const signalled: unknown[][] = [];
  process.kill = ((...a: unknown[]) => {
    signalled.push(a);
    return true;
  }) as typeof process.kill;
  try {
    // pid 1 would make kill(-1) signal every process the user may signal; the rest are not pids.
    fs.writeFileSync(file, JSON.stringify({ dev: { pid: 1 }, a: { pid: -5 }, b: { pid: 2.5 }, c: { pid: '7' }, d: { pid: process.pid }, e: null }));
    const res = stopEnvironment(r.dir, config, j.id, 'cli', { runner: docker.runner });
    assert.deepEqual(res.processes, []);
    assert.deepEqual(signalled, [], 'nothing is signalled');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {}, 'the file is still cleared');
  } finally {
    process.kill = kill;
  }
});
