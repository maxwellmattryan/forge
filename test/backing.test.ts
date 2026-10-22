// Backing services (issue #193): per-job, shared and external entries driven through an in-memory
// fake of the docker CLI (test/fixtures/fake-docker.mjs), injected with setDockerRunner or passed in.
// `forge backing` and the CLI paths that need a real child are test/integration/cli/backing.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as b from '../lib/backing.ts';
import type { DockerRunner } from '../lib/backing.ts';
import { loadConfig } from '../lib/config.ts';
import { doctor } from '../lib/doctor.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { loadStepInput, step } from '../lib/step.ts';
import { createWorktree, removeWorktree, runCommand, verify } from '../lib/worktree.ts';
import { emptyState, handle } from './fixtures/fake-docker.mjs';
import { forgeSync, repoTemplate } from './helpers.ts';

// Built at runtime: a literal that looks like a credential would trip the secret scan on commit.
const SECRET = ['s3cr3t', 'pg', 'value'].join('-');

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  fs.writeFileSync(
    answers,
    JSON.stringify({
      commands: { test: 'true', probe: 'env | grep ^FORGE_BACKING_ > "$FORGE_WORKTREE/backing.env" || true' },
      verify: ['test'],
      worktrees: { root: '../{repo}.wt' },
      tracker: { kind: 'none' },
    }),
  );
  const init = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (init.status !== 0) throw new Error(init.stderr);
  fs.rmSync(answers);
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'forge'], { cwd: dir, stdio: 'pipe' });
});

const PG = { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432], env: { POSTGRES_PASSWORD: SECRET, POSTGRES_DB: 'app' }, volumes: ['/var/lib/postgresql/data'], url: `postgres://postgres:${SECRET}@{host}:{port}/app` };
const REDIS = { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] };
const QUEUE = { name: 'queue', isolation: 'external', url: 'amqp://mq.internal:5672' };

/** A scratch repo whose config has these backing entries (and setup commands); cleanup removes its worktrees too. */
function scratch(backing: unknown[], setup: string[] = []) {
  const r = template();
  const file = path.join(r.dir, '.forge', 'config.yml');
  let text = fs.readFileSync(file, 'utf8').replace(/^backing: \[\]$/m, `backing: ${JSON.stringify(backing)}`);
  if (setup.length) text = text.replace(/^ {2}setup: \[\]$/m, `  setup: ${JSON.stringify(setup)}`);
  fs.writeFileSync(file, text);
  const config = loadConfig(r.dir).config;
  assert.deepEqual(config.backing, backing);
  if (setup.length) assert.deepEqual(config.worktrees.setup, setup);
  return { dir: r.dir, config, cleanup: () => (r.cleanup(), fs.rmSync(`${r.dir}.wt`, { recursive: true, force: true })) };
}

/** The in-memory docker: every call recorded, `missing` plays a machine without the binary. */
function fake(opts: { missing?: boolean } = {}) {
  const state = emptyState();
  const calls: string[][] = [];
  const runner: DockerRunner = (args) => {
    calls.push(args);
    if (opts.missing) return { ok: false, stdout: '', stderr: 'spawnSync docker ENOENT', status: null, missing: true };
    const r = handle(state, args);
    return { ok: r.status === 0, ...r };
  };
  const runs = () => calls.filter((c) => c[0] === 'run');
  const writes = () => calls.filter((c) => ['run', 'start', 'rm', 'stop'].includes(c[0]) || (c[0] === 'volume' && c[1] !== 'inspect'));
  return { state, calls, runner, runs, writes };
}

const flag = (argv: string[], f: string) => argv.flatMap((a, i) => (a === f ? [argv[i + 1]] : []));
const hostPort = (argv: string[]) => Number(flag(argv, '-p')[0].split(':')[1]);

/** Runs fn with `runner` as the CLI paths' docker, restoring the default after. */
async function withRunner<T>(runner: DockerRunner, fn: () => T | Promise<T>): Promise<T> {
  const prev = b.setDockerRunner(runner);
  try {
    return await fn();
  } finally {
    b.setDockerRunner(prev);
  }
}

test('two jobs get their own postgres on different ports and one shared redis', async () => {
  const s = scratch([PG, REDIS]);
  const f = fake();
  try {
    const a = createJob(s.dir, s.config, { title: 'Job A' }).id;
    const bId = createJob(s.dir, s.config, { title: 'Job B' }).id;
    const [ra, rb] = await withRunner(f.runner, () => [createWorktree(s.dir, s.config, a), createWorktree(s.dir, s.config, bId)]);
    assert.ok(ra.created && rb.created && ra.ok && rb.ok, JSON.stringify([ra, rb]));
    const pg = f.runs().filter((r) => r.at(-1) === 'postgres:16');
    assert.deepEqual(
      pg.map((r) => flag(r, '--name')[0]),
      [`forge-${a}-postgres`, `forge-${bId}-postgres`],
    );
    const ports = pg.map(hostPort);
    const jobPorts = [loadJob(s.dir, a).port, loadJob(s.dir, bId).port];
    assert.notEqual(ports[0], ports[1]);
    for (const p of ports) assert.ok(!jobPorts.includes(p), `${p} is not a job port ${jobPorts}`);
    const redis = f.runs().filter((r) => r.at(-1) === 'redis:7');
    assert.equal(redis.length, 1, 'one shared redis');
    assert.deepEqual(flag(redis[0], '--name'), [`forge-${b.projectSlug(s.dir, s.config)}-redis`]);
    assert.ok(!ports.includes(hostPort(redis[0])) && !jobPorts.includes(hostPort(redis[0])));
    assert.deepEqual(
      rb.created && rb.backing?.map((x) => [x.name, x.action, x.ok]),
      [
        ['postgres', 'created', true],
        ['redis', 'running', true],
      ],
      "the second job's call finds redis running",
    );
  } finally {
    s.cleanup();
  }
});

test('up is idempotent and never adopts a foreign container', () => {
  const s = scratch([PG]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Idem' }).id;
    const job = { id, port: 4100 };
    const name = `forge-${id}-postgres`;
    assert.deepEqual(b.backingUp(s.dir, s.config, job, f.runner), [{ name: 'postgres', isolation: 'per-job', action: 'created', ok: true }]);
    assert.equal(f.runs().length, 1);
    f.state.containers[name].running = false;
    assert.equal(b.backingUp(s.dir, s.config, job, f.runner)[0].action, 'started');
    assert.equal(f.state.containers[name].running, true);
    const before = f.writes().length;
    assert.equal(b.backingUp(s.dir, s.config, job, f.runner)[0].action, 'running');
    assert.equal(f.writes().length, before, 'a running container gets no docker write');

    // Another checkout's container, or another job's, under this job's name.
    const other = createJob(s.dir, s.config, { title: 'Other' }).id;
    const foreign = `forge-${other}-postgres`;
    for (const labels of [
      { 'forge.root': '000000000000', 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': other },
      { 'forge.root': b.rootLabel(s.dir), 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': 'someone-else' },
    ]) {
      f.state.containers[foreign] = { running: false, labels, image: 'postgres:16', ports: [] };
      const writes = f.writes().length;
      const [r] = b.backingUp(s.dir, s.config, { id: other, port: 4101 }, f.runner);
      assert.equal(r.ok, false);
      assert.equal(r.error, `container ${foreign} exists and is not this job's`);
      assert.equal(r.action, 'none', 'refused before touching it');
      assert.equal(f.writes().length, writes, 'not started, stopped or removed');
      assert.equal(f.state.containers[foreign].running, false);
      assert.equal(b.backingDown(s.dir, s.config, other, f.runner).ok, true);
      assert.ok(f.state.containers[foreign], 'teardown leaves it too');
    }
  } finally {
    s.cleanup();
  }
});

test('docker run argv: labels, loopback ports, named volumes, env only via a 0600 env file', () => {
  const s = scratch([PG, REDIS]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Argv' }).id;
    b.backingUp(s.dir, s.config, { id, port: 4100 }, f.runner);
    const root = b.rootLabel(s.dir);
    assert.equal(f.runs().length, 2);
    for (const argv of f.runs()) {
      const labels = flag(argv, '--label');
      const shared = argv.at(-1) === 'redis:7';
      const name = shared ? 'redis' : 'postgres';
      assert.ok(labels.includes(`forge.root=${root}`) && labels.includes(`forge.backing=${name}`) && labels.includes(`forge.isolation=${shared ? 'shared' : 'per-job'}`), labels.join(' '));
      assert.equal(labels.includes(`forge.job=${id}`), !shared);
      assert.ok(flag(argv, '-p').length && flag(argv, '-p').every((p) => /^127\.0\.0\.1:\d+:\d+$/.test(p)), 'only loopback bindings');
      for (const v of flag(argv, '-v')) assert.match(v, /^forge-[^:]+-\d+:\/[^:]*$/, 'named volumes only');
      assert.equal(flag(argv, '--env-file').length, 1);
      assert.ok(!argv.some((a) => a.includes(SECRET) || a.includes('POSTGRES_DB')), 'no env value or name in argv');
    }
    assert.deepEqual(flag(f.runs()[0], '-v'), [`forge-${id}-postgres-0:/var/lib/postgresql/data`]);
    const [pgEnv] = f.state.envFiles;
    assert.equal(pgEnv.mode, 0o600);
    assert.equal(pgEnv.body, `POSTGRES_PASSWORD=${SECRET}\nPOSTGRES_DB=app\n`);
    for (const e of f.state.envFiles) assert.ok(!fs.existsSync(e.path) && !fs.existsSync(path.dirname(e.path)), 'gone after the call');

    // On failure too, and the error carries no value.
    f.state.failRun = true;
    const failed = createJob(s.dir, s.config, { title: 'Fails' }).id;
    const [r] = b.backingUp(s.dir, s.config, { id: failed, port: 4101 }, f.runner);
    assert.equal(r.ok, false);
    assert.match(r.error!, /^docker run failed: .*port is already allocated$/s);
    assert.ok(!r.error!.includes(SECRET));
    const last = f.state.envFiles.at(-1);
    assert.equal(last.mode, 0o600);
    assert.ok(!fs.existsSync(last.path) && !fs.existsSync(path.dirname(last.path)));
  } finally {
    s.cleanup();
  }
});

test('no backing entries means no docker calls', async () => {
  const s = scratch([]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Plain' }).id;
    await withRunner(f.runner, async () => {
      const created = createWorktree(s.dir, s.config, id);
      assert.ok(created.created && created.ok);
      assert.ok(!('backing' in created));
      const ran = runCommand(s.dir, s.config, id, 'probe');
      assert.ok(ran.ok && !('backing' in ran));
      setJob(s.dir, id, { fields: { round: 1 } });
      const v = await verify(s.dir, s.config, id);
      assert.ok(!('backing' in v));
      const report = await doctor(s.dir, s.config, true);
      assert.ok(!report.checks.some((c) => c.name === 'docker'), 'no docker check');
      const removed = await removeWorktree(s.dir, id, { force: true });
      assert.ok(removed.removed && !('backing' in removed));
    });
    assert.deepEqual(f.calls, [], 'Docker is never called');
    assert.equal(b.dockerCheck(s.config, f.runner), null);
    assert.deepEqual(b.backingEnv(s.dir, s.config, { id }), {});
    // An external-only config needs no Docker either.
    const ext = { ...s.config, backing: [QUEUE] } as typeof s.config;
    assert.equal(b.dockerCheck(ext, f.runner), null);
    assert.deepEqual(b.backingUp(s.dir, ext, { id }, f.runner), [{ name: 'queue', isolation: 'external', action: 'external', ok: true }]);
    assert.deepEqual(f.calls, []);
  } finally {
    s.cleanup();
  }
});

test('allocator keeps job and backing ports distinct', async () => {
  const s = scratch([PG, REDIS]);
  const f = fake();
  const base = s.config.ports.base;
  const jobRecord = (id: string) => path.join(s.dir, '.forge', 'jobs', id, 'backing.json');
  const write = (file: string, ports: unknown) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, JSON.stringify({ v: 1, ports })));
  try {
    const active = createJob(s.dir, s.config, { title: 'Active' }).id;
    setJob(s.dir, active, { fields: { port: base } });
    const cancelled = createJob(s.dir, s.config, { title: 'Cancelled' }).id;
    setJob(s.dir, cancelled, { state: 'cancelled' });
    write(jobRecord(cancelled), { postgres: { 5432: base + 1 } });
    write(path.join(s.dir, '.forge', 'runtime', 'backing.json'), { redis: { 6379: base + 2 } });
    const x = createJob(s.dir, s.config, { title: 'X' }).id;
    const recs = b.allocateBacking(s.dir, s.config, { id: x, port: base + 3 });
    assert.deepEqual(recs.shared.ports, { redis: { 6379: base + 2 } }, 'a valid shared assignment is kept');
    assert.deepEqual(recs.job.ports, { postgres: { 5432: base + 4 } }, 'past the active port, both records and its own job port');
    assert.deepEqual(b.takenPorts(s.dir, s.config), new Set([base + 1, base + 2, base + 4]));

    // A later job's job.port skips every backing.json port, active or not.
    const later = createJob(s.dir, s.config, { title: 'Later' }).id;
    setJob(s.dir, x, { fields: { port: base + 3 } });
    await withRunner(f.runner, () => createWorktree(s.dir, s.config, later));
    const laterPort = loadJob(s.dir, later).port!;
    assert.ok(![base, base + 1, base + 2, base + 3, base + 4].includes(laterPort), String(laterPort));
    const laterPg = b.readJobRecord(s.dir, later, s.config).ports.postgres['5432'];
    assert.ok(![base, base + 1, base + 2, base + 3, base + 4, laterPort].includes(laterPg), String(laterPg));

    // Out of range, an unknown service, an unknown port key: ignored on read and allocated again.
    for (const forged of [{ postgres: { 5432: 99999 } }, { ghost: { 5432: base + 50 } }, { postgres: { 1: base + 50 } }, { postgres: { 5432: base + 1 } }]) {
      write(jobRecord(x), forged);
      const p = b.allocateBacking(s.dir, s.config, { id: x, port: base + 3 }).job.ports.postgres['5432'];
      assert.ok(p >= base && p < base + s.config.ports.span && ![base, base + 1, base + 2, base + 3, laterPort, laterPg].includes(p), `${JSON.stringify(forged)} -> ${p}`);
      assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(jobRecord(x), 'utf8')).ports), ['postgres']);
    }
  } finally {
    s.cleanup();
  }
});

test('a backing failure fails worktree setup', async () => {
  const s = scratch([PG], ['touch setup-ran']);
  const f = fake();
  f.state.failRun = true;
  try {
    const id = createJob(s.dir, s.config, { title: 'Broken' }).id;
    const res = await withRunner(f.runner, () => createWorktree(s.dir, s.config, id));
    assert.ok(res.created);
    assert.equal(res.ok, false);
    assert.equal(res.created && res.backing?.length, 1);
    const [entry] = (res.created && res.backing) || [];
    assert.equal(entry.ok, false);
    assert.match(entry.error!, /^docker run failed/);
    assert.equal(entry.action, 'created', 'the action it attempted');
    assert.deepEqual(res.created && res.setup, []);
    assert.ok(!fs.existsSync(path.join(res.path, 'setup-ran')), 'worktrees.setup did not run');
    const failed = readEvents(s.dir, id).filter((e) => e.type === 'worktree-setup-failed');
    assert.deepEqual(
      failed.map((e) => e.backing),
      ['postgres'],
    );
    assert.equal(step(loadStepInput(s.dir, s.config, id)).rule, 'I4');
  } finally {
    s.cleanup();
  }
});

test('a failed bring-up reports the action it attempted', () => {
  const s = scratch([PG, QUEUE]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Attempted' }).id;
    const job = { id, port: 4100 };
    const queue = { name: 'queue', isolation: 'external', action: 'external', ok: true };
    const missing = b.backingUp(s.dir, s.config, job, fake({ missing: true }).runner);
    assert.deepEqual(missing, [{ name: 'postgres', isolation: 'per-job', action: 'none', ok: false, error: 'docker not found on PATH: install Docker to run backing services postgres' }, queue]);
    f.state.daemon = 'down';
    assert.equal(b.backingUp(s.dir, s.config, job, f.runner)[0].action, 'none', 'daemon stopped');
    f.state.daemon = 'up';
    f.state.failRun = true;
    assert.deepEqual(b.backingUp(s.dir, s.config, job, f.runner)[0].action, 'created');
    f.state.failRun = false;
    assert.equal(b.backingUp(s.dir, s.config, job, f.runner)[0].action, 'created');
    f.state.containers[`forge-${id}-postgres`].running = false;
    f.state.failStart = true;
    const [started] = b.backingUp(s.dir, s.config, job, f.runner);
    assert.equal(started.ok, false);
    assert.equal(started.action, 'started');
    assert.match(started.error!, /^docker start failed/);
  } finally {
    s.cleanup();
  }
});

test('no free port for a backing service fails worktree setup instead of throwing', async () => {
  const s = scratch([PG], ['touch setup-ran']);
  const f = fake();
  // One port in the range: the job's own port takes it, leaving none for postgres.
  const config = { ...s.config, ports: { ...s.config.ports, span: 1 } };
  try {
    const id = createJob(s.dir, config, { title: 'Full' }).id;
    const res = await withRunner(f.runner, () => createWorktree(s.dir, config, id));
    assert.ok(res.created);
    assert.equal(res.ok, false);
    assert.equal(res.port, config.ports.base);
    const entries = (res.created && res.backing) || [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0].ok, false);
    assert.equal(entries[0].action, 'none');
    assert.match(entries[0].error!, /^no free port in \d+-\d+ for backing services$/);
    assert.deepEqual(res.created && res.setup, []);
    assert.ok(!fs.existsSync(path.join(res.path, 'setup-ran')), 'worktrees.setup did not run');
    assert.equal(f.runs().length, 0);
    assert.deepEqual(
      readEvents(s.dir, id)
        .filter((e) => e.type === 'worktree-setup-failed')
        .map((e) => e.backing),
      ['postgres'],
    );
    assert.equal(step(loadStepInput(s.dir, config, id)).rule, 'I4');
  } finally {
    s.cleanup();
  }
});

test("backingStop stops only this job's containers", () => {
  const s = scratch([PG, REDIS]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Stop me' }).id;
    b.backingUp(s.dir, s.config, { id, port: 4100 }, f.runner);
    const mine = `forge-${id}-postgres`;
    const shared = `forge-${b.projectSlug(s.dir, s.config)}-redis`;
    const volumesBefore = Object.keys(f.state.volumes);
    const record = path.join(s.dir, '.forge', 'jobs', id, 'backing.json');
    const stopCalls = () => f.calls.filter((c) => c[0] === 'stop');

    assert.deepEqual(b.backingStop(s.dir, s.config, id, f.runner), { stopped: [mine], skipped: [], ok: true });
    assert.deepEqual(stopCalls(), [['stop', '--time', '10', '--', mine]]);
    assert.equal(f.state.containers[mine].running, false);
    assert.equal(f.state.containers[shared].running, true, 'shared container untouched');
    assert.deepEqual(Object.keys(f.state.volumes), volumesBefore, 'volumes kept');
    assert.ok(fs.existsSync(record), 'record kept');
    assert.ok(!f.calls.some((c) => c[0] === 'rm' || (c[0] === 'volume' && c[1] === 'rm')), 'nothing removed');
    assert.deepEqual(b.backingStop(s.dir, s.config, id, f.runner), { stopped: [], skipped: [{ name: mine, reason: 'already stopped' }], ok: true }, 'idempotent');

    // A same-named container of another checkout, or labelled with another job, is never stopped.
    const other = createJob(s.dir, s.config, { title: 'Not mine' }).id;
    const foreign = `forge-${other}-postgres`;
    for (const labels of [
      { 'forge.root': 'someone-else', 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': other },
      { 'forge.root': b.rootLabel(s.dir), 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': id },
    ]) {
      f.state.containers[foreign] = { running: true, labels, image: 'postgres:16', ports: [] };
      assert.deepEqual(b.backingStop(s.dir, s.config, other, f.runner), { stopped: [], skipped: [{ name: foreign, reason: "not this job's" }], ok: true });
      assert.equal(f.state.containers[foreign].running, true);
      assert.ok(!stopCalls().some((c) => c.at(-1) === foreign), `no stop argv for ${foreign}`);
    }

    assert.deepEqual(b.backingStop(s.dir, s.config, `${id}-gone`, f.runner).skipped, [{ name: `forge-${id}-gone-postgres`, reason: 'missing' }]);
    f.state.daemon = 'down';
    const down = b.backingStop(s.dir, s.config, id, f.runner);
    assert.equal(down.ok, false);
    assert.match(down.error!, /daemon is not reachable/);
  } finally {
    s.cleanup();
  }
});

test('status reports container health', () => {
  const s = scratch([PG, REDIS]);
  const f = fake();
  try {
    const id = createJob(s.dir, s.config, { title: 'Health' }).id;
    b.backingUp(s.dir, s.config, { id, port: 4100 }, f.runner);
    const mine = `forge-${id}-postgres`;
    const health = () => b.backingStatus(s.dir, s.config, id, f.runner).services.map((x) => [x.name, x.health]);
    assert.deepEqual(health(), [['postgres', null], ['redis', null]], 'no healthcheck');
    for (const h of ['healthy', 'unhealthy', 'starting']) {
      f.state.containers[mine].health = h;
      assert.deepEqual(health()[0], ['postgres', h]);
    }
    f.state.containers[mine].health = 'none';
    assert.deepEqual(health()[0], ['postgres', null], "Docker's none reads as null");
    // A label value with spaces still parses.
    f.state.containers[mine].health = 'healthy';
    f.state.containers[mine].labels = { ...f.state.containers[mine].labels, note: 'a b  c' };
    assert.deepEqual(health()[0], ['postgres', 'healthy']);
    // Another job's labels: unknown, with no health, even though Docker answered.
    const labels = f.state.containers[mine].labels;
    f.state.containers[mine].labels = { ...labels, 'forge.job': 'someone-else' };
    assert.deepEqual(b.backingStatus(s.dir, s.config, id, f.runner).services.map((x) => [x.state, x.health])[0], ['unknown', null]);
    f.state.containers[mine].labels = labels;
    f.state.containers[mine].running = false;
    assert.deepEqual(health()[0], ['postgres', null], 'not running: null');
  } finally {
    s.cleanup();
  }
});

test('teardown removes only this job\'s containers and never shared ones', async () => {
  const s = scratch([PG, REDIS]);
  const f = fake();
  try {
    const a = createJob(s.dir, s.config, { title: 'Tear A' }).id;
    const other = createJob(s.dir, s.config, { title: 'Tear B' }).id;
    await withRunner(f.runner, () => (createWorktree(s.dir, s.config, a), createWorktree(s.dir, s.config, other)));
    const shared = `forge-${b.projectSlug(s.dir, s.config)}-redis`;
    const record = path.join(s.dir, '.forge', 'jobs', a, 'backing.json');
    // A hand-edited record naming the shared service and another job's never steers teardown.
    fs.writeFileSync(record, JSON.stringify({ v: 1, ports: { postgres: { 5432: 4150 }, redis: { 6379: 4151 }, [`../${other}`]: { 5432: 4152 } } }));
    // A same-named container of another checkout: left alone.
    const ghost = createJob(s.dir, s.config, { title: 'Ghost' }).id;
    f.state.containers[`forge-${ghost}-postgres`] = { running: true, labels: { 'forge.root': 'ffffffffffff', 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': ghost }, image: 'postgres:16', ports: [] };
    f.state.volumes[`forge-${ghost}-postgres-0`] = { labels: { 'forge.root': 'ffffffffffff' } };

    const removed = await withRunner(f.runner, () => removeWorktree(s.dir, a));
    assert.deepEqual(removed.backing, { removed: [`forge-${a}-postgres`], volumes: [`forge-${a}-postgres-0`], ok: true });
    assert.ok(!fs.existsSync(record), 'backing.json deleted');
    assert.ok(f.state.containers[shared] && f.state.containers[`forge-${other}-postgres`], 'shared and other job kept');
    assert.ok(!f.calls.some((c) => c[0] === 'rm' && c.at(-1) !== `forge-${a}-postgres`));

    assert.deepEqual(b.backingDown(s.dir, s.config, ghost, f.runner), { removed: [], volumes: [], ok: true });
    assert.ok(f.state.containers[`forge-${ghost}-postgres`] && f.state.volumes[`forge-${ghost}-postgres-0`], 'foreign container and volume kept');

    // A failure keeps the record so a retry works.
    const otherRecord = path.join(s.dir, '.forge', 'jobs', other, 'backing.json');
    f.state.failRm = true;
    const down = b.backingDown(s.dir, s.config, other, f.runner);
    assert.equal(down.ok, false);
    assert.match(down.error!, /^docker rm failed: /);
    assert.ok(fs.existsSync(otherRecord));
    f.state.daemon = 'down';
    const viaRemove = await withRunner(f.runner, () => removeWorktree(s.dir, other));
    assert.ok(viaRemove.removed, 'the worktree removal itself still happens');
    assert.equal(viaRemove.backing?.ok, false);
    assert.match(viaRemove.backing!.error!, /daemon is not reachable/);
    assert.ok(fs.existsSync(otherRecord));
    f.state.daemon = 'up';
    f.state.failRm = false;
    assert.deepEqual(b.backingDown(s.dir, s.config, other, f.runner), { removed: [`forge-${other}-postgres`], volumes: [`forge-${other}-postgres-0`], ok: true });
    assert.ok(!fs.existsSync(otherRecord));
    assert.ok(f.state.containers[shared], 'shared survives every job teardown');
    assert.deepEqual(b.backingDownShared(s.dir, s.config, f.runner), { removed: [shared] });
    assert.ok(f.state.volumes[`forge-${b.projectSlug(s.dir, s.config)}-redis-0`] === undefined, 'redis had no volumes');
    assert.ok(fs.existsSync(path.join(s.dir, '.forge', 'runtime', 'backing.json')), 'shared ports kept');
  } finally {
    s.cleanup();
  }
});

test('status finds orphans and shows env names only', () => {
  const s = scratch([PG, REDIS, QUEUE]);
  const f = fake();
  try {
    const live = createJob(s.dir, s.config, { title: 'Live' }).id;
    const gone = createJob(s.dir, s.config, { title: 'Gone' }).id;
    b.backingUp(s.dir, s.config, { id: live, port: 4100 }, f.runner);
    b.backingUp(s.dir, s.config, { id: gone, port: 4101 }, f.runner);
    setJob(s.dir, gone, { state: 'cancelled' });
    f.state.containers['forge-nobody-postgres'] = { running: false, labels: { 'forge.root': b.rootLabel(s.dir), 'forge.backing': 'postgres', 'forge.isolation': 'per-job', 'forge.job': 'nobody' }, image: 'postgres:16', ports: [] };
    f.state.containers['forge-elsewhere-postgres'] = { running: true, labels: { 'forge.root': '111111111111', 'forge.job': 'elsewhere' }, image: 'postgres:16', ports: [] };
    const all = b.backingStatus(s.dir, s.config, undefined, f.runner);
    const byName = Object.fromEntries(all.containers.map((c) => [c.name, c]));
    assert.deepEqual(Object.keys(byName).sort(), [`forge-${b.projectSlug(s.dir, s.config)}-redis`, `forge-${gone}-postgres`, `forge-${live}-postgres`, 'forge-nobody-postgres'].sort(), 'only this root');
    assert.equal(byName[`forge-${live}-postgres`].orphan, false);
    assert.equal(byName[`forge-${gone}-postgres`].orphan, true, 'cancelled job');
    assert.deepEqual(byName['forge-nobody-postgres'], { name: 'forge-nobody-postgres', job: 'nobody', backing: 'postgres', isolation: 'per-job', state: 'stopped', orphan: true });
    assert.equal(byName[`forge-${b.projectSlug(s.dir, s.config)}-redis`].orphan, false);

    const one = b.backingStatus(s.dir, s.config, live, f.runner);
    assert.equal(one.docker, 'ok');
    assert.deepEqual(
      one.services.map((x) => [x.name, x.state, x.env]),
      [
        ['postgres', 'running', ['FORGE_BACKING_POSTGRES_HOST', 'FORGE_BACKING_POSTGRES_PORT', 'FORGE_BACKING_POSTGRES_PORT_5432', 'FORGE_BACKING_POSTGRES_URL']],
        ['redis', 'running', ['FORGE_BACKING_REDIS_HOST', 'FORGE_BACKING_REDIS_PORT', 'FORGE_BACKING_REDIS_PORT_6379']],
        ['queue', 'external', ['FORGE_BACKING_QUEUE_URL']],
      ],
    );
    assert.equal(one.services[0].container, `forge-${live}-postgres`);
    assert.equal(one.services[0].host, '127.0.0.1');
    assert.deepEqual(Object.keys(one.services[0].ports), ['5432']);
    assert.ok(!JSON.stringify(one).includes(SECRET) && !JSON.stringify(one).includes('mq.internal'), 'names only, never values');
    f.state.daemon = 'down';
    const down = b.backingStatus(s.dir, s.config, live, f.runner);
    assert.equal(down.docker, 'stopped');
    assert.deepEqual(
      down.services.map((x) => x.state),
      ['unknown', 'unknown', 'external'],
    );
    assert.throws(() => b.backingStatus(s.dir, s.config, undefined, f.runner), (e: any) => e.exitCode === 5 && e.code === 'docker_stopped' && /daemon is not reachable/.test(e.message));
    const missing = fake({ missing: true }).runner;
    assert.equal(b.backingStatus(s.dir, s.config, live, missing).docker, 'missing');
    assert.throws(() => b.backingStatus(s.dir, s.config, undefined, missing), (e: any) => e.exitCode === 5 && e.code === 'docker_missing' && /^docker not found on PATH/.test(e.message));
    assert.equal(b.backingStatus(s.dir, { ...s.config, backing: [QUEUE] } as any, live, missing).docker, null, 'Docker is not asked without a managed entry');
  } finally {
    s.cleanup();
  }
});

test('doctor docker check: missing, stopped, healthy', () => {
  const config = { backing: [PG, REDIS, QUEUE] } as any;
  assert.deepEqual(b.dockerCheck(config, fake({ missing: true }).runner), { name: 'docker', ok: false, detail: 'docker not found on PATH: install Docker to run backing services postgres, redis' });
  const stopped = fake();
  stopped.state.daemon = 'down';
  assert.deepEqual(b.dockerCheck(config, stopped.runner), {
    name: 'docker',
    ok: false,
    detail: 'docker is installed but its daemon is not reachable: start Docker (e.g. Docker Desktop, colima start); needed by backing services postgres, redis',
  });
  assert.deepEqual(stopped.calls, [['version', '--format', '{{.Server.Version}}']]);
  assert.deepEqual(b.dockerCheck(config, fake().runner), { name: 'docker', ok: true, detail: 'Docker 27.1.1; backing: postgres (per-job), redis (shared)' });
  let timeout: number | undefined;
  b.dockerCheck(config, (args, opts) => ((timeout = opts?.timeoutMs), { ok: true, stdout: '1', stderr: '', status: 0 }));
  assert.equal(timeout, 5000, 'doctor waits at most 5 s');
  assert.equal(b.dockerCheck({ backing: [QUEUE] } as any, fake({ missing: true }).runner), null);
});
