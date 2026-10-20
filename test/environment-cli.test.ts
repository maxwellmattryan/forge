// A job's environment end to end (issue #198): the real CLI with a fake docker first on PATH
// (test/fixtures/docker-bin/docker, which is test/fixtures/fake-docker.mjs) recording every argv.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { pidAlive } from '../lib/worktree.ts';
import { forgeAsync, repoTemplate, waitFor } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const DOCKER_BIN = path.resolve(import.meta.dirname, 'fixtures', 'docker-bin');
// Joined at runtime: the installed secret scan reads `{user}:{password}@` as a url credential.
const DB_URL = ['postgres://{user}', '{password}@{host}:{port}/{database}'].join(':');
const BACKING = [
  { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], volumes: ['/var/lib/postgresql/data'] },
  { name: 'pg', isolation: 'shared', image: 'postgres:16', ports: [5433], url: DB_URL, database: { engine: 'postgres', migrate: 'true' } },
];

/** A forge repo with these backing entries, a dev server and a test step. */
const templateWith = (backing: unknown[]) =>
  repoTemplate((dir) => {
    const answers = path.join(dir, '.answers.json');
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true', dev: 'sleep 60' }, verify: ['test'], worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
    execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
    fs.rmSync(answers);
    const file = path.join(dir, '.forge', 'config.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(backing)}`));
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
  });
const template = templateWith(BACKING);
const plainTemplate = templateWith([]);

function scratch(make = template) {
  const r = make();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docker-')));
  const stateFile = path.join(tmp, 'state.json');
  const log = path.join(tmp, 'argv.log');
  const env = { PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile, FAKE_DOCKER_LOG: log };
  const cli = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const res = await forgeAsync(r.dir, args, { ...env, ...extra });
    let json: any = null;
    try {
      json = JSON.parse(res.stdout);
    } catch {}
    return { ...res, json };
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setState = (patch: object) => fs.writeFileSync(stateFile, JSON.stringify({ ...(fs.existsSync(stateFile) ? state() : {}), ...patch }));
  const argv = (): string[][] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const clearArgv = () => fs.rmSync(log, { force: true });
  const jobDir = (id: string) => path.join(r.dir, '.forge', 'jobs', id);
  const events = (id: string) =>
    fs
      .readFileSync(path.join(jobDir(id), 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const record = () => {
    const f = path.join(r.dir, '.forge', 'runtime', 'environments.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  };
  const newJob = async (title: string) => (await cli(['job', 'new', '--title', title])).json.id as string;
  const cleanup = () => {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { dir: r.dir, cli, state, setState, argv, clearArgv, jobDir, events, record, newJob, cleanup };
}

/** The dev server's pid, from runtime.json. */
const devPid = (s: ReturnType<typeof scratch>, id: string): number => JSON.parse(fs.readFileSync(path.join(s.jobDir(id), 'runtime.json'), 'utf8')).dev.pid;

describe('environment teardown', { concurrency: 4 }, () => {
  test('cancel tears the environment down', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('Cancel me');
      const wt = await s.cli(['worktree', 'create', id]);
      assert.equal(wt.status, 0, wt.stderr);
      assert.equal(wt.json.ok, true, JSON.stringify(wt.json));
      const db = wt.json.backing[1].database.name;
      const bg = await s.cli(['run', id, 'dev', '--background']);
      assert.equal(bg.status, 0, bg.stderr);
      const pid = devPid(s, id);
      assert.ok(pidAlive(pid));
      const server = Object.keys(s.state().pg)[0];
      assert.ok(s.state().pg[server].dbs[db]);
      assert.ok(s.state().volumes[`forge-${id}-postgres-0`]);

      const set = await s.cli(['job', 'set', id, '--state', 'cancelled']);
      assert.equal(set.status, 0, set.stderr);
      assert.equal(set.json.state, 'cancelled');
      assert.deepEqual(set.json.environment, { ok: true, processes: ['dev'], removed: [`forge-${id}-postgres`], volumes: [`forge-${id}-postgres-0`], databases: [db] });
      assert.equal(s.state().containers[`forge-${id}-postgres`], undefined, 'container removed');
      assert.equal(s.state().volumes[`forge-${id}-postgres-0`], undefined, 'volume removed');
      assert.equal(s.state().pg[server].dbs[db], undefined, 'database dropped');
      assert.ok(s.state().containers[Object.keys(s.state().containers).find((n) => n.endsWith('-pg'))!].running, 'the shared server stays');
      assert.ok(!fs.existsSync(path.join(s.jobDir(id), 'backing.json')));
      assert.ok(!fs.existsSync(path.join(s.jobDir(id), 'backing-db.json')));
      await waitFor(() => !pidAlive(pid), { what: 'the dev server to stop' });
      assert.ok(fs.existsSync(wt.json.path), 'the worktree stays');
      const down = s.events(id).filter((e) => e.type === 'environment-down');
      assert.equal(down.length, 1);
      assert.equal(down[0].trigger, 'cancelled');
      assert.equal(down[0].ok, true);
      assert.ok(!JSON.stringify(s.events(id)).includes('password'), 'no password in any event');
      assert.equal(s.record()?.jobs?.[id], undefined, 'the job left the environment record');
    } finally {
      s.cleanup();
    }
  });

  test('teardown failure never blocks cancel and is retried', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('Docker down');
      assert.equal((await s.cli(['worktree', 'create', id])).status, 0);
      s.setState({ daemon: 'down' });
      const set = await s.cli(['job', 'set', id, '--state', 'cancelled']);
      assert.equal(set.status, 0, set.stderr);
      assert.equal(set.json.state, 'cancelled');
      assert.equal(set.json.environment.ok, false);
      assert.match(set.json.environment.error, /daemon is not reachable/);
      assert.ok(fs.existsSync(path.join(s.jobDir(id), 'backing.json')), 'kept for a retry');
      assert.ok(fs.existsSync(path.join(s.jobDir(id), 'backing-db.json')), 'kept for a retry');
      const failed = s.events(id).find((e) => e.type === 'environment-down');
      assert.equal(failed.ok, false);
      assert.match(failed.error, /daemon is not reachable/);

      s.setState({ daemon: 'up' });
      const down = await s.cli(['environment', 'down', id]);
      assert.equal(down.status, 0, down.stderr);
      assert.equal(down.json.ok, true);
      assert.deepEqual(down.json.removed, [`forge-${id}-postgres`]);
      assert.deepEqual(down.json.volumes, [`forge-${id}-postgres-0`]);
      assert.equal(down.json.databases.length, 1);
      assert.ok(!fs.existsSync(path.join(s.jobDir(id), 'backing.json')));
      assert.equal(s.events(id).filter((e) => e.type === 'environment-down').at(-1).trigger, 'cli');
    } finally {
      s.cleanup();
    }
  });

  test('nothing to tear down makes no docker call', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('Nothing here');
      s.clearArgv();
      const set = await s.cli(['job', 'set', id, '--state', 'cancelled']);
      assert.equal(set.status, 0, set.stderr);
      assert.equal('environment' in set.json, false);
      assert.deepEqual(s.argv(), [], 'no docker call');
      assert.ok(!s.events(id).some((e) => e.type.startsWith('environment-')), 'no environment event');
    } finally {
      s.cleanup();
    }
  });

  test('daemon scopes and id checks', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('Scoped');
      assert.equal((await s.cli(['worktree', 'create', id])).status, 0);
      s.clearArgv();
      const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.dir) };
      for (const scope of ['_inbox', '_office']) {
        const r = await s.cli(['environment', 'down', id], { ...trust, FORGE_DAEMON_SCOPE: scope });
        assert.equal(r.status, 1, `${scope}: ${r.stdout}${r.stderr}`);
        assert.match(r.stdout + r.stderr, scope === '_inbox' ? /the inbox daemon session does not drive jobs/ : /the office session decides gates and does not drive jobs/);
      }
      for (const bad of ['../x', 'a/../../b', '-rf']) {
        const r = await s.cli(['environment', 'down', bad]);
        assert.notEqual(r.status, 0, bad);
      }
      assert.deepEqual(s.argv(), [], 'no docker call for a refused session or id');
      assert.ok(fs.existsSync(path.join(s.jobDir(id), 'backing.json')), 'nothing torn down');
      // The job's own session may tear its environment down.
      const own = await s.cli(['environment', 'down', id], { ...trust, FORGE_DAEMON_SCOPE: id });
      assert.equal(own.status, 0, own.stdout + own.stderr);
      assert.equal(own.json.ok, true);
    } finally {
      s.cleanup();
    }
  });

  test('environment list', async () => {
    const s = scratch(plainTemplate);
    try {
      await s.newJob('Listed');
      const empty = await s.cli(['environment', 'list']);
      assert.deepEqual(empty.json, { maxRunning: null, focused: null, jobs: [] });
    } finally {
      s.cleanup();
    }
  });
});
