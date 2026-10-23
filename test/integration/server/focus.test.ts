// Focus and endpoints in the dashboard API (issue #177): /api/state's focus and per-job endpoints,
// and the three POSTs that focus, start a dev server and open an editor. This file sets PATH and
// FORGE_EDITOR in its own process for the stub editor, so its tests run one at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fakeBin, forgeAsync, forgeSync, repoTemplate, waitFor } from '../../helpers.ts';
import { startServer } from '../../../lib/server/start.ts';
import { FIXTURE_DIST } from '../../dist.ts';
import { editorArgv } from '#engine/workspace/editor.ts';
import { pidAlive } from '#core/os/process.ts';
import { API_VERSION } from '#core/job/schema.ts';
import * as yaml from '#core/format/yaml.ts';

// The stub editor records each call's argv; the latest call is the one a POST spawned.
const editor = fakeBin('stub-editor');
process.env.PATH = `${editor.dir}${path.delimiter}${process.env.PATH}`;
const clearArgv = () => fs.rmSync(editor.log, { force: true });
const recordedArgv = () => editor.calls().at(-1) ?? null;

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  const base = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, ports: { base, span: 10 }, commands: { dev: 'sleep 30' }, worktrees: { root: '../{repo}.wt' } }));
  const r = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (r.status !== 0) throw new Error(r.stderr);
  fs.rmSync(answers);
});

function hit(port: number, o: { path: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

async function scratch() {
  const repo = template();
  const root = repo.dir;
  const f = async (...args: string[]) => {
    const r = await forgeAsync(root, args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const job = async (title: string) => (await f('job', 'new', '--title', title, '--ref', title.toLowerCase().replace(/ /g, '-'))).id as string;
  const jobFile = (id: string) => path.join(root, '.forge', 'jobs', id, 'job.json');
  const patchJob = (id: string, patch: Record<string, unknown>) => fs.writeFileSync(jobFile(id), JSON.stringify({ ...JSON.parse(fs.readFileSync(jobFile(id), 'utf8')), ...patch }));
  const events = (id: string) =>
    fs
      .readFileSync(path.join(root, '.forge', 'jobs', id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const srv = await startServer(root, { port: 0, distDir: FIXTURE_DIST });
  const port = Number(new URL(srv.url).port);
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1];
  const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  const post = (p: string, body: unknown, headers: Record<string, string> = good) => hit(port, { method: 'POST', path: p, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  const state = async () => JSON.parse((await hit(port, { path: '/api/state' })).text);
  const pids: number[] = [];
  // Windows refuses to remove a directory a live process has as its cwd, so the dev server's
  // whole tree is gone before the worktree is removed.
  const cleanup = async () => {
    for (const pid of pids) {
      if (process.platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, 'SIGKILL');
        } catch {}
      }
    }
    await waitFor(() => pids.every((pid) => !pidAlive(pid)), { timeoutMs: 10_000, what: 'the dev server exited' }).catch(() => {});
    await srv.close();
    repo.cleanup();
    // On Windows a Git Bash helper outside the killed tree can keep the worktree as its cwd for a
    // while; a temp dir left behind there is the runner's to discard, not a test failure.
    try {
      fs.rmSync(`${root}.wt`, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      if (process.platform !== 'win32' || (e as NodeJS.ErrnoException).code !== 'EBUSY') throw e;
    }
  };
  return { root, f, job, jobFile, patchJob, events, port, post, state, pids, cleanup, wtRoot: `${root}.wt`, focusFile: path.join(root, '.forge', 'runtime', 'focus.json') };
}

test('state exposes focus and endpoints', { timeout: 60_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const bare = await s.job('No worktree');
    const done = await s.job('Done');
    const badPort = await s.job('Bad port');
    const wtA = await s.f('worktree', 'create', a);
    await s.f('worktree', 'create', done);
    await s.f('worktree', 'create', badPort);
    await s.f('job', 'set', done, '--state', 'done');
    s.patchJob(badPort, { port: 70000, ports: { dev: 70000 } });

    let st = await s.state();
    assert.equal(st.apiVersion, API_VERSION);
    assert.equal(st.focus, null);
    const row = (id: string) => st.jobs.find((j: any) => j.id === id);
    assert.deepEqual(row(a).endpoints, [{ kind: 'component', name: 'dev', url: `http://localhost:${wtA.port}/`, port: wtA.port, live: false }]);
    assert.deepEqual(row(bare).endpoints, [], 'no worktree');
    assert.deepEqual(row(done).endpoints, [], 'not active');
    assert.deepEqual(row(badPort).endpoints, [], 'port out of range');

    await s.f('focus', a);
    st = await s.state();
    assert.deepEqual(st.focus, (await s.f('focus')).focus, '/api/state and forge focus agree');
    assert.equal(st.focus.id, a);

    const started = await s.f('run', a, 'dev', '--background');
    s.pids.push(started.pid);
    st = await s.state();
    assert.equal(row(a).endpoints[0].live, true, 'live once the dev server runs');

    // A planted runtime.json that is a FIFO or names pid 1 never reads as live, and never hangs the poll.
    const rt = path.join(s.root, '.forge', 'jobs', badPort, 'runtime.json');
    s.patchJob(badPort, { port: wtA.port + 5, ports: { dev: wtA.port + 5 } });
    fs.writeFileSync(rt, JSON.stringify({ dev: { pid: 1 } }));
    st = await s.state();
    assert.equal(row(badPort).endpoints[0].live, false, 'pid 1 is not a live dev server');
    fs.rmSync(rt);
    // Windows has no FIFOs to plant.
    if (process.platform !== 'win32') {
      assert.equal(spawnSync('mkfifo', [rt]).status, 0);
      st = await s.state();
      assert.equal(row(badPort).endpoints[0].live, false, 'a FIFO reads as not running');
    }

    // Two components and a per-job backing service: one row each, live only on the row the dev command serves.
    const cfg = path.join(s.root, '.forge', 'config.yml');
    const edit = (fn: (c: any) => void) => {
      const c = yaml.parse(fs.readFileSync(cfg, 'utf8'));
      fn(c);
      fs.writeFileSync(cfg, yaml.stringify(c));
    };
    edit((c) => {
      c.components = [
        { name: 'api', path: '.', kind: 'service' },
        { name: 'web', path: 'web', kind: 'app' },
        { name: 'core', path: 'core', kind: 'library' },
      ];
      c.backing = [{ name: 'postgres', isolation: 'per-job', image: 'postgres:16', ports: [5432] }];
    });
    const pa = wtA.port;
    const pw = wtA.port + 1;
    const pp = wtA.port + 2;
    s.patchJob(a, { port: pa, ports: { api: pa, web: pw } });
    fs.writeFileSync(path.join(s.root, '.forge', 'jobs', a, 'backing.json'), JSON.stringify({ v: 1, ports: { postgres: { 5432: pp } } }));
    st = await s.state();
    assert.deepEqual(row(a).endpoints, [
      { kind: 'component', name: 'api', url: `http://localhost:${pa}/`, port: pa, live: true },
      { kind: 'component', name: 'web', url: `http://localhost:${pw}/`, port: pw, live: null },
      { kind: 'backing', name: 'postgres', url: null, port: pp, live: null },
    ]);
    assert.deepEqual(row(done).endpoints, [], 'not active');
    // A forged ports map (a repeated port) reads as not allocated: `port` still stands for the first entry, and no crafted value reaches the page.
    s.patchJob(a, { port: pa, ports: { api: pa, web: pa } });
    st = await s.state();
    assert.deepEqual(row(a).endpoints.map((e: any) => [e.name, e.port]), [['api', pa], ['postgres', pp]]);
    s.patchJob(a, { port: pa, ports: { api: '4100', web: pw } });
    st = await s.state();
    assert.deepEqual(row(a).endpoints.map((e: any) => [e.name, e.port]), [['api', pa], ['postgres', pp]], 'a string port never becomes a row');
    s.patchJob(a, { port: pa, ports: { api: pa, web: pw } });

    edit((c) => (c.commands.dev = null));
    st = await s.state();
    assert.deepEqual(
      row(a).endpoints.map((e: any) => [e.name, e.live]),
      [
        ['api', null],
        ['web', null],
        ['postgres', null],
      ],
      'no dev command: nothing can be live',
    );
  } finally {
    await s.cleanup();
  }
});

test('POST /api/focus', async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    const done = await s.job('Done');
    await s.f('job', 'set', done, '--state', 'done');
    // One body per branch of the route's checks; the other bad ids are "focus refusals" in test/integration/cli/focus.test.ts.
    const refusals: [number, unknown][] = [
      [400, []],
      [400, '{not json'],
      [400, {}],
      [400, { job: 5 }],
      [400, { job: '../x' }],
      [404, { job: 'no-such-job' }],
      [409, { job: done }],
    ];
    for (const [status, body] of refusals) {
      const r = await s.post('/api/focus', body);
      assert.equal(r.status, status, `${JSON.stringify(body)}: ${r.text}`);
      assert.equal(typeof JSON.parse(r.text).error, 'string');
    }
    assert.equal(fs.existsSync(s.focusFile), false, 'no refusal wrote focus');

    let r = await s.post('/api/focus', { job: a });
    assert.equal(r.status, 200, r.text);
    let body = JSON.parse(r.text);
    assert.equal(body.focus.id, a);
    assert.equal(body.focus.title, 'Alpha');
    assert.equal(body.previous, null);
    r = await s.post('/api/focus', { job: b });
    assert.equal(JSON.parse(r.text).previous, a);
    body = JSON.parse((await s.post('/api/focus', { job: null })).text);
    assert.deepEqual(body, { focus: null, previous: b });
    assert.equal((await s.state()).focus, null);

    // The switched and cleared events are "focus events and audit rows" in test/integration/cli/focus.test.ts.
    const focused = s.events(a).find((e) => e.type === 'focus');
    assert.deepEqual([focused.from, focused.actor?.source], ['dashboard', 'dashboard']);
  } finally {
    await s.cleanup();
  }
});

test('POST /api/focus answers 409 when a checkout step fails', { timeout: 60_000, skip: process.platform === 'win32' && 'POSIX shell command' }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    await s.f('worktree', 'create', a);
    await s.f('worktree', 'create', b);
    const cfg = path.join(s.root, '.forge', 'config.yml');
    const c = yaml.parse(fs.readFileSync(cfg, 'utf8'));
    fs.writeFileSync(cfg, yaml.stringify({ ...c, commands: { ...c.commands, gate: `test "$FORGE_JOB" != ${b}` }, checkout: [{ run: 'gate' }] }));
    let r = await s.post('/api/focus', { job: a });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).checkout.applied[0].ok, true);
    r = await s.post('/api/focus', { job: b });
    assert.equal(r.status, 409, r.text);
    assert.match(JSON.parse(r.text).error, new RegExp(`^checkout\\[0\\] run gate failed \\(exit 1\\); log: logs/checkout-gate-.*\\.log; focus stays on ${a}$`));
    assert.equal((await s.state()).focus.id, a);
  } finally {
    await s.cleanup();
  }
});

test('POST run reuses a live dev server', { timeout: 60_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const bare = await s.job('No worktree');
    const done = await s.job('Done');
    const wt = await s.f('worktree', 'create', a);
    await s.f('worktree', 'create', done);
    await s.f('job', 'set', done, '--state', 'done');
    const runtime = path.join(s.root, '.forge', 'jobs', a, 'runtime.json');

    assert.equal((await s.post(`/api/jobs/${a}/run`, { command: 'test' })).status, 400);
    assert.equal((await s.post(`/api/jobs/${a}/run`, {})).status, 400);
    assert.equal((await s.post(`/api/jobs/${a}/run`, [])).status, 400);
    assert.equal((await s.post('/api/jobs/no-such-job/run', { command: 'dev' })).status, 404);
    assert.equal((await s.post(`/api/jobs/${bare}/run`, { command: 'dev' })).status, 409, 'no worktree');
    assert.equal((await s.post(`/api/jobs/${done}/run`, { command: 'dev' })).status, 409, 'not active');
    assert.equal(fs.existsSync(runtime), false, 'nothing started yet');

    const first = await s.post(`/api/jobs/${a}/run`, { command: 'dev' });
    assert.equal(first.status, 200, first.text);
    const one = JSON.parse(first.text);
    assert.deepEqual(Object.keys(one).sort(), ['listening', 'port', 'reused']);
    assert.equal(one.reused, false);
    assert.equal(one.port, wt.port);
    const pid = JSON.parse(fs.readFileSync(runtime, 'utf8')).dev.pid;
    s.pids.push(pid);
    const second = JSON.parse((await s.post(`/api/jobs/${a}/run`, { command: 'dev' })).text);
    assert.equal(second.reused, true);
    assert.equal(JSON.parse(fs.readFileSync(runtime, 'utf8')).dev.pid, pid, 'the same process');

    // A worktree field pointing elsewhere is refused before anything runs.
    s.patchJob(a, { worktree: os.tmpdir() });
    assert.equal((await s.post(`/api/jobs/${a}/run`, { command: 'dev' })).status, 409);
    // One that only resolves to the job's own worktree is refused too: its raw text would fill {worktree}.
    // The shell's cwd is the worktree, so a relative touch would land there.
    const sneaky = path.join(wt.path, '$(touch pwned-run)');
    fs.mkdirSync(sneaky, { recursive: true });
    fs.mkdirSync(path.join(wt.path, 'x'));
    for (const worktree of [`${wt.path}/x/..`, `${sneaky}/..`, `${wt.path}/.`]) {
      s.patchJob(a, { worktree });
      const res = await s.post(`/api/jobs/${a}/run`, { command: 'dev' });
      assert.equal(res.status, 409, `${worktree}: ${res.text}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const d of [wt.path, s.root]) assert.equal(fs.existsSync(path.join(d, 'pwned-run')), false, 'no shell ran');

    const cfg = path.join(s.root, '.forge', 'config.yml');
    fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace(/^ {2}dev: sleep 30$/m, '  dev: null'));
    s.patchJob(a, { worktree: wt.path });
    const none = await s.post(`/api/jobs/${a}/run`, { command: 'dev' });
    assert.equal(none.status, 409, 'no dev command configured');
    assert.match(JSON.parse(none.text).error, /no "dev" command configured/);
  } finally {
    await s.cleanup();
  }
});

// The stub editor is a #!/bin/sh script, which Windows cannot spawn without a shell.
test('POST editor spawns a fixed argv at the contained worktree only', { timeout: 60_000, skip: process.platform === 'win32' && 'POSIX shell stub editor' }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    const bare = await s.job('No worktree');
    const wtA = await s.f('worktree', 'create', a);
    const wtB = await s.f('worktree', 'create', b);
    const real = fs.realpathSync(wtA.path);
    const pwned = path.join(s.root, 'pwned');

    process.env.FORGE_EDITOR = `stub-editor --wait ; $(touch ${pwned}) 'two words'`;
    assert.deepEqual(editorArgv(process.env), ['stub-editor', '--wait', ';', '$(touch', `${pwned})`, 'two words']);
    clearArgv();
    const r = await s.post(`/api/jobs/${a}/editor`, {});
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(JSON.parse(r.text), { ok: true, editor: 'stub-editor' });
    const argv = await waitFor(recordedArgv, { what: 'the stub editor ran' });
    assert.deepEqual(argv, ['--wait', ';', '$(touch', `${pwned})`, 'two words', real], 'literal words, then the worktree');
    assert.equal(fs.existsSync(pwned), false, 'no shell ran');

    process.env.FORGE_EDITOR = '   ';
    assert.deepEqual(editorArgv(process.env), ['code'], 'blank means code');
    delete process.env.FORGE_EDITOR;
    assert.deepEqual(editorArgv(process.env), ['code'], 'unset means code');

    process.env.FORGE_EDITOR = 'stub-editor';
    assert.equal((await s.post('/api/jobs/no-such-job/editor', {})).status, 404);
    assert.equal((await s.post(`/api/jobs/${a}/editor`, [])).status, 400);
    assert.equal((await s.post(`/api/jobs/${bare}/editor`, {})).status, 409, 'no worktree');
    fs.mkdirSync(path.join(wtA.path, 'x'));
    const sneaky = path.join(wtA.path, '$(touch pwned-editor)');
    fs.mkdirSync(sneaky);
    const link = path.join(s.wtRoot, 'link-out');
    fs.symlinkSync(os.tmpdir(), link);
    const outside: [string, string][] = [
      ["another job's worktree", wtB.path],
      ['/tmp', '/tmp'],
      ['a symlink pointing out', link],
      ['a value starting with -', '-rf'],
      ['a relative path', path.relative(s.root, wtA.path)],
      ['a path that only resolves to its own worktree', `${wtA.path}/x/..`],
      ['a path through a $(…) directory', `${sneaky}/..`],
    ];
    for (const [what, worktree] of outside) {
      clearArgv();
      s.patchJob(a, { worktree });
      const res = await s.post(`/api/jobs/${a}/editor`, {});
      assert.equal(res.status, 409, `${what}: ${res.text}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(recordedArgv(), null, `${what}: nothing spawned`);
    }
    // The job's own directory replaced by a link out is refused too.
    s.patchJob(a, { worktree: wtA.path });
    fs.renameSync(wtA.path, `${wtA.path}.moved`);
    fs.symlinkSync(os.tmpdir(), wtA.path);
    assert.equal((await s.post(`/api/jobs/${a}/editor`, {})).status, 409, '<root>/<id> is a link out');
    assert.equal(recordedArgv(), null);
  } finally {
    delete process.env.FORGE_EDITOR;
    await s.cleanup();
  }
});

test('POST editor answers 409 when the editor is not found', { timeout: 60_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    process.env.FORGE_EDITOR = 'no-such-editor-forge-test';
    const missing = await s.post(`/api/jobs/${a}/editor`, {});
    assert.equal(missing.status, 409);
    assert.equal(JSON.parse(missing.text).error, 'no editor "no-such-editor-forge-test" found: set FORGE_EDITOR to your editor\'s command');
  } finally {
    delete process.env.FORGE_EDITOR;
    await s.cleanup();
  }
});

test('new POSTs hold the token, Origin and JSON guard', { timeout: 60_000 }, async () => {
  const s = await scratch();
  try {
    const a = await s.job('Alpha');
    await s.f('worktree', 'create', a);
    process.env.FORGE_EDITOR = 'stub-editor';
    clearArgv();
    const good = { 'x-forge-token': /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(s.port, { path: '/' })).text)![1], origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' };
    const { 'x-forge-token': _t, ...noToken } = good;
    const { origin: _o, ...noOrigin } = good;
    const cases: [number, Record<string, string>][] = [
      [403, noToken],
      [403, { ...good, 'x-forge-token': 'wrong' }],
      [403, noOrigin],
      [403, { ...good, origin: 'http://evil.example' }],
      [415, { ...good, 'content-type': 'text/plain' }],
    ];
    const routes: [string, unknown][] = [
      ['/api/focus', { job: a }],
      [`/api/jobs/${a}/run`, { command: 'dev' }],
      [`/api/jobs/${a}/editor`, {}],
    ];
    for (const [route, body] of routes) {
      for (const [status, headers] of cases) assert.equal((await s.post(route, body, headers)).status, status, `${route} ${JSON.stringify(headers)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.existsSync(s.focusFile), false, 'no focus write');
    assert.equal(fs.existsSync(path.join(s.root, '.forge', 'jobs', a, 'runtime.json')), false, 'no dev server');
    assert.equal(recordedArgv(), null, 'no editor');
  } finally {
    delete process.env.FORGE_EDITOR;
    await s.cleanup();
  }
});
