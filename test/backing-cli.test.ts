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
    assert.deepEqual(Object.keys(status.json.services[0]), ['name', 'isolation', 'container', 'state', 'host', 'ports', 'env']);
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
