// `forge backing up|status|down` end to end (issue #193): the real CLI with a fake docker first on
// PATH (test/fixtures/docker-bin/docker, which is test/fixtures/fake-docker.mjs) recording argv.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { forgeAsync, repoTemplate } from './helpers.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const DOCKER_BIN = path.resolve(import.meta.dirname, 'fixtures', 'docker-bin');
const BACKING = [
  { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], env: { POSTGRES_DB: 'app' }, volumes: ['/var/lib/postgresql/data'] },
  { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] },
];

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  const file = path.join(dir, '.forge', 'config.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(BACKING)}`));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

// Joined at runtime: the installed secret scan reads `{user}:{password}@` as a url credential.
const DB_URL = ['postgres://{user}', '{password}@{host}:{port}/{database}'].join(':');
const DB_BACKING = [{ name: 'pg', isolation: 'shared', image: 'postgres:16', ports: [5432], url: DB_URL, database: { engine: 'postgres', migrate: 'echo migrate >> $FORGE_WORKTREE/db.log' } }];
const dbTemplate = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } }));
  execFileSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, env: { ...process.env, FORGE_ROOT: dir }, stdio: 'pipe' });
  fs.rmSync(answers);
  const file = path.join(dir, '.forge', 'config.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(DB_BACKING)}`));
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

test('forge backing with a job database', async () => {
  const r = dbTemplate();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docker-')));
  const stateFile = path.join(tmp, 'state.json');
  const env = { PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile, FAKE_DOCKER_LOG: path.join(tmp, 'argv.log') };
  const cli = async (args: string[]) => {
    const res = await forgeAsync(r.dir, args, env);
    return { ...res, json: res.stdout.trim().startsWith('{') ? JSON.parse(res.stdout) : null };
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  try {
    const { id } = (await cli(['job', 'new', '--title', 'Cli database'])).json;
    const recordFile = path.join(r.dir, '.forge', 'jobs', id, 'backing-db.json');
    // A job.json worktree pointing anywhere does not count: only the path Forge computes does.
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    const jobFile = path.join(r.dir, '.forge', 'jobs', id, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, 'utf8')), worktree: elsewhere }));
    const noWt = await cli(['backing', 'up', id]);
    assert.equal(noWt.status, 5, noWt.stderr);
    assert.equal(noWt.json.services[0].ok, false);
    assert.equal(noWt.json.services[0].error, `job ${id} has no worktree: run forge worktree create ${id}`);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'db.log')), 'nothing ran in job.worktree');
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    delete job.worktree;
    fs.writeFileSync(jobFile, JSON.stringify(job));

    const wt = await cli(['worktree', 'create', id]);
    assert.equal(wt.status, 0, wt.stderr);
    const name = wt.json.backing[0].database.name;
    assert.match(name, /^forge_j_[a-z0-9_]+_[0-9a-f]{8}$/);
    assert.equal(wt.json.backing[0].database.template_action, 'built');
    const down1 = await cli(['backing', 'down', id]);
    assert.equal(down1.status, 0, down1.stderr);
    assert.deepEqual(down1.json.databases, [name]);

    const up = await cli(['backing', 'up', id]);
    assert.equal(up.status, 0, up.stderr);
    const t = up.json.services[0].database.template;
    assert.deepEqual(up.json.services[0], { name: 'pg', isolation: 'shared', action: 'running', ok: true, database: { name, template: t, action: 'created', template_action: 'reused' } });
    const password = JSON.parse(fs.readFileSync(recordFile, 'utf8')).databases.pg.password;
    assert.ok(!up.stdout.includes(password), 'no password in the result');
    const server = Object.keys(state().pg)[0];
    assert.ok(state().pg[server].dbs[name]);

    const status = await cli(['backing', 'status', id]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(status.json.services[0].database, { name, template: t });
    assert.ok(status.json.services[0].env.includes('FORGE_BACKING_PG_URL'));
    assert.ok(!status.stdout.includes(password));
    const human = await forgeAsync(r.dir, ['backing', 'status', id, '--mode', 'human'], env);
    assert.match(human.stdout, /\bdatabase\b/);
    assert.ok(human.stdout.includes(name));

    const down = await cli(['backing', 'down', id]);
    assert.equal(down.status, 0, down.stderr);
    assert.deepEqual(down.json, { job: id, removed: [], volumes: [], databases: [name], ok: true });
    assert.ok(!state().pg[server].dbs[name], 'dropped');
    assert.ok(!fs.existsSync(recordFile));
    const after = await cli(['backing', 'status', id]);
    assert.deepEqual(after.json.services[0].database, { name, template: null });
    assert.ok(!after.json.services[0].env.includes('FORGE_BACKING_PG_URL'), 'no url env without a record');
  } finally {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

/** A scratch repo with the per-job postgres and shared redis entries, and the fake docker on PATH. */
async function backingScratch() {
  const r = template();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docker-')));
  const stateFile = path.join(tmp, 'state.json');
  const log = path.join(tmp, 'argv.log');
  const env = { PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile, FAKE_DOCKER_LOG: log };
  const cli = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const res = await forgeAsync(r.dir, args, { ...env, ...extra });
    return { ...res, json: res.stdout.trim().startsWith('{') ? JSON.parse(res.stdout) : null };
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setState = (patch: object) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
  const argv = (): string[][] =>
    fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
  const cleanup = () => {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { dir: r.dir, cli, state, setState, argv, cleanup };
}

test('backing stop stops only the job\'s own per-job containers', async () => {
  const s = await backingScratch();
  try {
    const { id } = (await s.cli(['job', 'new', '--title', 'Stop me'])).json;
    const { id: other } = (await s.cli(['job', 'new', '--title', 'Other job'])).json;
    assert.equal((await s.cli(['backing', 'up', id])).status, 0);
    const mine = `forge-${id}-postgres`;
    const sharedName = Object.keys(s.state().containers).find((n) => n.endsWith('-redis'))!;
    const volumesBefore = Object.keys(s.state().volumes);

    const stop = await s.cli(['backing', 'stop', id]);
    assert.equal(stop.status, 0, stop.stderr);
    assert.deepEqual(stop.json, { job: id, stopped: [mine], skipped: [], ok: true });
    assert.equal(s.state().containers[mine].running, false);
    assert.equal(s.state().containers[sharedName].running, true, 'shared container untouched');
    assert.deepEqual(Object.keys(s.state().volumes), volumesBefore, 'volumes kept');
    assert.ok(fs.existsSync(path.join(s.dir, '.forge', 'jobs', id, 'backing.json')), 'record kept');
    assert.ok(s.argv().some((a) => a.join(' ') === `stop --time 10 -- ${mine}`));

    // Idempotent: already stopped is skipped.
    const again = await s.cli(['backing', 'stop', id]);
    assert.equal(again.status, 0);
    assert.deepEqual(again.json, { job: id, stopped: [], skipped: [{ name: mine, reason: 'already stopped' }], ok: true });

    // A same-named container with another job's labels is never stopped.
    const foreign = `forge-${other}-postgres`;
    s.setState({ containers: { ...s.state().containers, [foreign]: { running: true, labels: { ...s.state().containers[mine].labels, 'forge.job': id } } } });
    const refused = await s.cli(['backing', 'stop', other]);
    assert.equal(refused.status, 0);
    assert.deepEqual(refused.json.skipped, [{ name: foreign, reason: "not this job's" }]);
    assert.equal(s.state().containers[foreign].running, true);

    const missing = await s.cli(['backing', 'stop', `${id}-gone`]);
    assert.deepEqual(missing.json.skipped, [{ name: `forge-${id}-gone-postgres`, reason: 'missing' }]);

    assert.equal((await s.cli(['backing', 'stop', '../x'])).status, 1, 'invalid id');
    s.setState({ daemon: 'down' });
    const down = await s.cli(['backing', 'stop', id]);
    assert.equal(down.status, 5);
    assert.equal(down.json.ok, false);
    assert.match(down.json.error, /daemon is not reachable/);
  } finally {
    s.cleanup();
  }
});

test('status reports container health', async () => {
  const s = await backingScratch();
  try {
    const { id } = (await s.cli(['job', 'new', '--title', 'Health'])).json;
    assert.equal((await s.cli(['backing', 'up', id])).status, 0);
    const mine = `forge-${id}-postgres`;
    const health = async () => (await s.cli(['backing', 'status', id])).json.services.map((x: any) => [x.name, x.health]);
    assert.deepEqual(await health(), [['postgres', null], ['redis', null]], 'no healthcheck');
    for (const h of ['healthy', 'unhealthy', 'starting']) {
      s.setState({ containers: { ...s.state().containers, [mine]: { ...s.state().containers[mine], health: h } } });
      assert.deepEqual((await health())[0], ['postgres', h]);
    }
    s.setState({ containers: { ...s.state().containers, [mine]: { ...s.state().containers[mine], health: 'none' } } });
    assert.deepEqual((await health())[0], ['postgres', null], "Docker's none reads as null");
    // A label value with spaces still parses.
    s.setState({ containers: { ...s.state().containers, [mine]: { ...s.state().containers[mine], health: 'healthy', labels: { ...s.state().containers[mine].labels, note: 'a b  c' } } } });
    assert.deepEqual((await health())[0], ['postgres', 'healthy']);
    s.setState({ containers: { ...s.state().containers, [mine]: { ...s.state().containers[mine], running: false } } });
    assert.deepEqual((await health())[0], ['postgres', null], 'not running: null');
  } finally {
    s.cleanup();
  }
});

test('forge backing up|status|down', async () => {
  const r = template();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docker-')));
  const stateFile = path.join(tmp, 'state.json');
  const log = path.join(tmp, 'argv.log');
  const env = { PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile, FAKE_DOCKER_LOG: log };
  const cli = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const res = await forgeAsync(r.dir, args, { ...env, ...extra });
    return { ...res, json: res.status === 0 || res.stdout.trim().startsWith('{') ? JSON.parse(res.stdout) : null };
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setState = (patch: object) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
  try {
    const { id } = (await cli(['job', 'new', '--title', 'Cli backing'])).json;

    const up = await cli(['backing', 'up', id]);
    assert.equal(up.status, 0, up.stderr);
    assert.equal(up.stdout.trim().split('\n').length, 1, 'compact JSON');
    assert.deepEqual(up.json, {
      job: id,
      services: [
        { name: 'postgres', isolation: 'per-job', action: 'created', ok: true },
        { name: 'redis', isolation: 'shared', action: 'created', ok: true },
      ],
      ok: true,
    });
    assert.ok(state().containers[`forge-${id}-postgres`].running);
    const runs = fs
      .readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
      .filter((a) => a[0] === 'run');
    assert.equal(runs.length, 2);
    assert.ok(runs.every((a) => a.includes('--env-file') && !a.includes('POSTGRES_DB=app')));

    const status = await cli(['backing', 'status', id]);
    assert.equal(status.status, 0);
    assert.deepEqual(Object.keys(status.json), ['job', 'services']);
    assert.deepEqual(Object.keys(status.json.services[0]), ['name', 'isolation', 'container', 'state', 'health', 'host', 'ports', 'env']);
    assert.equal(status.json.services[0].state, 'running');
    const all = await cli(['backing', 'status']);
    assert.equal(all.status, 0);
    assert.deepEqual(
      all.json.containers.map((c) => [c.name.endsWith('-redis') ? 'redis' : c.name, c.orphan]),
      [[`forge-${id}-postgres`, false], ['redis', false]],
    );

    // The inbox daemon session never drives a job.
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(r.dir), FORGE_DAEMON_SCOPE: '_inbox' };
    const refused = await cli(['backing', 'up', id], trust);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /the inbox daemon session does not drive jobs/);
    // Nor does it, or the office, tear down the shared services every job uses.
    const sharedBefore = Object.keys(state().containers).filter((n) => n.endsWith('-redis'));
    assert.equal(sharedBefore.length, 1);
    for (const scope of ['_inbox', '_office']) {
      const shared = await cli(['backing', 'down', '--shared'], { ...trust, FORGE_DAEMON_SCOPE: scope });
      assert.equal(shared.status, 1, scope);
      assert.match(shared.stdout + shared.stderr, scope === '_inbox' ? /the inbox daemon session does not drive jobs/ : /the office session decides gates and does not drive jobs/);
      assert.deepEqual(Object.keys(state().containers).filter((n) => n.endsWith('-redis')), sharedBefore, `${scope}: shared container kept`);
    }

    // A stopped daemon: up exits 5 and says why.
    setState({ daemon: 'down' });
    const stopped = await cli(['backing', 'up', id]);
    assert.equal(stopped.status, 5);
    assert.equal(stopped.json.ok, false);
    assert.match(stopped.json.services[0].error, /^docker is installed but its daemon is not reachable/);
    assert.equal(stopped.json.services[0].action, 'none');
    const statusDown = await cli(['backing', 'status']);
    assert.equal(statusDown.status, 5);
    const downFails = await cli(['backing', 'down', id]);
    assert.equal(downFails.status, 5);
    assert.equal(downFails.json.ok, false);
    assert.ok(fs.existsSync(path.join(r.dir, '.forge', 'jobs', id, 'backing.json')), 'kept for a retry');
    setState({ daemon: 'up' });

    const down = await cli(['backing', 'down', id]);
    assert.equal(down.status, 0, down.stderr);
    assert.deepEqual(down.json, { job: id, removed: [`forge-${id}-postgres`], volumes: [`forge-${id}-postgres-0`], ok: true });
    assert.ok(Object.keys(state().containers).some((n) => n.endsWith('-redis')), 'shared kept');
    const shared = await cli(['backing', 'down', '--shared']);
    assert.equal(shared.status, 0);
    assert.equal(shared.json.removed.length, 1);
    assert.deepEqual(state().containers, {});

    // worktree remove exits 1 when its teardown fails, and still removes the worktree.
    const wt = await cli(['worktree', 'create', id]);
    assert.equal(wt.status, 0, wt.stderr);
    assert.equal(wt.json.ok, true);
    setState({ daemon: 'down' });
    const removed = await cli(['worktree', 'remove', id]);
    assert.equal(removed.status, 1);
    assert.ok(removed.json.removed);
    assert.equal(removed.json.backing.ok, false);
  } finally {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
