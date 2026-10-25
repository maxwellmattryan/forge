// One machine server for every registered project: each project's routes, jobs, pool, event streams
// and ledgers stay its own under /api/p/<project>/, the machine cap holds across projects, the server
// follows the machine index while it runs, and /api/projects summarises it. Every pool gets fake claude
// children (fakeClaude), so nothing real is spawned or signalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fakeClaude, forgeAsync, jobAt, parkedAt, serveProjects, tempRepo, waitFor, type FakeClaudeChild } from '../../helpers.ts';
import type { ClaudeAdapter } from '#integrations/claude/types.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, updateJob } from '#core/job/store.ts';
import { ackRequest, enqueue } from '#core/job/requests.ts';
import { meterFile } from '#engine/metrics/meter.ts';
import { addProject, removeProject, setMachineSettings } from '#engine/project/machine-index.ts';
import { approveTrust, trustApproved } from '#engine/project/trust-approval.ts';
import { startServer } from '../../../lib/server/start.ts';
import type { RunningServer } from '../../../lib/server/types.ts';
import { FIXTURE_DIST } from '../../dist.ts';

const SHARED = new Set(['_inbox', '_office']);

/** Pool options over fakeClaude, recording the order job sessions first spawn and the most alive at once. */
function kit(env?: NodeJS.ProcessEnv) {
  const fake = fakeClaude();
  const k = { children: fake.children, order: [] as string[], maxJobs: 0, opts: {} as Record<string, unknown> };
  const liveJobs = () => fake.children.filter((c) => !c.exited && c.scope && !SHARED.has(c.scope)).length;
  const claude: ClaudeAdapter = {
    start(argv, o, onEvent) {
      const c = fake.adapter.start(argv, o, onEvent) as FakeClaudeChild;
      if (c.scope && !SHARED.has(c.scope)) {
        if (!k.order.includes(c.scope)) k.order.push(c.scope);
        k.maxJobs = Math.max(k.maxJobs, liveJobs());
      }
      return c;
    },
  };
  k.opts = { claude, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50, ...(env ? { env } : {}) };
  return { ...k, liveJobs, alive: (scope: string) => fake.children.filter((c) => c.scope === scope && !c.exited) };
}

/** A scratch repo whose daemon boots with the server, capped at `maxConcurrent` job sessions. */
function daemonRepo(maxConcurrent = 2): ReturnType<typeof tempRepo> {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}', maxConcurrent } }));
  return r;
}

function hit(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', agent: false, headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

const getJson = async (port: number, p: string) => {
  const r = await hit(port, { path: p });
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  return JSON.parse(r.text);
};

/** POST with the page's token, a matching Origin and JSON. */
async function poster(port: number) {
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1]!;
  const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  return (p: string, body: unknown) => hit(port, { method: 'POST', path: p, headers, body: JSON.stringify(body) });
}

type Frame = { event: string; id?: string; data: string };

/** An event stream: the frames so far, and `ended` once the server closes it. */
function stream(port: number, p: string) {
  const s = { frames: [] as Frame[], ended: false, status: 0, close: () => {} };
  const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
    s.status = res.statusCode ?? 0;
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const f: Frame = { event: 'message', data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) f.event = line.slice(7);
          else if (line.startsWith('id: ')) f.id = line.slice(4);
          else if (line.startsWith('data: ')) f.data += line.slice(6);
        }
        if (f.data) s.frames.push(f);
      }
    });
    res.on('end', () => (s.ended = true));
    res.on('close', () => (s.ended = true));
  });
  req.on('error', () => (s.ended = true));
  req.end();
  s.close = () => req.destroy();
  return s;
}

test('one server serves every registered project under /api/p/:project', async () => {
  const a = tempRepo();
  const b = tempRepo();
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }]);
  try {
    const ja = createJob(a.dir, loadConfig(a.dir).config, { title: 'only in a' }).id;
    const jb = createJob(b.dir, loadConfig(b.dir).config, { title: 'only in b' }).id;
    const ids = async (name: string) => (await getJson(s.port, s.api(name, '/state'))).jobs.map((j: { id: string }) => j.id);
    assert.deepEqual(await ids('a'), [ja]);
    assert.deepEqual(await ids('b'), [jb]);
    assert.equal((await hit(s.port, { path: '/api/state' })).status, 404);
    const post = await poster(s.port);
    assert.equal((await post('/api/requests', { type: 'sync' })).status, 404, 'a well-formed POST to a bare path is 404');
    assert.equal((await post(s.api('a', '/requests'), { type: 'sync' })).status, 200);
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('a job id in two projects resolves per project', async () => {
  const a = tempRepo();
  const b = tempRepo();
  const id = createJob(a.dir, loadConfig(a.dir).config, { title: 'shared id' }).id;
  // The same id in b: a copy of a's job dir, then b's own title and request.
  fs.cpSync(path.join(a.dir, '.forge', 'jobs', id), path.join(b.dir, '.forge', 'jobs', id), { recursive: true });
  updateJob(b.dir, id, (j) => void (j.title = 'the b one'));
  fs.writeFileSync(path.join(a.dir, '.forge', 'jobs', id, 'request.md'), 'request of a\n');
  fs.writeFileSync(path.join(b.dir, '.forge', 'jobs', id, 'request.md'), 'request of b\n');
  const onlyB = createJob(b.dir, loadConfig(b.dir).config, { title: 'only in b' }).id;
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }]);
  try {
    assert.equal((await getJson(s.port, s.api('a', `/jobs/${id}`))).job.title, 'shared id');
    assert.equal((await getJson(s.port, s.api('b', `/jobs/${id}`))).job.title, 'the b one');
    assert.equal((await hit(s.port, { path: s.api('a', `/jobs/${id}/file?path=request.md`) })).text, 'request of a\n');
    assert.equal((await hit(s.port, { path: s.api('b', `/jobs/${id}/file?path=request.md`) })).text, 'request of b\n');
    assert.equal((await hit(s.port, { path: s.api('a', `/jobs/${onlyB}`) })).status, 404);
    assert.equal((await hit(s.port, { path: s.api('a', `/jobs/${onlyB}/file?path=request.md`) })).status, 404);
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test("each project's pool runs on its own", async () => {
  const a = daemonRepo();
  const b = daemonRepo();
  // The server's own env names a: every session must still run in its own project.
  const k = kit({ ...process.env, FORGE_ROOT: a.dir });
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }], { daemon: k.opts });
  try {
    const ja = createJob(a.dir, loadConfig(a.dir).config, { title: 'a job' }).id;
    const jb = createJob(b.dir, loadConfig(b.dir).config, { title: 'b job' }).id;
    enqueue(a.dir, null, { type: 'resume', job: ja, from: 'dashboard' });
    enqueue(b.dir, null, { type: 'resume', job: jb, from: 'dashboard' });
    s.entry('a')!.pool.poke();
    s.entry('b')!.pool.poke();
    await waitFor(() => k.alive(ja).length === 1 && k.alive(jb).length === 1, { what: 'a job session in each project' });
    for (const c of k.children) {
      const root = c.cwd === a.dir ? a.dir : b.dir;
      assert.equal(c.cwd, root, `${c.scope}: cwd`);
      assert.equal(c.env.FORGE_ROOT, root, `${c.scope}: FORGE_ROOT`);
    }
    assert.equal(k.alive(jb)[0]!.cwd, b.dir);
    const post = await poster(s.port);
    assert.equal((await post(s.api('b', '/daemon'), { action: 'stop' })).status, 200);
    await waitFor(() => k.children.filter((c) => c.cwd === b.dir).every((c) => c.exited), { what: "b's children to stop" });
    assert.equal(k.alive(ja).length, 1, "a's job child stays alive");
    assert.ok(k.children.filter((c) => c.cwd === a.dir).every((c) => !c.exited), 'no child of a was stopped');
    assert.equal((await getJson(s.port, s.api('a', '/state'))).daemons.jobs[ja].running, true);
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('the machine cap holds across projects', async () => {
  const a = daemonRepo(2);
  const b = daemonRepo(2);
  const k = kit();
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }], { daemon: k.opts });
  try {
    setMachineSettings(s.home, { maxConcurrent: 2 });
    s.refresh();
    const job = (r: ReturnType<typeof tempRepo>, title: string) => createJob(r.dir, loadConfig(r.dir).config, { title }).id;
    const [a1, a2, b1, b2] = [job(a, 'a one'), job(a, 'a two'), job(b, 'b one'), job(b, 'b two')];
    const pa = s.entry('a')!.pool;
    const pb = s.entry('b')!.pool;
    const reqs: Record<string, string> = {};
    const ask = async (r: ReturnType<typeof tempRepo>, id: string) => {
      reqs[id] = enqueue(r.dir, null, { type: 'resume', job: id, from: 'dashboard' }).id;
      // Request ids start with Date.now(): a millisecond apart, so their order is the enqueue order.
      await new Promise((res) => setTimeout(res, 3));
    };
    await ask(a, a1);
    pa.poke();
    await ask(b, b1);
    pb.poke();
    await waitFor(() => k.liveJobs() === 2, { what: 'a1 and b1' });
    // b2 is older than a2, and both wait on the machine cap, not their own.
    await ask(b, b2);
    await ask(a, a2);
    pa.poke();
    pb.poke();
    assert.equal(k.liveJobs(), 2);
    assert.deepEqual(k.order, [a1, b1]);
    const st = (await getJson(s.port, s.api('a', '/state'))).daemons;
    assert.deepEqual(st.machine, { maxConcurrent: 2, live: 2 });

    // Inbox sessions never count: one spawns while the cap is full.
    const inboxes = k.children.filter((c) => c.scope === '_inbox' && c.cwd === a.dir).length;
    await pa.stopSession('_inbox');
    pa.startSession('_inbox');
    await waitFor(() => k.children.filter((c) => c.scope === '_inbox' && c.cwd === a.dir).length === inboxes + 1, { what: 'a fresh inbox' });
    assert.equal(k.liveJobs(), 2);

    const finish = (r: ReturnType<typeof tempRepo>, id: string) => {
      ackRequest(r.dir, reqs[id]!, { status: 'done' });
      k.alive(id)[0]!.exit(0, null);
    };
    // a1 frees a slot in a, but b2's request is older than a2's: b gets it.
    finish(a, a1);
    await waitFor(() => k.order.length === 3, { what: 'the third job session' });
    assert.equal(k.order[2], b2);
    finish(b, b1);
    await waitFor(() => k.order.length === 4, { what: 'the fourth job session' });
    assert.deepEqual(k.order, [a1, b1, b2, a2]);
    assert.ok(k.maxJobs <= 2, `at most 2 job children at once (saw ${k.maxJobs})`);
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('registering and removing a project while the server runs', async () => {
  const a = tempRepo();
  const c = daemonRepo();
  const k = kit();
  const s = await serveProjects([{ dir: a.dir, name: 'a' }], { daemon: k.opts });
  try {
    assert.equal(s.entry('c'), null);
    // As `forge dash` run in c leaves it: approved, then registered.
    approveTrust(s.home, c.dir);
    addProject(s.home, c.dir, { name: 'c' });
    // The timed re-read alone: no request names it.
    await waitFor(() => s.entry('c'), { what: 'c loaded', timeoutMs: 5000 });
    assert.equal((await hit(s.port, { path: s.api('c', '/state') })).status, 200);
    assert.deepEqual((await getJson(s.port, '/api/projects')).projects.map((p: { name: string; loaded: boolean }) => [p.name, p.loaded]), [['a', true], ['c', true]]);

    const jc = createJob(c.dir, loadConfig(c.dir).config, { title: 'in c' }).id;
    enqueue(c.dir, null, { type: 'resume', job: jc, from: 'dashboard' });
    s.entry('c')!.pool.poke();
    await waitFor(() => k.alive(jc).length === 1, { what: "c's job session" });
    const events = stream(s.port, s.api('c', '/events?session=_inbox'));
    await waitFor(() => events.frames.length > 0, { what: "c's stream" });

    removeProject(s.home, 'c');
    await waitFor(() => s.entry('c') === null, { what: 'c closed', timeoutMs: 5000 });
    await waitFor(() => k.children.filter((x) => x.cwd === c.dir).every((x) => x.exited), { what: "c's children to stop" });
    await waitFor(() => events.ended, { what: "c's stream to end" });
    assert.equal((await hit(s.port, { path: s.api('c', '/state') })).status, 404);
    assert.equal((await hit(s.port, { path: s.api('a', '/state') })).status, 200);
  } finally {
    await s.cleanup();
    a.cleanup();
    c.cleanup();
  }
});

test('a restart boots a project only while the files a human approved are unchanged', async () => {
  const a = daemonRepo();
  const b = daemonRepo();
  // a is a repo a human ran `forge dash` in; b was only registered, as `forge project add` leaves it.
  const first = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b', approved: false }], { daemon: kit().opts });
  const started: RunningServer[] = [first];
  let current: RunningServer = first;
  let port = first.port;
  const daemons = async (name: string) => (await getJson(port, first.api(name, '/state'))).daemons;
  /** A restart: the same home, a fresh server. */
  const restart = async () => {
    await current.close();
    current = await startServer({ distDir: FIXTURE_DIST, port: 0, home: first.home, daemon: kit().opts });
    started.push(current);
    port = Number(new URL(current.url).port);
  };
  try {
    assert.equal((await daemons('a')).wanted, true, 'an approved project boots with the server');
    const idle = await daemons('b');
    assert.equal(idle.wanted, false, 'a project no human started stays off');
    assert.match(idle.lastError, /press Start/);

    // Start is a human's approval of the files as they are: b runs now and boots at the next restart.
    const post = await poster(port);
    assert.equal((await post(first.api('b', '/daemon'), { action: 'start' })).status, 200);
    const runningB = await daemons('b');
    assert.deepEqual([runningB.wanted, runningB.lastError], [true, null]);
    assert.equal(trustApproved(first.home, b.dir), true);
    await restart();
    assert.equal((await daemons('b')).wanted, true, 'unchanged files boot again');

    // A session's change to a file Forge trusts (which stopped the daemon) is not approved by a restart.
    fs.appendFileSync(path.join(b.dir, 'CLAUDE.md'), 'a line nobody reviewed\n');
    assert.equal(trustApproved(first.home, b.dir), false);
    await restart();
    assert.equal((await daemons('a')).wanted, true, "a's files did not change");
    const held = await daemons('b');
    assert.equal(held.wanted, false, "b's changed files keep its pool off");
    assert.match(held.lastError, /press Start/);
    assert.equal(current.entry('b')!.pool.state().wanted, false);
  } finally {
    for (const srv of started) await srv.close();
    await first.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('/api/projects and its stream', async () => {
  const a = tempRepo();
  const gone = tempRepo();
  parkedAt(a.dir, 'spec-approval', { title: 'waits on its spec' });
  jobAt(a.dir, 'build', { title: 'building' });
  jobAt(a.dir, 'done', { title: 'finished' });
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: gone.dir, name: 'gone' }], { projectsPollMs: 200 });
  try {
    gone.cleanup();
    const body = await getJson(s.port, '/api/projects');
    assert.equal(body.error, null);
    assert.deepEqual(Object.keys(body.machine).sort(), ['live', 'maxConcurrent', 'source']);
    assert.equal(body.machine.source, 'auto');
    const [pa, pg] = body.projects;
    assert.deepEqual({ ...pa, daemon: Object.keys(pa.daemon).sort() }, {
      name: 'a',
      path: a.dir,
      status: 'not-initialized',
      loaded: true,
      jobs: { active: 2, waiting: 1 },
      daemon: ['enabled', 'foreman', 'live', 'maxConcurrent', 'wanted'],
    });
    assert.deepEqual(pg, { name: 'gone', path: gone.dir, status: 'missing', loaded: false, jobs: null, daemon: null });

    const events = stream(s.port, '/api/projects/events');
    await waitFor(() => events.frames.length === 1, { what: 'the first frame' });
    assert.equal(events.frames[0]!.event, 'projects');
    assert.deepEqual(JSON.parse(events.frames[0]!.data).projects[0].jobs, { active: 2, waiting: 1 });
    jobAt(a.dir, 'build', { title: 'one more' });
    await waitFor(() => events.frames.length === 2, { what: 'a frame after the new job', timeoutMs: 10_000 });
    assert.deepEqual(JSON.parse(events.frames[1]!.data).projects[0].jobs, { active: 3, waiting: 1 });
    events.close();
  } finally {
    await s.cleanup();
    a.cleanup();
  }
});

test("event streams follow one project's session", async () => {
  const a = daemonRepo();
  const b = daemonRepo();
  const k = kit();
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }], { daemon: k.opts });
  try {
    const inbox = (dir: string) => k.children.find((c) => c.scope === '_inbox' && c.cwd === dir && !c.exited)!;
    await waitFor(() => inbox(a.dir) && inbox(b.dir), { what: 'both inboxes' });
    const events = stream(s.port, s.api('a', '/events?session=_inbox'));
    await waitFor(() => events.frames.some((f) => f.event === 'state'), { what: "a's first state" });
    const [ia, ib] = [inbox(a.dir), inbox(b.dir)];
    for (const [c, mark] of [[ia, 'from-a'], [ib, 'from-b']] as const) {
      c.emit({ kind: 'log', stream: 'stdout', line: JSON.stringify({ type: 'system', mark }) });
      c.emit({ kind: 'turn-started' });
    }
    await waitFor(() => events.frames.some((f) => f.event === 'line' && f.data.includes('from-a')), { what: "a's line" });
    // b's frames would have arrived by now: both were emitted before a's line was read.
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(events.frames.every((f) => !f.data.includes('from-b')), 'no line of b');
    const pids = events.frames.filter((f) => f.event === 'state').map((f) => JSON.parse(f.data).pid);
    assert.ok(pids.includes(ia.pid), "a's inbox state");
    assert.ok(!pids.includes(ib.pid), "no state of b's inbox");
    events.close();
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test("metered spend stays in each project's ledger", async () => {
  const a = daemonRepo();
  const b = daemonRepo();
  const k = kit();
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }], { daemon: k.opts });
  try {
    const ja = jobAt(a.dir, 'build', { title: 'costed' }).id;
    enqueue(a.dir, null, { type: 'resume', job: ja, from: 'dashboard' });
    s.entry('a')!.pool.poke();
    await waitFor(() => k.alive(ja).length === 1, { what: "a's job session" });
    const c = k.alive(ja)[0]!;
    c.emit({ kind: 'log', stream: 'stdout', line: '{}' });
    c.emit({ kind: 'turn-started' });
    c.emit({ kind: 'turn-ended', ok: true, cost: { usd: 1.25, models: { 'claude-sonnet-5-5': { usd: 1.25, input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } } } });
    await waitFor(() => fs.existsSync(meterFile(a.dir, ja)), { what: "a's meter record" });
    assert.ok(fs.readFileSync(meterFile(a.dir, ja), 'utf8').includes('1.25'));
    const meterB = path.join(b.dir, '.forge', 'runtime', 'meter');
    assert.deepEqual(fs.existsSync(meterB) ? fs.readdirSync(meterB) : [], [], 'nothing metered under b');
    const statsOf = async (dir: string) => {
      const r = await forgeAsync(dir, ['stats', '--json']);
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).cost.sessions as Record<string, { estCostUsd?: number }>;
    };
    const total = (rows: Record<string, { estCostUsd?: number }>) => Object.values(rows).reduce((n, r) => n + (r.estCostUsd ?? 0), 0);
    assert.ok(total(await statsOf(a.dir)) >= 1.25, "a's stats count it");
    assert.equal(total(await statsOf(b.dir)), 0, "b's stats show none of it");
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});
