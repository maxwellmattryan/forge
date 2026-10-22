// `forge backing up|status|stop|down` end to end (issue #193): the real CLI with a fake docker first on
// PATH (test/fixtures/docker-bin/docker, which is test/fixtures/fake-docker.mjs) recording argv. What
// lib/backing.ts decides is test/backing.test.ts, in-process; this file keeps the CLI's wiring, exit codes and scopes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as b from '../../../lib/backing.ts';
import type { DockerRunner } from '../../../lib/backing.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '../../../lib/config.ts';
import { createJob, loadJob } from '../../../lib/jobs.ts';
import { createWorktree } from '../../../lib/worktree.ts';
import { emptyState, handle } from '../../fixtures/fake-docker.mjs';
import { forgeAsync, forgeSync, repoTemplate, waitFor } from '../../helpers.ts';

const DOCKER_BIN = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'docker-bin');
const BACKING = [
  { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], env: { POSTGRES_DB: 'app' }, volumes: ['/var/lib/postgresql/data'] },
  { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] },
];
// Joined at runtime: the installed secret scan reads `{user}:{password}@` as a url credential.
const DB_URL = ['postgres://{user}', '{password}@{host}:{port}/{database}'].join(':');
const DB_BACKING = [{ name: 'pg', isolation: 'shared', image: 'postgres:16', ports: [5432], url: DB_URL, database: { engine: 'postgres', migrate: 'echo migrate >> $FORGE_WORKTREE/db.log' } }];

/** A committed forge repo from these answers, with these backing entries. */
const forgeRepo = (answers: object, backing: unknown[]) =>
  repoTemplate((dir) => {
    const file = path.join(dir, '.answers.json');
    fs.writeFileSync(file, JSON.stringify(answers));
    const init = forgeSync(dir, ['init', 'write', '--answers', file]);
    if (init.status !== 0) throw new Error(init.stderr);
    fs.rmSync(file);
    const cfg = path.join(dir, '.forge', 'config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(backing)}`));
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
  });
const ANSWERS = { commands: { test: 'true' }, worktrees: { root: '../{repo}.wt' }, tracker: { kind: 'none' } };
const template = forgeRepo(ANSWERS, BACKING);
const dbTemplate = forgeRepo(ANSWERS, DB_BACKING);
// For the in-process half of the tests below: a probe command, and each test writes its own entries.
const probeTemplate = forgeRepo({ ...ANSWERS, commands: { test: 'true', probe: 'env | grep ^FORGE_BACKING_ > "$FORGE_WORKTREE/backing.env" || true' }, verify: ['test'] }, []);

/** A scratch repo and the fake docker on PATH for its CLI calls; cleanup removes its worktrees too. */
function cliScratch(make = template) {
  const r = make();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docker-')));
  const stateFile = path.join(tmp, 'state.json');
  const env = { PATH: `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_STATE: stateFile, FAKE_DOCKER_LOG: path.join(tmp, 'argv.log') };
  const cli = async (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    const res = await forgeAsync(r.dir, args, { ...env, ...extra });
    return { ...res, json: res.status === 0 || res.stdout.trim().startsWith('{') ? JSON.parse(res.stdout) : null };
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const setState = (patch: object) => fs.writeFileSync(stateFile, JSON.stringify({ ...state(), ...patch }));
  const cleanup = () => {
    r.cleanup();
    fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  return { dir: r.dir, env, tmp, cli, state, setState, cleanup };
}

test('forge backing with a job database', async () => {
  const s = cliScratch(dbTemplate);
  try {
    const { id } = (await s.cli(['job', 'new', '--title', 'Cli database'])).json;
    const recordFile = path.join(s.dir, '.forge', 'jobs', id, 'backing-db.json');
    // A job.json worktree pointing anywhere does not count: only the path Forge computes does.
    const elsewhere = fs.mkdtempSync(path.join(s.tmp, 'elsewhere-'));
    const jobFile = path.join(s.dir, '.forge', 'jobs', id, 'job.json');
    fs.writeFileSync(jobFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile, 'utf8')), worktree: elsewhere }));
    const noWt = await s.cli(['backing', 'up', id]);
    assert.equal(noWt.status, 5, noWt.stderr);
    assert.equal(noWt.json.services[0].ok, false);
    assert.equal(noWt.json.services[0].error, `job ${id} has no worktree: run forge worktree create ${id}`);
    assert.ok(!fs.existsSync(path.join(elsewhere, 'db.log')), 'nothing ran in job.worktree');
    const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
    delete job.worktree;
    fs.writeFileSync(jobFile, JSON.stringify(job));

    // Template built or reused and where passwords go are test/backing-db.test.ts, in-process.
    const wt = await s.cli(['worktree', 'create', id]);
    assert.equal(wt.status, 0, wt.stderr);
    const name = wt.json.backing[0].database.name;
    assert.match(name, /^forge_j_[a-z0-9_]+_[0-9a-f]{8}$/);
    const down1 = await s.cli(['backing', 'down', id]);
    assert.equal(down1.status, 0, down1.stderr);
    assert.deepEqual(down1.json.databases, [name]);

    const up = await s.cli(['backing', 'up', id]);
    assert.equal(up.status, 0, up.stderr);
    const t = up.json.services[0].database.template;
    assert.deepEqual([up.json.services[0].action, up.json.services[0].ok], ['running', true]);
    assert.equal(up.json.services[0].database.name, name);
    assert.equal(up.json.services[0].database.action, 'created');
    const server = Object.keys(s.state().pg)[0];
    assert.ok(s.state().pg[server].dbs[name]);

    const status = await s.cli(['backing', 'status', id]);
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(status.json.services[0].database, { name, template: t });
    assert.ok(status.json.services[0].env.includes('FORGE_BACKING_PG_URL'));
    const human = await forgeAsync(s.dir, ['backing', 'status', id, '--mode', 'human'], s.env);
    assert.match(human.stdout, /\bdatabase\b/);
    assert.ok(human.stdout.includes(name));

    const down = await s.cli(['backing', 'down', id]);
    assert.equal(down.status, 0, down.stderr);
    assert.deepEqual(down.json, { job: id, removed: [], volumes: [], databases: [name], ok: true });
    assert.ok(!s.state().pg[server].dbs[name], 'dropped');
    assert.ok(!fs.existsSync(recordFile));
    const after = await s.cli(['backing', 'status', id]);
    assert.deepEqual(after.json.services[0].database, { name, template: null });
    assert.ok(!after.json.services[0].env.includes('FORGE_BACKING_PG_URL'), 'no url env without a record');
  } finally {
    s.cleanup();
  }
});

test('forge backing up|status|down', async () => {
  const s = cliScratch();
  try {
    const { id } = (await s.cli(['job', 'new', '--title', 'Cli backing'])).json;

    // The docker run argv (env only via an env file) is backing.test.ts › "docker run argv: …".
    const up = await s.cli(['backing', 'up', id]);
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
    assert.ok(s.state().containers[`forge-${id}-postgres`].running);

    const status = await s.cli(['backing', 'status', id]);
    assert.equal(status.status, 0);
    assert.deepEqual(Object.keys(status.json), ['job', 'docker', 'services']);
    assert.equal(status.json.docker, 'ok');
    assert.deepEqual(Object.keys(status.json.services[0]), ['name', 'isolation', 'container', 'state', 'health', 'host', 'ports', 'env']);
    assert.equal(status.json.services[0].state, 'running');
    const all = await s.cli(['backing', 'status']);
    assert.equal(all.status, 0);
    assert.deepEqual(
      all.json.containers.map((c) => [c.name.endsWith('-redis') ? 'redis' : c.name, c.orphan]),
      [[`forge-${id}-postgres`, false], ['redis', false]],
    );

    // The inbox daemon session never drives a job.
    const trust = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.dir), FORGE_DAEMON_SCOPE: '_inbox' };
    const refused = await s.cli(['backing', 'up', id], trust);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /the inbox daemon session does not drive jobs/);
    // Nor does it, or the office, tear down the shared services every job uses.
    const sharedBefore = Object.keys(s.state().containers).filter((n) => n.endsWith('-redis'));
    assert.equal(sharedBefore.length, 1);
    for (const scope of ['_inbox', '_office']) {
      const shared = await s.cli(['backing', 'down', '--shared'], { ...trust, FORGE_DAEMON_SCOPE: scope });
      assert.equal(shared.status, 1, scope);
      assert.match(shared.stdout + shared.stderr, scope === '_inbox' ? /the inbox daemon session does not drive jobs/ : /the office session decides gates and does not drive jobs/);
      assert.deepEqual(Object.keys(s.state().containers).filter((n) => n.endsWith('-redis')), sharedBefore, `${scope}: shared container kept`);
    }
    // What backing stop stops and skips is backing.test.ts › "backingStop stops only this job's containers".
    assert.equal((await s.cli(['backing', 'stop', '../x'])).status, 1, 'invalid id');

    // A stopped daemon: up, status, stop and down exit 5 and say why. The action each reports and the
    // record kept for a retry are backing.test.ts › "a failed bring-up reports…" and "teardown removes only…".
    s.setState({ daemon: 'down' });
    const stopped = await s.cli(['backing', 'up', id]);
    assert.equal(stopped.status, 5);
    assert.equal(stopped.json.ok, false);
    assert.match(stopped.json.services[0].error, /^docker is installed but its daemon is not reachable/);
    const statusDown = await s.cli(['backing', 'status']);
    assert.equal(statusDown.status, 5);
    const stopDown = await s.cli(['backing', 'stop', id]);
    assert.equal(stopDown.status, 5);
    assert.equal(stopDown.json.job, id);
    assert.equal(stopDown.json.ok, false);
    assert.match(stopDown.json.error, /daemon is not reachable/);
    const downFails = await s.cli(['backing', 'down', id]);
    assert.equal(downFails.status, 5);
    assert.equal(downFails.json.ok, false);
    s.setState({ daemon: 'up' });

    const down = await s.cli(['backing', 'down', id]);
    assert.equal(down.status, 0, down.stderr);
    assert.deepEqual(down.json, { job: id, removed: [`forge-${id}-postgres`], volumes: [`forge-${id}-postgres-0`], ok: true });
    assert.ok(Object.keys(s.state().containers).some((n) => n.endsWith('-redis')), 'shared kept');
    const shared = await s.cli(['backing', 'down', '--shared']);
    assert.equal(shared.status, 0);
    assert.equal(shared.json.removed.length, 1);
    assert.deepEqual(s.state().containers, {});

    // worktree remove exits 1 when its teardown fails, and still removes the worktree.
    const wt = await s.cli(['worktree', 'create', id]);
    assert.equal(wt.status, 0, wt.stderr);
    assert.equal(wt.json.ok, true);
    s.setState({ daemon: 'down' });
    const removed = await s.cli(['worktree', 'remove', id]);
    assert.equal(removed.status, 1);
    assert.ok(removed.json.removed);
    assert.equal(removed.json.backing.ok, false);
  } finally {
    s.cleanup();
  }
});

// Built at runtime: a literal that looks like a credential would trip the secret scan on commit.
const SECRET = ['s3cr3t', 'pg', 'value'].join('-');
const PG = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], env: { POSTGRES_PASSWORD: SECRET, POSTGRES_DB: 'app' }, volumes: ['/var/lib/postgresql/data'], url: `postgres://postgres:${SECRET}@{host}:{port}/app` };
const REDIS = { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] };
const QUEUE = { name: 'queue', isolation: 'external', url: 'amqp://mq.internal:5672' };

/** A scratch repo whose config has these backing entries, for in-process setup; cleanup removes its worktrees too. */
function scratch(backing: unknown[]) {
  const r = probeTemplate();
  const file = path.join(r.dir, '.forge', 'config.yml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(backing)}`));
  const config = loadConfig(r.dir).config;
  assert.deepEqual(config.backing, backing);
  return { dir: r.dir, config, cleanup: () => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })) };
}

/** The in-memory docker, as test/backing.test.ts injects it. */
function fakeRunner(): DockerRunner {
  const state = emptyState();
  return (args) => {
    const r = handle(state, args);
    return { ok: r.status === 0, ...r };
  };
}

test('backing env reaches configured commands', async () => {
  const s = scratch([PG, REDIS, QUEUE]);
  const prev = b.setDockerRunner(fakeRunner());
  try {
    const id = createJob(s.dir, s.config, { title: 'Env' }).id;
    assert.deepEqual(b.backingEnv(s.dir, s.config, { id }), { FORGE_BACKING_QUEUE_URL: 'amqp://mq.internal:5672' }, 'nothing for a managed entry not yet up');
    const created = createWorktree(s.dir, s.config, id);
    assert.ok(created.ok);
    const pg = b.readJobRecord(s.dir, id, s.config).ports.postgres['5432'];
    const redis = b.readSharedRecord(s.dir, s.config).ports.redis['6379'];
    const want = {
      FORGE_BACKING_POSTGRES_HOST: '127.0.0.1',
      FORGE_BACKING_POSTGRES_PORT: String(pg),
      FORGE_BACKING_POSTGRES_PORT_5432: String(pg),
      FORGE_BACKING_POSTGRES_URL: `postgres://postgres:${SECRET}@127.0.0.1:${pg}/app`,
      FORGE_BACKING_REDIS_HOST: '127.0.0.1',
      FORGE_BACKING_REDIS_PORT: String(redis),
      FORGE_BACKING_REDIS_PORT_6379: String(redis),
      FORGE_BACKING_QUEUE_URL: 'amqp://mq.internal:5672',
    };
    assert.deepEqual(b.backingEnv(s.dir, s.config, { id }), want);
    assert.ok(!('FORGE_BACKING_QUEUE_HOST' in b.backingEnv(s.dir, s.config, { id })));
    // Through envFor composition in the real CLI: `forge run` needs no Docker.
    const r = await forgeAsync(s.dir, ['run', id, 'probe']);
    assert.equal(r.status, 0, r.stderr);
    const seen = Object.fromEntries(
      fs
        .readFileSync(path.join(loadJob(s.dir, id).worktree!, 'backing.env'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    assert.deepEqual(seen, want);
  } finally {
    b.setDockerRunner(prev);
    s.cleanup();
  }
});

test('job ports are allocated under the backing ports lock', async () => {
  const s = scratch([]);
  const lock = b.portsLock(s.dir);
  try {
    const id = createJob(s.dir, s.config, { title: 'Locked' }).id;
    fs.mkdirSync(lock, { recursive: true });
    const pending = forgeAsync(s.dir, ['worktree', 'create', id]);
    // git has made the worktree, so the create is past everything before the port.
    await waitFor(() => fs.existsSync(`${s.dir}.wt`) && fs.readdirSync(`${s.dir}.wt`).length > 0, { what: 'the worktree' });
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(loadJob(s.dir, id).port ?? null, null, 'no port while another create holds the lock');
    fs.rmdirSync(lock);
    const r = await pending;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).ok, true);
    assert.equal(loadJob(s.dir, id).port, s.config.ports.base);
    assert.ok(!fs.existsSync(lock), 'released');
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
    s.cleanup();
  }
});
