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
      for (const sub of ['up', 'stop']) {
        for (const scope of ['_inbox', '_office']) {
          const r = await s.cli(['environment', sub, id], { ...trust, FORGE_DAEMON_SCOPE: scope });
          assert.equal(r.status, 1, `${sub} ${scope}: ${r.stdout}${r.stderr}`);
        }
      }
      for (const sub of ['up', 'stop', 'down']) {
        for (const bad of ['../x', 'a/../../b', '-rf']) {
          const r = await s.cli(['environment', sub, bad]);
          assert.notEqual(r.status, 0, `${sub} ${bad}`);
        }
      }
      assert.deepEqual(s.argv(), [], 'no docker call for a refused session or id');
      assert.ok(fs.existsSync(path.join(s.jobDir(id), 'backing.json')), 'nothing torn down');
      // The job's own session may stop and start its environment.
      for (const sub of ['stop', 'up']) {
        const own = await s.cli(['environment', sub, id], { ...trust, FORGE_DAEMON_SCOPE: id });
        assert.equal(own.status, 0, `${sub}: ${own.stdout}${own.stderr}`);
      }
      // The job's own session may tear its environment down.
      const own = await s.cli(['environment', 'down', id], { ...trust, FORGE_DAEMON_SCOPE: id });
      assert.equal(own.status, 0, own.stdout + own.stderr);
      assert.equal(own.json.ok, true);
    } finally {
      s.cleanup();
    }
  });

  test('stop keeps volumes and databases', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('Stop me');
      const wt = await s.cli(['worktree', 'create', id]);
      assert.equal(wt.json.ok, true, JSON.stringify(wt.json));
      const db = wt.json.backing[1].database.name;
      const server = Object.keys(s.state().pg)[0];
      const shared = Object.keys(s.state().containers).find((n) => n.endsWith('-pg'))!;
      assert.equal(s.record().jobs[id].state, 'running', 'worktree create marks it running');
      // Another job's same-named container whose labels are not this checkout's.
      const other = await s.newJob('Not mine');
      const foreign = `forge-${other}-postgres`;
      s.setState({ containers: { ...s.state().containers, [foreign]: { running: true, labels: { 'forge.root': 'someone-else', 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': other } } } });
      s.clearArgv();

      const stop = await s.cli(['environment', 'stop', id]);
      assert.equal(stop.status, 0, stop.stderr);
      assert.deepEqual(stop.json.stopped, [`forge-${id}-postgres`]);
      const stops = s.argv().filter((a) => a[0] === 'stop');
      assert.deepEqual(stops, [['stop', '--time', '10', '--', `forge-${id}-postgres`]], 'only this job’s labelled container');
      assert.ok(!s.argv().some((a) => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm')), 'nothing removed');
      assert.equal(s.state().containers[`forge-${id}-postgres`].running, false);
      assert.ok(s.state().volumes[`forge-${id}-postgres-0`], 'volume kept');
      assert.ok(s.state().pg[server].dbs[db], 'database kept');
      assert.ok(s.state().containers[shared].running, 'the shared server stays');
      assert.ok(fs.existsSync(path.join(s.jobDir(id), 'backing.json')));
      assert.ok(fs.existsSync(path.join(s.jobDir(id), 'backing-db.json')));
      assert.equal(s.record().jobs[id].state, 'stopped');
      const ev = s.events(id).filter((e) => e.type === 'environment-stop');
      assert.equal(ev.length, 1);
      assert.equal(ev[0].trigger, 'cli');
      assert.equal(ev[0].ok, true);

      // A planted same-named container without this job's labels is never stopped.
      const planted = await s.cli(['environment', 'stop', other]);
      assert.equal(planted.status, 0, planted.stderr);
      assert.deepEqual(planted.json.stopped, []);
      assert.equal(s.state().containers[foreign].running, true);
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

describe('environment cap', { concurrency: 4 }, () => {
  test('maxRunning is set and checked through forge config set', async () => {
    const s = scratch(plainTemplate);
    try {
      const set = await s.cli(['config', 'set', 'environments.maxRunning', '3']);
      assert.equal(set.status, 0, set.stdout + set.stderr);
      assert.equal((await s.cli(['environment', 'list'])).json.maxRunning, 3);
      for (const bad of ['0', '65', 'abc']) {
        const r = await s.cli(['config', 'set', 'environments.maxRunning', bad]);
        assert.notEqual(r.status, 0, bad);
      }
      assert.equal((await s.cli(['environment', 'list'])).json.maxRunning, 3, 'a refused value changes nothing');
    } finally {
      s.cleanup();
    }
  });

  test('concurrent ensure respects the cap', async () => {
    const s = scratch(plainTemplate);
    try {
      assert.equal((await s.cli(['config', 'set', 'environments.maxRunning', '2'])).status, 0);
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await s.newJob(`Job ${i}`));
      const file = path.join(s.dir, '.forge', 'runtime', 'environments.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      for (let round = 0; round < 2; round++) {
        const old = new Date(Date.now() - 60_000).toISOString();
        fs.writeFileSync(file, JSON.stringify({ v: 1, jobs: { [ids[0]]: { state: 'running', usedAt: old }, [ids[1]]: { state: 'running', usedAt: old } } }));
        // Two child processes against one root, both past the cap.
        const [p, q] = [ids[2 + round * 2], ids[3 + round * 2]];
        const [rp, rq] = await Promise.all([s.cli(['environment', 'up', p]), s.cli(['environment', 'up', q])]);
        assert.equal(rp.status, 0, rp.stdout + rp.stderr);
        assert.equal(rq.status, 0, rq.stdout + rq.stderr);
        const running = Object.entries(s.record().jobs).filter(([, e]: any) => e.state === 'running').map(([id]) => id);
        assert.ok(running.length <= 2, `round ${round}: ${running.join(',')}`);
        assert.ok(running.includes(p) && running.includes(q), 'each started job keeps its place');
        assert.equal(rp.json.evicted.length + rq.json.evicted.length, 2, 'the two older entries were evicted once each');
      }
    } finally {
      s.cleanup();
    }
  });
});

describe('environment on demand', { concurrency: 4 }, () => {
  test('verify ensures the environment', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('Verify me');
      assert.equal((await s.cli(['worktree', 'create', id])).json.ok, true);
      assert.equal((await s.cli(['environment', 'stop', id])).status, 0);
      assert.equal(s.state().containers[`forge-${id}-postgres`].running, false);

      const v = await s.cli(['verify', id]);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      const names = v.json.steps.map((x: any) => x.name);
      assert.ok(names.indexOf('environment') >= 0 && names.indexOf('environment') < names.indexOf('test'), names.join(','));
      assert.equal(v.json.steps.find((x: any) => x.name === 'environment').ok, true);
      assert.equal(s.state().containers[`forge-${id}-postgres`].running, true, 'started before the commands');
      assert.equal(s.record().jobs[id].state, 'running');
      assert.equal(s.events(id).filter((e) => e.type === 'environment-up').at(-1).trigger, 'verify');

      s.setState({ daemon: 'down' });
      const down = await s.cli(['verify', id]);
      assert.equal(down.status, 1);
      assert.equal(down.json.ok, false);
      assert.equal(down.json.failure.name, 'environment');
      assert.match(down.json.failure.tail, /daemon is not reachable/);
      assert.ok(!down.json.steps.some((x: any) => x.name === 'test'), 'no configured command ran');
    } finally {
      s.cleanup();
    }
  });

  test('verify without managed backing makes no docker call', async () => {
    const s = scratch(plainTemplate);
    try {
      const id = await s.newJob('Plain');
      assert.equal((await s.cli(['worktree', 'create', id])).status, 0);
      const v = await s.cli(['verify', id]);
      assert.equal(v.status, 0, v.stdout + v.stderr);
      assert.ok(!v.json.steps.some((x: any) => x.name === 'environment'));
      assert.deepEqual(s.argv(), []);
    } finally {
      s.cleanup();
    }
  });

  test('run --background and focus start on demand', async () => {
    const s = scratch();
    try {
      const id = await s.newJob('On demand');
      assert.equal((await s.cli(['worktree', 'create', id])).json.ok, true);
      const name = `forge-${id}-postgres`;
      assert.equal((await s.cli(['environment', 'stop', id])).status, 0);
      const before = s.record().jobs[id].usedAt;
      await new Promise((r) => setTimeout(r, 5));

      const bg = await s.cli(['run', id, 'dev', '--background']);
      assert.equal(bg.status, 0, bg.stderr);
      const pid = devPid(s, id);
      assert.equal(s.state().containers[name].running, true, 'run --background started it');
      assert.equal(s.record().jobs[id].state, 'running');
      assert.ok(s.record().jobs[id].usedAt > before, 'a fresh usedAt');

      // Stop clears the dev server too; focus starts the container again but no process.
      assert.equal((await s.cli(['environment', 'stop', id])).status, 0);
      await waitFor(() => !pidAlive(pid), { what: 'the dev server to stop' });
      const stoppedAt = s.record().jobs[id].usedAt;
      await new Promise((r) => setTimeout(r, 5));
      const focus = await s.cli(['focus', id]);
      assert.equal(focus.status, 0, focus.stderr);
      assert.equal(focus.json.focus.id, id);
      assert.deepEqual(focus.json.environment, { ok: true });
      assert.equal(s.state().containers[name].running, true, 'focus started it');
      assert.equal(s.record().jobs[id].state, 'running');
      assert.ok(s.record().jobs[id].usedAt > stoppedAt);
      assert.equal(s.events(id).filter((e) => e.type === 'environment-up').at(-1).trigger, 'focus');

      // A failed bring-up never undoes the focus.
      const other = await s.newJob('Focus anyway');
      s.setState({ daemon: 'down' });
      const failed = await s.cli(['focus', other]);
      assert.equal(failed.status, 0, failed.stderr);
      assert.equal(failed.json.focus.id, other);
      assert.equal(failed.json.environment.ok, false);
      assert.match(failed.json.environment.error, /daemon is not reachable/);
      // And run --background refuses to start a server without its services.
      const refused = await s.cli(['run', id, 'dev', '--background']);
      assert.equal(refused.status, 5, refused.stdout + refused.stderr);
      const rt = path.join(s.jobDir(id), 'runtime.json');
      assert.equal(fs.existsSync(rt) ? JSON.parse(fs.readFileSync(rt, 'utf8')).dev : undefined, undefined, 'no process started');
    } finally {
      s.cleanup();
    }
  });
});
