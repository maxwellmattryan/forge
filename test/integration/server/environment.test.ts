// The dashboard's environment view (issue #199): GET/POST /api/jobs/:id/environment, its log stream
// and GET /api/environments, against the fake docker. This file points PATH and FAKE_DOCKER_* in its
// own process at each scratch's fake docker state, so its tests run one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { forgeAsync, forgeSync, repoTemplate, waitFor } from '../../helpers.ts';
import { startServer, textFrame } from '../../../lib/server.ts';
import { recordKnown } from '../../../lib/known-secrets.ts';
import { parseMemUsage, parsePercent } from '../../../lib/environment.ts';
import { parseDevProbe, pidAlive } from '../../../lib/worktree.ts';
import * as yaml from '../../../lib/yaml.ts';

const DEV_SERVER = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'dev-server.mjs');
const DOCKER_BIN = path.resolve(import.meta.dirname, '..', '..', 'fixtures', 'docker-bin');
process.env.PATH = `${DOCKER_BIN}${path.delimiter}${process.env.PATH}`;
const BACKING = [
  { name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432] },
  { name: 'redis', isolation: 'shared', image: 'redis:7', ports: [6379] },
  { name: 'queue', isolation: 'external', url: 'amqp://mq.internal:5672' },
];
const posix = process.platform !== 'win32';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  const base = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, ports: { base, span: 10 }, commands: { dev: `node '${DEV_SERVER}' {port}` }, worktrees: { root: '../{repo}.wt' } }));
  const r = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (r.status !== 0) throw new Error(r.stderr);
  fs.rmSync(answers);
  const cfg = path.join(dir, '.forge', 'config.yml');
  fs.writeFileSync(cfg, yaml.stringify({ ...yaml.parse(fs.readFileSync(cfg, 'utf8')), backing: BACKING }));
});

interface Hit {
  status: number;
  text: string;
  ms: number;
}

function hit(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<Hit> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

interface Stream {
  status: number;
  frames: Record<string, string>[];
  lines: () => string[];
  ended: boolean;
  close: () => void;
}

/** An SSE client: each frame's fields, and the JSON-string data of its plain data frames. */
function sse(port: number, p: string, headers: Record<string, string> = {}): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let raw = '';
      const client: Stream = {
        status: res.statusCode!,
        frames: [],
        lines: () => client.frames.filter((f) => f.data !== undefined && !f.event).map((f) => JSON.parse(f.data)),
        ended: false,
        close: () => req.destroy(),
      };
      res.setEncoding('utf8');
      res.on('data', (d) => {
        raw += d;
        let i;
        while ((i = raw.indexOf('\n\n')) !== -1) {
          const block = raw.slice(0, i);
          raw = raw.slice(i + 2);
          const f: Record<string, string> = {};
          for (const l of block.split('\n')) {
            const m = /^([a-z]*): ?(.*)$/.exec(l);
            if (m) f[m[1] || 'comment'] = m[2];
          }
          client.frames.push(f);
        }
      });
      res.on('close', () => (client.ended = true));
      res.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

async function scratch(opts: { sseMaxAgeMs?: number } = {}) {
  const repo = template();
  const root = repo.dir;
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-env-')));
  process.env.FAKE_DOCKER_STATE = path.join(tmp, 'state.json');
  process.env.FAKE_DOCKER_LOG = path.join(tmp, 'argv.log');
  process.env.FAKE_DOCKER_PIDS = path.join(tmp, 'pids');
  const dockerState = () => JSON.parse(fs.readFileSync(process.env.FAKE_DOCKER_STATE!, 'utf8'));
  const setDocker = (patch: Record<string, unknown>) => fs.writeFileSync(process.env.FAKE_DOCKER_STATE!, JSON.stringify({ ...dockerState(), ...patch }));
  const patchContainer = (name: string, patch: Record<string, unknown>) => {
    const st = dockerState();
    setDocker({ containers: { ...st.containers, [name]: { ...st.containers[name], ...patch } } });
  };
  const argv = (): string[][] => (fs.existsSync(process.env.FAKE_DOCKER_LOG!) ? fs.readFileSync(process.env.FAKE_DOCKER_LOG!, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const f = async (...args: string[]) => {
    const r = await forgeAsync(root, args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const job = async (title: string) => (await f('job', 'new', '--title', title, '--ref', title.toLowerCase().replace(/ /g, '-'))).id as string;
  const jobPath = (id: string, ...rest: string[]) => path.join(root, '.forge', 'jobs', id, ...rest);
  const patchJob = (id: string, patch: Record<string, unknown>) => fs.writeFileSync(jobPath(id, 'job.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(jobPath(id, 'job.json'), 'utf8')), ...patch }));
  const runtime = (id: string) => (fs.existsSync(jobPath(id, 'runtime.json')) ? JSON.parse(fs.readFileSync(jobPath(id, 'runtime.json'), 'utf8')) : null);
  const events = (id: string) =>
    fs
      .readFileSync(jobPath(id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const srv = await startServer(root, { port: 0, sseMaxAgeMs: opts.sseMaxAgeMs });
  const port = Number(new URL(srv.url).port);
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1];
  const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  const post = (id: string, body: unknown, headers: Record<string, string> = good) => hit(port, { method: 'POST', path: `/api/jobs/${id}/environment`, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const act = async (id: string, target: string, action: string) => {
    const r = await post(id, { target, action });
    return { ...r, json: JSON.parse(r.text) };
  };
  const get = (p: string, headers: Record<string, string> = { 'x-forge-token': token }) => hit(port, { path: p, headers });
  const env = async (id: string) => {
    const r = await get(`/api/jobs/${id}/environment`);
    assert.equal(r.status, 200, r.text);
    return JSON.parse(r.text);
  };
  const logs = (id: string, source: string, headers: Record<string, string> = {}) => sse(port, `/api/jobs/${id}/environment/logs?source=${encodeURIComponent(source)}&token=${token}`, headers);
  const pids: number[] = [];
  const track = (id: string) => {
    const pid = runtime(id)?.dev?.pid;
    if (typeof pid === 'number') pids.push(pid);
    return pid as number;
  };
  /** A detached (or not) `sleep 30` in `cwd`, killed at cleanup. */
  const sleeper = (cwd: string, detached = true) => {
    const c = spawn('sleep', ['30'], { cwd, detached, stdio: 'ignore' });
    c.unref();
    pids.push(c.pid!);
    return c.pid!;
  };
  const plant = (id: string, rec: Record<string, unknown>) => fs.writeFileSync(jobPath(id, 'runtime.json'), JSON.stringify({ dev: rec }));
  const cleanup = async () => {
    for (const pid of pids) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {}
      }
    }
    await waitFor(() => pids.every((pid) => !pidAlive(pid)), { timeoutMs: 10_000, what: 'spawned processes exited' }).catch(() => {});
    await srv.close();
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      fs.rmSync(`${root}.wt`, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      if (process.platform !== 'win32' || (e as NodeJS.ErrnoException).code !== 'EBUSY') throw e;
    }
  };
  return { root, f, job, jobPath, patchJob, runtime, events, port, token, good, post, act, get, env, logs, pids, track, sleeper, plant, dockerState, setDocker, patchContainer, argv, cleanup };
}

/** A worktree whose dev server serves on its first start (the fixture crashes only once per directory). */
async function readyWorktree(s: Awaited<ReturnType<typeof scratch>>, id: string) {
  const wt = await s.f('worktree', 'create', id);
  fs.writeFileSync(path.join(wt.path, '.dev-crashed-once'), '');
  return wt as { path: string; port: number };
}

const DEAD_PID = () => spawnSync(process.execPath, ['-e', '0']).pid;

/**
 * A `sleep 30` in `cwd` that leads its own group and session with a pty as its controlling terminal, as
 * a terminal's shell does: `script` starts it. Null where `script` is missing or behaves otherwise.
 */
async function terminalProcess(cwd: string, pids: number[]): Promise<number | null> {
  const argv = process.platform === 'darwin' ? ['-q', '/dev/null', 'sleep', '30'] : ['-qfec', 'sleep 30', '/dev/null'];
  const parent = spawn('script', argv, { cwd, detached: true, stdio: 'ignore' });
  parent.on('error', () => {});
  parent.unref();
  if (!parent.pid) return null;
  pids.push(parent.pid);
  const child = await waitFor(
    () => {
      const r = spawnSync('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'tty='], { encoding: 'utf8' });
      for (const line of r.stdout.split('\n')) {
        const [pid, ppid, pgid, tty] = line.trim().split(/\s+/);
        if (Number(ppid) === parent.pid && pid === pgid && tty && !/^\?+$/.test(tty)) return Number(pid);
      }
      return 0;
    },
    { timeoutMs: 5_000, what: 'the terminal process' },
  ).catch(() => 0);
  if (!child) return null;
  pids.push(child);
  return child;
}

test('a crashed dev server reads down with its last lines and restarts', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const wt = await s.f('worktree', 'create', a);
    const start = await s.act(a, 'dev', 'start');
    assert.equal(start.status, 200, start.text);
    assert.equal(start.json.ok, true);
    s.track(a);
    const down = await waitFor(async () => {
      const e = await s.env(a);
      return e.dev.state === 'down' ? e : null;
    }, { what: 'the dev server reads down', timeoutMs: 15_000 });
    assert.equal(down.dev.pid, null);
    assert.ok(down.dev.tail.includes('boom'), JSON.stringify(down.dev.tail));
    assert.deepEqual(down.dev.tail.slice(-2), ['starting', 'boom'], 'oldest first');

    const restart = await s.act(a, 'dev', 'restart');
    assert.equal(restart.status, 200, restart.text);
    s.track(a);
    const up = await waitFor(async () => {
      const e = await s.env(a);
      return e.dev.state === 'running' ? e : null;
    }, { what: 'the restarted dev server answers', timeoutMs: 15_000 });
    assert.equal(up.dev.listening, true);
    assert.equal(up.dev.port, wt.port);
    assert.deepEqual(up.dev.tail, [], 'no tail while running');
  } finally {
    await s.cleanup();
  }
});

test('dev states', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    const wt = await s.f('worktree', 'create', a);
    await s.f('worktree', 'create', b);
    const e = await s.env(a);
    assert.deepEqual(Object.keys(e), ['job', 'active', 'worktree', 'dev', 'backing', 'backingError', 'docker', 'at']);
    assert.equal(e.docker, null, 'Docker is not asked while every service reads a state');
    assert.deepEqual(e.dev, { state: 'stopped', pid: null, port: wt.port, listening: null, startedAt: null, tail: [] });
    assert.equal(e.active, true);
    assert.equal(e.worktree, true);

    // A live pid whose port does not answer is starting.
    const pid = s.sleeper(wt.path);
    const startedAt = new Date().toISOString();
    s.plant(b, { pid, startedAt });
    const starting = (await s.env(b)).dev;
    assert.deepEqual(starting, { state: 'starting', pid, port: starting.port, listening: false, startedAt, tail: [] });

    // Backing part (AC13): every entry with its state and health.
    assert.equal(e.backingError, null);
    const pg = `forge-${a}-postgres`;
    assert.deepEqual(
      e.backing.map((x: any) => [x.name, x.isolation, x.managed, x.state, x.health]),
      [
        ['postgres', 'per-job', true, 'running', null],
        ['redis', 'shared', true, 'running', null],
        ['queue', 'external', false, 'external', null],
      ],
    );
    assert.equal(e.backing[0].container, pg);
    assert.deepEqual(Object.keys(e.backing[0].ports), ['5432']);
    // Health and a foreign-labelled container are backingStatus's, in-process: backing.test.ts › "status reports container health".

    // Docker stopped: managed rows read unknown, and the server says why.
    s.setDocker({ daemon: 'down' });
    await new Promise((r) => setTimeout(r, 2100));
    const off = await s.env(a);
    assert.deepEqual(off.backing.map((x: any) => x.state), ['unknown', 'unknown', 'external']);
    assert.equal(off.docker, 'stopped');

    // No dev command: dev is null.
    const cfg = path.join(s.root, '.forge', 'config.yml');
    fs.writeFileSync(cfg, yaml.stringify({ ...yaml.parse(fs.readFileSync(cfg, 'utf8')), commands: { dev: null }, backing: [] }));
    const c = await s.job('Gamma');
    const none = await s.env(c);
    assert.equal(none.dev, null);
    assert.deepEqual(none.backing, []);
    assert.equal(none.worktree, false);

    assert.equal((await s.get('/api/jobs/no-such-job/environment')).status, 404);
    assert.equal((await s.get('/api/jobs/..%2Fx/environment')).status, 404);
  } finally {
    await s.cleanup();
  }
});

test('stop ends the job\'s own dev server', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await readyWorktree(s, a);
    assert.equal((await s.act(a, 'dev', 'start')).status, 200);
    const pid = s.track(a);
    await waitFor(async () => (await s.env(a)).dev.state === 'running', { what: 'running', timeoutMs: 15_000 });
    const rt = s.runtime(a);
    fs.writeFileSync(s.jobPath(a, 'runtime.json'), JSON.stringify({ ...rt, other: { pid: 0, note: 'kept' } }));

    const stop = await s.act(a, 'dev', 'stop');
    assert.equal(stop.status, 200, stop.text);
    assert.equal(stop.json.ok, true);
    assert.equal(stop.json.environment.dev.state, 'stopped');
    assert.equal(pidAlive(pid), false, 'the process group is gone');
    assert.deepEqual(s.runtime(a), { other: { pid: 0, note: 'kept' } }, 'only the dev key left');
    const ev = s.events(a).filter((x) => x.type === 'background-stop');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].names, ['dev']);
    assert.equal(ev[0].actor.source, 'dashboard');

    // Nothing recorded: stop is a no-op, not an error.
    const again = await s.act(a, 'dev', 'stop');
    assert.equal(again.status, 200);
  } finally {
    await s.cleanup();
  }
});

test('stop refuses a pid it cannot prove', { timeout: 90_000, skip: !posix && 'POSIX process probes' }, async (t) => {
  // The ps row: no controlling terminal reads `??` on macOS and `?` on Linux.
  const at = 'Tue Oct 20 18:18:47 2026';
  assert.deepEqual(parseDevProbe(` 4242 ??       ${at}\n`), { pgid: 4242, tty: false, started: Date.parse(at) });
  assert.equal(parseDevProbe(`4242 ? ${at}`)?.tty, false);
  assert.equal(parseDevProbe(`4242 ttys002 ${at}`)?.tty, true);
  assert.equal(parseDevProbe(`4242 pts/3 ${at}`)?.tty, true);
  for (const bad of ['', '4242', `x ?? ${at}`, `4242 ?? not a date`, `4242 ?? ${at} extra`, `${'9'.repeat(10_000)} ?? ${'a'.repeat(10_000)}`]) assert.equal(parseDevProbe(bad), null, bad.slice(0, 40));

  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const wt = await readyWorktree(s, a);
    const now = () => new Date().toISOString();
    const cases: [string, () => Record<string, unknown>, number | null][] = [];
    // A group leader in the worktree that keeps a terminal: a shell the human opened there, or what it runs.
    const term = await terminalProcess(wt.path, s.pids);
    if (term) cases.push(['a process with a controlling terminal', () => ({ pid: term, startedAt: now() }), term]);
    else t.diagnostic('no `script` pty here: the terminal case is not run');
    const outside = s.sleeper(os.tmpdir());
    cases.push(['cwd outside the worktree', () => ({ pid: outside, startedAt: now() }), outside]);
    const notLeader = s.sleeper(wt.path, false);
    cases.push(['not its own group leader', () => ({ pid: notLeader, startedAt: now() }), notLeader]);
    cases.push(['pid 1', () => ({ pid: 1, startedAt: now() }), null]);
    cases.push(["the server's own pid", () => ({ pid: process.pid, startedAt: now() }), null]);
    const stale = s.sleeper(wt.path);
    cases.push(['startedAt 2 minutes off', () => ({ pid: stale, startedAt: new Date(Date.now() - 120_000).toISOString() }), stale]);
    for (const [what, rec, pid] of cases) {
      for (const action of ['stop', 'restart']) {
        s.plant(a, rec());
        const r = await s.act(a, 'dev', action);
        assert.equal(r.status, 409, `${what} ${action}: ${r.text}`);
        assert.match(r.json.error, /cannot prove pid \d+ is this job's dev server; stop it with forge stop/);
        if (pid !== null) assert.equal(pidAlive(pid), true, `${what}: still alive`);
        assert.ok(s.runtime(a).dev, `${what}: the record stays`);
      }
    }
    // The proof is not refusing everything: a detached process in the worktree, started now, is stopped.
    const mine = s.sleeper(wt.path);
    s.plant(a, { pid: mine, startedAt: now() });
    const ok = await s.act(a, 'dev', 'stop');
    assert.equal(ok.status, 200, ok.text);
    await waitFor(() => !pidAlive(mine), { what: 'the proven process exited' });
  } finally {
    await s.cleanup();
  }
});

test('lifecycle actions need the job\'s own contained worktree', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    const done = await s.job('Done');
    const cancelled = await s.job('Cancelled');
    const bare = await s.job('Bare');
    const wtA = await readyWorktree(s, a);
    const wtB = await readyWorktree(s, b);
    await readyWorktree(s, done);
    await readyWorktree(s, cancelled);
    await s.f('job', 'set', done, '--state', 'done');
    await s.f('job', 'set', cancelled, '--state', 'cancelled');

    for (const worktree of [os.tmpdir(), wtB.path, `${wtA.path}/.`]) {
      s.patchJob(a, { worktree });
      for (const action of ['start', 'restart', 'stop']) {
        const r = await s.act(a, 'dev', action);
        assert.equal(r.status, 409, `${worktree} ${action}: ${r.text}`);
      }
      assert.equal(s.runtime(a), null, `${worktree}: nothing spawned`);
    }
    // A live recorded pid is not signalled through a forged worktree either.
    const pid = s.sleeper(wtA.path);
    s.plant(a, { pid, startedAt: new Date().toISOString() });
    s.patchJob(a, { worktree: wtB.path });
    assert.equal((await s.act(a, 'dev', 'stop')).status, 409);
    assert.equal(pidAlive(pid), true);
    assert.equal(s.runtime(b), null, "the other job's worktree got nothing");

    for (const id of [done, cancelled])
      for (const action of ['start', 'restart']) {
        const r = await s.act(id, 'dev', action);
        assert.equal(r.status, 409, `${id} ${action}`);
        assert.match(r.json.error, /only an active job/);
        assert.equal(s.runtime(id), null);
      }
    assert.equal((await s.act(bare, 'dev', 'start')).status, 409, 'no worktree');

    // Bad bodies and ids.
    for (const body of [{}, [], { target: 'dev' }, { target: 'dev', action: 'kill' }, { target: 'x', action: 'start' }, { target: 'dev', action: 'start', extra: 1 }, '{nope']) assert.equal((await s.post(a, body)).status, 400, JSON.stringify(body));
    assert.equal((await s.post('no-such-job', { target: 'dev', action: 'start' })).status, 404);
  } finally {
    await s.cleanup();
  }
});

test('dev log reads are confined and no-follow', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    const logs = s.jobPath(a, 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const secret = path.join(s.root, 'secret.txt');
    fs.writeFileSync(secret, 'top secret\n');
    fs.writeFileSync(path.join(logs, 'dev.log'), 'real line\n');
    // The `log` field is never followed.
    s.plant(a, { pid: DEAD_PID(), startedAt: new Date().toISOString(), log: secret });
    assert.deepEqual((await s.env(a)).dev.tail, ['real line']);

    // The route opens through openDevLog: a symlinked dev.log is not served. Every other plant (a
    // symlinked logs dir, a FIFO) is environment.test.ts › "dev logs open confined and no-follow".
    fs.rmSync(path.join(logs, 'dev.log'));
    fs.symlinkSync(secret, path.join(logs, 'dev.log'));
    const st = await s.logs(a, 'dev');
    assert.equal(st.status, 404);
    st.close();
  } finally {
    await s.cleanup();
  }
});

test('guards', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    fs.mkdirSync(s.jobPath(a, 'logs'), { recursive: true });
    fs.writeFileSync(s.jobPath(a, 'logs', 'dev.log'), 'x\n');
    const { 'x-forge-token': _t, ...noToken } = s.good;
    const posts: [number, Record<string, string>][] = [
      [403, noToken],
      [403, { ...s.good, 'x-forge-token': 'wrong' }],
      [403, { ...s.good, origin: 'http://evil.example' }],
      [415, { ...s.good, 'content-type': 'text/plain' }],
    ];
    for (const [status, headers] of posts) assert.equal((await s.post(a, { target: 'dev', action: 'start' }, headers)).status, status, JSON.stringify(headers));
    assert.equal(s.runtime(a), null, 'nothing started');

    const tok = { 'x-forge-token': s.token };
    const gets: [string, Record<string, string>][] = [
      ['no token', {}],
      ['wrong token', { 'x-forge-token': 'f'.repeat(s.token.length) }],
      ['foreign origin', { ...tok, origin: 'http://evil.example' }],
      ['cross-site', { ...tok, 'sec-fetch-site': 'cross-site' }],
    ];
    for (const route of [`/api/jobs/${a}/environment`, '/api/environments'])
      for (const [what, headers] of gets) assert.equal((await s.get(route, headers)).status, 403, `${route} ${what}`);

    const stream = (q: string, headers: Record<string, string> = {}) => sse(s.port, `/api/jobs/${a}/environment/logs?source=dev${q}`, headers);
    const right = '&token=' + s.token;
    const foreignOrigin = { origin: 'http://evil.example' };
    for (const [what, q, headers] of [
      ['no token', '', {}],
      ['wrong token', '&token=' + '0'.repeat(s.token.length), {}],
      ['short token', '&token=ab', {}],
      ['header only', '', tok],
      ['foreign origin', right, foreignOrigin],
      ['cross-site', right, { 'sec-fetch-site': 'cross-site' }],
    ] as [string, string, Record<string, string>][]) {
      const st = await stream(q, headers);
      assert.equal(st.status, 403, what);
      st.close();
    }
    const ok = await stream(right);
    assert.equal(ok.status, 200);
    ok.close();
  } finally {
    await s.cleanup();
  }
});

test('log source is validated before docker runs', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    for (const source of ['backing:../x', 'backing:-f', 'backing:nope', 'backing:queue', 'nope', '', 'backing:']) {
      const st = await s.logs(a, source);
      assert.equal(st.status, 400, source);
      st.close();
    }
    s.patchContainer(`forge-${a}-postgres`, { labels: { ...s.dockerState().containers[`forge-${a}-postgres`].labels, 'forge.job': 'someone-else' } });
    const foreign = await s.logs(a, 'backing:postgres');
    assert.equal(foreign.status, 409);
    foreign.close();
    assert.equal(s.argv().filter((x) => x[0] === 'logs').length, 0, 'docker logs never ran');
  } finally {
    await s.cleanup();
  }
});

test('log streams', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    // textFrame keeps hostile text inside one frame as a JSON string.
    for (const line of ['a\rb', '<script>alert(1)</script>', 'x\n\ndata: forged', 'id: 9']) {
      const frame = textFrame(3, line);
      assert.equal(frame.split('\n\n').length, 2, 'one frame');
      assert.equal(JSON.parse(/^id: 3\ndata: (.*)\n\n$/.exec(frame)![1]), line);
    }
    assert.equal(JSON.parse(textFrame(null, 'y'.repeat(20000)).slice(6)).length, 16385, 'capped with an ellipsis');

    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    fs.mkdirSync(s.jobPath(a, 'logs'), { recursive: true });
    const log = s.jobPath(a, 'logs', 'dev.log');
    fs.writeFileSync(log, 'first\r\n<script>alert(1)</script>\ndata: forged\n');
    const dev = await s.logs(a, 'dev');
    assert.equal(dev.status, 200);
    await waitFor(() => dev.lines().length >= 3, { what: 'existing lines' });
    assert.deepEqual(dev.lines(), ['first\r', '<script>alert(1)</script>', 'data: forged']);
    fs.appendFileSync(log, 'appended\n');
    await waitFor(() => dev.lines().includes('appended'), { what: 'appended line' });
    assert.ok(dev.frames.every((f) => f.data === undefined || typeof JSON.parse(f.data) === 'string' || f.event), 'every data is a JSON string');
    dev.close();

    const c = `forge-${a}-postgres`;
    s.patchContainer(c, { logs: ['ready <b>now</b>', 'data: forged'], errLogs: ['warn on stderr'] });
    const box = await s.logs(a, 'backing:postgres');
    assert.equal(box.status, 200);
    await waitFor(() => box.lines().length >= 3, { what: 'container lines' });
    assert.deepEqual(box.lines().sort(), ['data: forged', 'ready <b>now</b>', 'warn on stderr']);
    assert.ok(s.argv().some((x) => x.join(' ') === `logs --follow --tail 200 -- ${c}`), JSON.stringify(s.argv()));
    s.patchContainer(c, { running: false });
    await waitFor(() => box.ended, { what: 'the stream ends with docker' });
    assert.ok(box.frames.some((f) => f.event === 'end'), 'event: end');

    // A client that leaves takes the docker child with it.
    s.patchContainer(c, { running: true });
    const pidsFile = process.env.FAKE_DOCKER_PIDS!;
    fs.rmSync(pidsFile, { force: true });
    const second = await s.logs(a, 'backing:postgres');
    assert.equal(second.status, 200);
    const pid = await waitFor(() => (fs.existsSync(pidsFile) ? Number(fs.readFileSync(pidsFile, 'utf8').trim()) : 0), { what: 'docker logs started' });
    second.close();
    await waitFor(() => !pidAlive(pid), { what: 'docker logs killed' });
  } finally {
    await s.cleanup();
  }
});

test('log streams redact known values', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    const secret = 'hunter2-very-secret-value';
    recordKnown(s.root, a, { DB_PASSWORD: secret });
    fs.mkdirSync(s.jobPath(a, 'logs'), { recursive: true });
    fs.writeFileSync(s.jobPath(a, 'logs', 'dev.log'), `listening with ${secret}\nplain line\n`);
    const dev = await s.logs(a, 'dev');
    assert.equal(dev.status, 200);
    await waitFor(() => dev.lines().length >= 2, { what: 'dev lines' });
    assert.ok(dev.lines().every((l) => !l.includes(secret)), JSON.stringify(dev.lines()));
    assert.ok(dev.lines().includes('plain line'));
    dev.close();

    s.patchContainer(`forge-${a}-postgres`, { logs: [`postgres://u:${secret}@db/x`], errLogs: [`bad password ${secret}`] });
    const box = await s.logs(a, 'backing:postgres');
    assert.equal(box.status, 200);
    await waitFor(() => box.lines().length >= 2, { what: 'container lines' });
    assert.ok(box.lines().every((l) => !l.includes(secret)), JSON.stringify(box.lines()));
    box.close();
  } finally {
    await s.cleanup();
  }
});

test('log streams share the event-stream cap', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    fs.mkdirSync(s.jobPath(a, 'logs'), { recursive: true });
    fs.writeFileSync(s.jobPath(a, 'logs', 'dev.log'), 'x\n');
    const open: Stream[] = [];
    for (let i = 0; i < 8; i++) {
      const st = await s.logs(a, 'dev');
      assert.equal(st.status, 200, `stream ${i + 1}`);
      open.push(st);
    }
    const ninth = await s.logs(a, 'dev');
    assert.equal(ninth.status, 503);
    ninth.close();
    for (const st of open) st.close();
  } finally {
    await s.cleanup();
  }
});

test('a container log stream left during its status check holds no slot and starts no docker', { timeout: 90_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    fs.mkdirSync(s.jobPath(a, 'logs'), { recursive: true });
    fs.writeFileSync(s.jobPath(a, 'logs', 'dev.log'), 'x\n');
    s.setDocker({ versionDelayMs: 1500 });
    fs.writeFileSync(process.env.FAKE_DOCKER_LOG!, '');
    // Eight clients that leave while `backing status` is still asking Docker: enough to fill the cap if each leaked.
    for (let i = 0; i < 8; i++) {
      const query = new URLSearchParams({ source: 'backing:postgres', token: s.token });
      const req = http.request({ host: '127.0.0.1', port: s.port, path: `/api/jobs/${a}/environment/logs?${query}`, headers: { host: `127.0.0.1:${s.port}` } });
      req.on('error', () => {});
      req.end();
      await waitFor(() => s.argv().filter((x) => x[0] === 'version').length > i, { what: `status check ${i + 1} started` });
      req.destroy();
    }
    // Each check inspects the two managed containers once Docker answers.
    await waitFor(() => s.argv().filter((x) => x[0] === 'inspect').length >= 16, { what: 'every status check finished', timeoutMs: 30_000 });
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(s.argv().filter((x) => x[0] === 'logs').length, 0, 'docker logs never ran');
    s.setDocker({ versionDelayMs: 0 });
    const open: Stream[] = [];
    for (let i = 0; i < 8; i++) {
      const st = await s.logs(a, 'dev');
      assert.equal(st.status, 200, `stream ${i + 1}: no slot was kept`);
      open.push(st);
    }
    for (const st of open) st.close();
  } finally {
    await s.cleanup();
  }
});

test('a recycled container log stream ends instead of replaying', { timeout: 90_000 }, async () => {
  const s = await scratch({ sseMaxAgeMs: 2500 });
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    s.patchContainer(`forge-${a}-postgres`, { logs: ['one', 'two'] });
    const box = await s.logs(a, 'backing:postgres');
    assert.equal(box.status, 200);
    await waitFor(() => box.lines().length >= 2, { what: 'container lines' });
    await waitFor(() => box.ended, { what: 'the recycled stream ends', timeoutMs: 10_000 });
    assert.ok(box.frames.some((f) => f.event === 'end'), 'event: end, so EventSource does not reconnect and replay');
  } finally {
    await s.cleanup();
  }
});

test('backing actions run the CLI without blocking the server', { timeout: 120_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    const pg = `forge-${a}-postgres`;
    const stop = await s.act(a, 'backing', 'stop');
    assert.equal(stop.status, 200, stop.text);
    assert.equal(stop.json.ok, true);
    assert.equal(s.dockerState().containers[pg].running, false);
    assert.equal(stop.json.environment.backing[0].state, 'stopped');
    assert.ok(s.argv().some((x) => x.join(' ') === `stop --time 10 -- ${pg}`));
    assert.equal(s.dockerState().containers[Object.keys(s.dockerState().containers).find((n) => n.endsWith('-redis'))!].running, true, 'shared untouched');
    // The environment record follows the card, so environments.maxRunning counts what it started.
    const recordState = () => JSON.parse(fs.readFileSync(path.join(s.root, '.forge', 'runtime', 'environments.json'), 'utf8')).jobs[a]?.state;
    assert.equal(recordState(), 'stopped', 'Stop marks the record stopped');

    // A slow docker start: the server keeps answering while the CLI child waits.
    s.setDocker({ delayMs: 2500 });
    let settled = false;
    const pending = s.act(a, 'backing', 'start').then((r) => ((settled = true), r));
    await new Promise((r) => setTimeout(r, 600));
    const other = await s.get('/api/about');
    assert.equal(other.status, 200);
    assert.ok(other.ms < 1000, `answered in ${other.ms} ms`);
    assert.equal(settled, false, 'the start was still running');
    const start = await pending;
    assert.equal(start.status, 200, start.text);
    assert.equal(start.json.ok, true);
    assert.equal(start.json.environment.backing[0].state, 'running');
    assert.equal(recordState(), 'running', 'Start is an ensure up');
    const ups = fs.readFileSync(path.join(s.root, '.forge', 'jobs', a, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'environment-up');
    assert.equal(ups.at(-1).trigger, 'cli');
    s.setDocker({ delayMs: 0 });

    fs.writeFileSync(process.env.FAKE_DOCKER_LOG!, '');
    const restart = await s.act(a, 'backing', 'restart');
    assert.equal(restart.status, 200, restart.text);
    const calls = s.argv().map((x) => x[0]);
    const stopAt = calls.indexOf('stop');
    const startAt = calls.findIndex((x) => x === 'start' || x === 'run');
    assert.ok(stopAt !== -1 && startAt > stopAt, `stop before start: ${calls.join(',')}`);
    assert.equal(restart.json.environment.backing[0].state, 'running');
    assert.equal(recordState(), 'running', 'Restart ends running');

    // A Docker failure is ok: false with the reason.
    s.setDocker({ daemon: 'down' });
    const failed = await s.act(a, 'backing', 'start');
    assert.equal(failed.status, 200);
    assert.equal(failed.json.ok, false);
    assert.match(failed.json.detail, /daemon/);

    // No managed entry: refused.
    const cfg = path.join(s.root, '.forge', 'config.yml');
    fs.writeFileSync(cfg, yaml.stringify({ ...yaml.parse(fs.readFileSync(cfg, 'utf8')), backing: [BACKING[2]] }));
    assert.equal((await s.act(a, 'backing', 'start')).status, 409);
  } finally {
    await s.cleanup();
  }
});

test('project-wide environments', { timeout: 120_000 }, async () => {
  assert.equal(parsePercent('1.50%'), 1.5);
  assert.equal(parsePercent(' 0% '), 0);
  assert.equal(parsePercent('--'), null);
  assert.equal(parsePercent(5), null);
  assert.equal(parseMemUsage('12.5MiB / 7.6GiB'), Math.round(12.5 * 1024 * 1024));
  assert.equal(parseMemUsage('512B / 1GiB'), 512);
  assert.equal(parseMemUsage('1.2kB / 2GB'), 1200);
  assert.equal(parseMemUsage('2GiB'), 2 * 1024 ** 3);
  assert.equal(parseMemUsage('lots / 1GiB'), null);
  assert.equal(parseMemUsage(null), null);

  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    const idle = await s.job('Idle');
    await readyWorktree(s, a);
    await s.f('worktree', 'create', b);
    assert.equal((await s.act(a, 'dev', 'start')).status, 200);
    const pid = s.track(a);
    await s.f('backing', 'stop', b);
    fs.writeFileSync(process.env.FAKE_DOCKER_LOG!, '');

    const r = await s.get('/api/environments');
    assert.equal(r.status, 200, r.text);
    const envs = JSON.parse(r.text);
    assert.equal(envs.docker, 'ok');
    assert.deepEqual(envs.rows.map((x: any) => x.job), [a, null], `only live environments: ${idle} and ${b} are not listed`);
    const [rowA, shared] = envs.rows;
    assert.equal(rowA.title, 'Alpha');
    assert.equal(rowA.dev.pid, pid);
    assert.deepEqual(rowA.containers, [{ name: `forge-${a}-postgres`, backing: 'postgres', cpu: 1.5, memBytes: Math.round(12.5 * 1024 * 1024) }]);
    if (posix) assert.equal(typeof rowA.dev.memBytes, 'number');
    assert.equal(shared.title, 'Shared services');
    assert.deepEqual(shared.containers.map((c: any) => c.backing), ['redis']);
    const stats = s.argv().filter((x) => x[0] === 'stats');
    assert.equal(stats.length, 1, 'one docker stats');
    assert.deepEqual(stats[0].slice(stats[0].indexOf('--') + 1).sort(), [`forge-${a}-postgres`, shared.containers[0].name].sort());

    const before = s.argv().length;
    assert.equal((await s.get('/api/environments')).status, 200);
    assert.equal(s.argv().length, before, 'a second call within 5 s spawns nothing');

    s.setDocker({ daemon: 'down' });
    await new Promise((r) => setTimeout(r, 5100));
    const off = JSON.parse((await s.get('/api/environments')).text);
    assert.equal(off.docker, 'stopped');
    assert.deepEqual(off.rows.map((x: any) => x.job), [a], 'dev rows still listed');
    assert.deepEqual(off.rows[0].containers, []);
  } finally {
    await s.cleanup();
  }
});
