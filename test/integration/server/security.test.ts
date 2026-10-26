// The dashboard server's request guards: it answers loopback Hosts only, its POSTs need the token,
// a matching Origin and a JSON body (docs/architecture/dashboard-security.md), and a resume bounces
// off a live lease only when that lease is not the job's own pool session's; the job budget route lifts
// a budget only for a well-formed body, as the dashboard. The machine routes keep the read guard, a
// project segment is validated before the index is read, and one project's /file and /raw never reach
// another's files. Kept through the test rewrite (docs/test-rewrite/README.md): the security posture
// AGENTS.md says to preserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fakeClaude, serveProjects, tempRepo, waitFor, type FakeClaudeChild } from '../../helpers.ts';
import type { ClaudeAdapter } from '#integrations/claude/types.ts';
import type { ServerOptions } from '../../../lib/server/types.ts';
import { PROJECT_ROUTES, ROUTES, matchRoute } from '../../../lib/server/start.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, updateJob } from '#core/job/store.ts';
import { listRequests } from '#core/job/requests.ts';
import { addProject } from '#engine/project/machine-index.ts';

// Every server here is the machine server with `root` registered as project `a`, serving the
// committed fixture dist, so the page (and the token in it) needs no real build.
const P = '/api/p/a';
const startServer = (root: string, opts: ServerOptions = {}) => serveProjects([{ dir: root, name: 'a' }], opts);

/** @param {number} port @param {Record<string,string>} headers @param {string} [method] @param {string} [body] */
function call(port, headers, method = 'GET', body?: any) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: method === 'GET' ? `${P}/state` : `${P}/requests`, method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('dashboard server rejects DNS-rebound hosts and cross-origin posts', async () => {
  const repo = tempRepo();
  const s = await startServer(repo.dir);
  const port = s.port;
  try {
    assert.equal(await call(port, { host: `127.0.0.1:${port}` }), 200);
    assert.equal(await call(port, { host: `localhost:${port}` }), 200);
    assert.equal(await call(port, { host: `evil.example:${port}` }), 421);
    const post = { 'content-type': 'application/json', 'x-forge-token': 'wrong', host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    assert.equal(await call(port, post, 'POST', '{"type":"sync"}'), 403);
    const { origin: _o, ...noOrigin } = post;
    assert.equal(await call(port, noOrigin, "POST", "{\"type\":\"sync\"}"), 403);
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

// ---- Daemon endpoints. Every pool here gets fake claude children: nothing real is spawned or signalled.

/** @param {number} port @param {{method?:string, path:string, headers?:Record<string,string>, body?:string}} o */
function hit(port, o): any {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? 'GET', headers: { host: `127.0.0.1:${port}`, ...(o.headers ?? {}) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(o.body);
  });
}

/** A pool's daemon options over fakeClaude, tracking the most children of one scope alive at once. */
function daemonKit() {
  const fake = fakeClaude();
  const children: FakeClaudeChild[] = fake.children;
  const claude: ClaudeAdapter = {
    start(argv, o, onEvent) {
      const c = fake.adapter.start(argv, o, onEvent) as FakeClaudeChild;
      const live = children.filter((x) => !x.exited && x.scope === c.scope).length;
      if (live > kit.maxLive) kit.maxLive = live;
      return c;
    },
  };
  const kit = { children, maxLive: 0, opts: { claude, pollMs: 3_600_000, graceMs: 500 } };
  return kit;
}

/** @param {string} dir @param {Record<string, any>} daemon */
function writeConfig(dir, daemon) {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: CONFIG_SCHEMA_VERSION, daemon }));
}

const tokenOf = async (port) => /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];

test('POST /api/daemon is token, origin and JSON guarded', async () => {
  const repo = tempRepo();
  const kit = daemonKit();
  const s = await startServer(repo.dir, { daemon: kit.opts });
  const port = s.port;
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: `${P}/daemon`, headers, body });
    assert.equal((await post('{"action":"start"}', { ...good, 'x-forge-token': 'wrong' })).status, 403);
    const { origin: _o, ...noOrigin } = good;
    assert.equal((await post('{"action":"start"}', noOrigin)).status, 403);
    assert.equal((await post('{"action":"start"}', { ...good, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post('{"action":"start"}', { ...good, origin: 'not a url' })).status, 403);
    assert.equal((await post('{"action":"start"}', { ...good, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post('{"action":', good)).status, 400);
    assert.equal((await post('{"action":"restart"}')).status, 400);
    assert.equal((await post('[]')).status, 400);
    const disabled = await post('{"action":"start"}');
    assert.equal(disabled.status, 409);
    assert.deepEqual(JSON.parse(disabled.text), { error: 'daemon.enabled is false in .forge/config.yml' });
    assert.equal(kit.children.length, 0, 'nothing is spawned while disabled');

    writeConfig(repo.dir, { enabled: true, command: 'claude -p "{prompt}" {session}' });
    const launcher = await post('{"action":"start"}');
    assert.equal(launcher.status, 409);
    assert.match(JSON.parse(launcher.text).error, /\{prompt\}/);
    assert.equal(kit.children.length, 0);

    writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
    const started = await post('{"action":"start"}');
    assert.equal(started.status, 200);
    assert.equal(JSON.parse(started.text).inbox.running, true);
    assert.equal(kit.children.length, 1);
    // Interleaved starts and stops never leave more than one inbox child alive.
    const storm = await Promise.all(Array.from({ length: 24 }, (_, i) => post(i % 3 ? '{"action":"start"}' : '{"action":"stop"}')));
    assert.ok(storm.every((r) => r.status === 200));
    assert.equal(kit.maxLive, 1, 'at most one inbox child at any time');
    const stopped = await post('{"action":"stop"}');
    assert.equal(stopped.status, 200);
    assert.equal(JSON.parse(stopped.text).wanted, false);
    const after = JSON.parse((await hit(port, { path: `${P}/state` })).text).daemons;
    assert.equal(after.inbox.running, false);
    assert.equal(after.inbox.status, 'off');
    assert.equal(kit.children.filter((c) => !c.exited).length, 0, 'no child left after the final stop');
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

test('POST /api/config is token, origin and JSON guarded', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: false });
  const file = path.join(repo.dir, '.forge', 'config.yml');
  const before = fs.readFileSync(file);
  const s = await startServer(repo.dir, { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const good = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: `${P}/config`, headers, body });
    const body = '{"key":"pipeline.maxRounds","value":4}';
    assert.equal((await post(body, { ...good, 'x-forge-token': 'wrong' })).status, 403);
    const { origin: _o, ...noOrigin } = good;
    assert.equal((await post(body, noOrigin)).status, 403);
    assert.equal((await post(body, { ...good, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(body, { ...good, 'content-type': 'text/plain' })).status, 415);
    const notJson = await post('{"key":', good);
    assert.equal(notJson.status, 400);
    assert.deepEqual(JSON.parse(notJson.text), { error: 'body is not JSON' });
    assert.equal((await post('{"value":1}')).status, 400);
    assert.equal((await post('{"key":"pipeline.maxRounds"}')).status, 400, 'value must be present');
    assert.equal((await post('[]')).status, 400);
    assert.ok(fs.readFileSync(file).equals(before), 'config.yml is byte-identical');
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

/** One request on its own connection (agent: false): what came back, as status, Content-Type and text. */
function raw(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? ''), text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The repo's files outside .git/, so a test can tell that a request wrote nothing. */
const filesOf = (dir: string): string[] => (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.split(path.sep)[0] !== '.git').sort();

/** The row a request path matches: a project path in PROJECT_ROUTES after its prefix, anything else in ROUTES. */
const routeOf = (method: string, p: string) => {
  const pathname = p.split('?')[0]!;
  return pathname.startsWith(`${P}/`) ? matchRoute(PROJECT_ROUTES, method, pathname.slice(P.length))?.route : matchRoute(ROUTES, method, pathname)?.route;
};

test('every guarded route refuses before its handler runs', async () => {
  const repo = tempRepo();
  const s = await startServer(repo.dir, { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const token = await tokenOf(port);
    const origin = `http://127.0.0.1:${port}`;
    const evil = 'http://evil.example';
    type Row = { method: string; path: string; headers: Record<string, string>; body?: string; status: number; text: string };
    const rows: Row[] = [];
    // Invalid JSON: a guard that ran after the body parse would answer 400 instead.
    const body = '{"x":';
    const posts = [
      ...['/jobs', '/requests', '/config', '/budget/ack', '/daemon', '/daemon/permission', '/daemon/mode', '/focus', '/mandates/g1/draft', ...['effort', 'budget', 'delete', 'merge', 'repos', 'environment', 'run', 'editor'].map((x) => `/jobs/j-1/${x}`)].map((p) => `${P}${p}`),
      // The machine's own POST: no project prefix.
      '/api/projects',
    ];
    for (const p of posts) {
      rows.push({ method: 'POST', path: p, body, headers: { 'x-forge-token': 'wrong', origin, 'content-type': 'application/json' }, status: 403, text: 'bad token' });
      rows.push({ method: 'POST', path: p, body, headers: { 'x-forge-token': token, 'content-type': 'application/json' }, status: 403, text: 'bad origin' });
      rows.push({ method: 'POST', path: p, body, headers: { 'x-forge-token': token, origin, 'content-type': 'text/plain' }, status: 415, text: 'json only' });
      // A declared size over 64 KiB is refused before any byte is read; a wrong token still answers first.
      const big = { 'x-forge-token': token, origin, 'content-type': 'application/json', 'content-length': '70000' };
      rows.push({ method: 'POST', path: p, headers: big, status: 413, text: 'body too large' });
      rows.push({ method: 'POST', path: p, headers: { ...big, 'x-forge-token': 'wrong' }, status: 403, text: 'bad token' });
    }
    const readRows = (p: string): Row[] => [
      { method: 'GET', path: p, headers: { 'sec-fetch-site': 'cross-site' }, status: 403, text: 'cross-site' },
      { method: 'GET', path: p, headers: { origin: evil }, status: 403, text: 'bad origin' },
    ];
    for (const p of [`${P}/doctor`, `${P}/github/preview?url=https://github.com/a/b`]) {
      rows.push(...readRows(p), { method: 'GET', path: p, headers: {}, status: 403, text: 'bad token' });
      rows.push({ method: 'GET', path: p, headers: { 'x-forge-token': token, origin: evil }, status: 403, text: 'bad origin' });
    }
    const reads = ['/state', '/stats', '/evals', '/evals/compare', '/requests', '/roster', '/project', '/backlog?refresh=1', '/config', '/mandates/g1/draft'].map((p) => `${P}${p}`);
    const streams = ['/events?session=_inbox', '/daemons/log?session=_inbox', '/jobs/j-1', '/jobs/j-1/file?path=x.md', '/jobs/j-1/raw?path=x.html'].map((p) => `${P}${p}`);
    for (const p of [...reads, ...streams, '/api/about', '/api/projects', '/api/projects/events', '/api/projects/stats']) rows.push(...readRows(p));
    for (const p of ['/environments', '/jobs/j-1/environment', '/jobs/j-1/transcript', '/doctor/bundle'].map((x) => `${P}${x}`)) {
      rows.push(...readRows(p), { method: 'GET', path: p, headers: { 'sec-fetch-site': 'same-origin' }, status: 403, text: 'bad token' });
    }
    for (const p of ['/jobs/j-1/transcript/events', '/jobs/j-1/environment/logs?source=dev'].map((x) => `${P}${x}`)) {
      rows.push(...readRows(p), { method: 'GET', path: p, headers: { 'x-forge-token': token }, status: 403, text: 'bad token' });
    }
    const guarded = [...new Map(rows.map((r) => [`${r.method} ${r.path}`, r])).values()];
    for (const r of [...guarded, { method: 'GET', path: '/' }, { method: 'GET', path: '/assets/index-Fx1.js' }, { method: 'GET', path: `${P}/state` }]) {
      rows.push({ method: r.method, path: r.path, headers: { host: `evil.example:${port}`, 'x-forge-token': token, origin }, status: 421, text: 'misdirected request' });
    }

    const before = filesOf(repo.dir);
    for (const r of rows) {
      const got = await raw(port, r.method, r.path, r.headers, r.body);
      assert.deepEqual({ status: got.status, text: got.text }, { status: r.status, text: r.text }, `${r.method} ${r.path} ${JSON.stringify(r.headers)}`);
    }
    assert.deepEqual(filesOf(repo.dir), before, 'a refused request writes nothing');

    // A route added later with guards, or as a POST, needs a row above, in either table.
    const covered = new Set(rows.map((r) => routeOf(r.method, r.path)));
    const missing = [...ROUTES, ...PROJECT_ROUTES].filter((r) => (r.method === 'POST' || r.guards?.length) && !covered.has(r as never)).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(missing, [], 'every guarded route has a row');
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

test('machine routes keep the read guard and project segments are validated', async () => {
  const repo = tempRepo();
  const later = tempRepo();
  // No timed re-read: only a request that names an unloaded project may read the index.
  const s = await startServer(repo.dir, { daemon: daemonKit().opts, refreshMs: 3_600_000 });
  const port = s.port;
  try {
    for (const p of ['/api/projects', '/api/projects/events']) {
      assert.deepEqual(await raw(port, 'GET', p, { origin: 'http://evil.example' }).then((r) => [r.status, r.text]), [403, 'bad origin'], p);
      assert.deepEqual(await raw(port, 'GET', p, { 'sec-fetch-site': 'cross-site' }).then((r) => [r.status, r.text]), [403, 'cross-site'], p);
      assert.equal((await raw(port, 'GET', p, { host: `evil.example:${port}` })).status, 421, p);
    }
    const token = await tokenOf(port);
    const origin = `http://127.0.0.1:${port}`;
    // Past the guard, Add project's handler refuses a body with no path.
    assert.equal((await raw(port, 'POST', '/api/projects', { 'x-forge-token': token, origin, 'content-type': 'application/json' }, '{}')).status, 400);

    // Registered after start: an invalid segment must not refresh the index and so load it.
    addProject(s.home, fs.realpathSync(later.dir), { name: 'c' });
    const long = 'a'.repeat(65);
    for (const p of ['/api/p/../state', '/api/p/A/state', '/api/p/a%2Fb/state', `/api/p/${long}/state`]) {
      const r = await raw(port, 'GET', p, {});
      assert.equal(r.status, 404, p);
      assert.ok(!r.text.includes(later.dir), p);
    }
    assert.deepEqual(JSON.parse((await raw(port, 'GET', `/api/p/${long}/state`, {})).text), { error: `no registered project ${JSON.stringify(long.slice(0, 64))}` });
    assert.equal(s.entry('c'), null, 'no invalid segment read the index');
    assert.equal((await raw(port, 'GET', '/api/p/c/state', {})).status, 200, 'a valid unloaded name refreshes once');
    assert.ok(s.entry('c'));

    const post = (headers: Record<string, string>) => raw(port, 'POST', `${P}/requests`, headers, '{"type":"sync"}').then((r) => r.status);
    assert.equal(await post({ 'x-forge-token': 'wrong', origin, 'content-type': 'application/json' }), 403);
    assert.equal(await post({ 'x-forge-token': token, 'content-type': 'application/json' }), 403);
    assert.equal(await post({ 'x-forge-token': token, origin, 'content-type': 'text/plain' }), 415);
    assert.equal(listRequests(repo.dir).length, 0, 'nothing is queued');
  } finally {
    await s.cleanup();
    repo.cleanup();
    later.cleanup();
  }
});

test("/file and /raw for one project refuse another project's files", async () => {
  const a = tempRepo();
  const b = tempRepo();
  const marker = `B-ONLY-${crypto.randomBytes(6).toString('hex')}`;
  const ja = createJob(a.dir, loadConfig(a.dir).config, { title: 'in a' }).id;
  const jb = createJob(b.dir, loadConfig(b.dir).config, { title: 'in b' }).id;
  const bDir = path.join(b.dir, '.forge', 'jobs', jb);
  for (const f of ['secret.md', 'secret.html']) fs.writeFileSync(path.join(bDir, f), `<p>${marker}</p>\n`);
  const aDir = path.join(a.dir, '.forge', 'jobs', ja);
  for (const f of ['secret.md', 'secret.html']) fs.symlinkSync(path.join(bDir, f), path.join(aDir, `link-${f}`));
  const s = await serveProjects([{ dir: a.dir, name: 'a' }, { dir: b.dir, name: 'b' }], { daemon: daemonKit().opts });
  try {
    for (const [kind, f] of [['file', 'secret.md'], ['raw', 'secret.html']] as const) {
      for (const rel of [path.join(bDir, f), path.relative(aDir, path.join(bDir, f)), `link-${f}`]) {
        const r = await raw(s.port, 'GET', `/api/p/a/jobs/${ja}/${kind}?path=${encodeURIComponent(rel)}`, {});
        assert.notEqual(r.status, 200, `${kind} ${rel}`);
        assert.ok(!r.text.includes(marker), `${kind} ${rel}: no B bytes`);
      }
      // The same file under B's own routes is B's to serve.
      const own = await raw(s.port, 'GET', `/api/p/b/jobs/${jb}/${kind}?path=${f}`, {});
      assert.equal(own.status, 200, `${kind} under b`);
      assert.ok(own.text.includes(marker));
    }
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('the job budget route raises or acknowledges as the dashboard', async () => {
  const repo = tempRepo();
  const other = tempRepo();
  const s = await serveProjects([{ dir: other.dir, name: 'a' }, { dir: repo.dir, name: 'b' }], { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const id = createJob(repo.dir, loadConfig(repo.dir).config, { title: 'over budget' }).id;
    updateJob(repo.dir, id, (j) => {
      j.budget.limits.usd = 1;
      j.usage = { ...j.usage, estCostUsd: 2 };
      j.state = 'waiting';
      j.waitingOn = 'budget';
    });
    const headers = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body: unknown, job = id, h: Record<string, string> = headers, prefix = '/api/p/b') => hit(port, { method: 'POST', path: `${prefix}/jobs/${job}/budget`, headers: h, body: JSON.stringify(body) });
    const files = () => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(repo.dir, '.forge', 'jobs', id, f), 'utf8'));
    const before = files();
    const { origin: _o, ...noOrigin } = headers;
    assert.equal((await post({ ack: true }, id, { ...headers, 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await post({ ack: true }, id, noOrigin)).status, 403);
    assert.equal((await post({ ack: true }, id, { ...headers, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ ack: true }, id, headers, '/api')).status, 404, 'the bare path is gone');
    assert.equal((await post({ ack: true }, id, headers, '/api/p/a')).status, 404, "another project's route never finds the job");
    const shape = 'body must be {"ack": true} or {"set": ["key=value", …]} (or both)';
    for (const body of [{}, { ack: false }, { set: 'usd=1' }, { set: ['usd=1', 'usd=2', 'usd=3', 'usd=4', 'usd=5', 'usd=6'] }, { set: [] }, { ack: 'yes' }, { set: ['x'.repeat(101)] }, [true]]) {
      const r = await post(body);
      assert.deepEqual({ status: r.status, error: JSON.parse(r.text).error }, { status: 400, error: shape }, JSON.stringify(body));
    }
    const bogus = await post({ set: ['bogus=1'] });
    assert.equal(bogus.status, 400);
    assert.match(JSON.parse(bogus.text).error, /^unknown budget key in "bogus=1" \(allowed keys: /);
    const missing = await post({ ack: true }, 'nope');
    assert.deepEqual({ status: missing.status, error: JSON.parse(missing.text).error }, { status: 404, error: 'no job nope' });
    assert.deepEqual(files(), before, 'no 4xx changes job.json or events.jsonl');

    const acked = await post({ ack: true });
    assert.equal(acked.status, 200);
    assert.deepEqual([JSON.parse(acked.text).acked, JSON.parse(acked.text).stillExceeded], [['usd'], []]);
    const set = await post({ set: ['usd=20'] });
    assert.equal(set.status, 200);
    assert.equal(JSON.parse(set.text).limits.usd, 20);
    const events = fs.readFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.find((e) => e.type === 'budget-ack')?.actor?.source, 'dashboard');
    assert.equal(events.find((e) => e.type === 'budget-set')?.actor?.source, 'dashboard');
  } finally {
    await s.cleanup();
    repo.cleanup();
    other.cleanup();
  }
});

test('POST /api/requests refuses gate and draft requests', async () => {
  const repo = tempRepo();
  const s = await startServer(repo.dir, { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const headers = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const rows: [Record<string, unknown>, string][] = [
      [{ type: 'gate', job: 'j1', args: { gate: 'spec-approval' } }, 'gate requests are written only by forge job set and forge pr sync (and forge mandate draft record for a milestone draft)'],
      [{ type: 'gate', job: null, args: { gate: 'milestone-approval', mandate: 'g1' } }, 'gate requests are written only by forge job set and forge pr sync (and forge mandate draft record for a milestone draft)'],
      [{ type: 'draft', args: { mandate: 'g1' } }, 'draft requests are written only by forge mandate'],
      [{ type: 'direct' }, 'direct requests are written only by the Office pass'],
    ];
    for (const [body, error] of rows) {
      const r = await hit(port, { method: 'POST', path: `${P}/requests`, headers, body: JSON.stringify(body) });
      assert.deepEqual({ status: r.status, error: JSON.parse(r.text).error }, { status: 400, error }, String(body.type));
    }
    assert.deepEqual(listRequests(repo.dir), [], 'no request file');
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

test('backlog refresh needs the token', async () => {
  const repo = tempRepo();
  const backlog = path.join(repo.dir, '.forge', 'backlog.md');
  fs.mkdirSync(path.dirname(backlog), { recursive: true });
  fs.writeFileSync(backlog, '# Backlog\n- [ ] Item A\n');
  const s = await startServer(repo.dir, { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const titles = async (p: string, headers: Record<string, string> = {}) => JSON.parse((await hit(port, { path: `${P}${p}`, headers })).text).items.map((i: { title: string }) => i.title);
    assert.deepEqual(await titles('/backlog'), ['Item A']);
    fs.writeFileSync(backlog, '# Backlog\n- [ ] Item B\n');
    // Without the token, `refresh` is ignored and the cache answers.
    assert.deepEqual(await titles('/backlog?refresh=1'), ['Item A']);
    assert.deepEqual(await titles('/backlog?refresh=1', { 'x-forge-token': 'wrong' }), ['Item A']);
    assert.deepEqual(await titles('/backlog?refresh=1', { 'x-forge-token': await tokenOf(port) }), ['Item B']);
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

test('the page and mockups carry the framing headers', async () => {
  const repo = tempRepo();
  const id = createJob(repo.dir, loadConfig(repo.dir).config, { title: 'a mockup' }).id;
  fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'mockup.html'), '<p>mockup</p>');
  const s = await startServer(repo.dir, { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const framing = async (p: string) => {
      const r = await hit(port, { path: p });
      return { status: r.status, csp: r.headers['content-security-policy'], dns: r.headers['x-dns-prefetch-control'] };
    };
    const page = { status: 200, csp: "frame-src 'self'; frame-ancestors 'none'", dns: 'off' };
    assert.deepEqual(await framing('/'), page);
    assert.deepEqual(await framing('/index.html'), page);
    assert.deepEqual(await framing(`${P}/jobs/${id}/raw?path=mockup.html`), {
      status: 200,
      csp: "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'",
      dns: 'off',
    });
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

test("a resume reaches the job's own session under any id it has had", async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const kit = daemonKit();
  const s = await startServer(repo.dir, { daemon: kit.opts });
  const port = s.port;
  const pool = s.entry('a')!.pool;
  try {
    const good = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (p: string, body: unknown) => hit(port, { method: 'POST', path: `${P}${p}`, headers: good, body: JSON.stringify(body) });
    const resume = (job: string) => post('/requests', { type: 'resume', job });
    const jobSession = async (job: string) => JSON.parse((await hit(port, { path: `${P}/jobs/${job}` })).text).job.ownerStatus.jobSession;
    const lease = (job: string, driver: string) =>
      updateJob(repo.dir, job, (j) => {
        const at = new Date().toISOString();
        j.lease = { driver, epoch: 1, since: at, renewedAt: at, expiresAt: new Date(Date.now() + 30 * 60_000).toISOString() };
      });
    const { config } = loadConfig(repo.dir);
    const a = createJob(repo.dir, config, { title: 'the job its session drives' }).id;
    const b = createJob(repo.dir, config, { title: 'a job with no session' }).id;
    assert.equal((await post('/daemon', { action: 'start' })).status, 200);
    // A request for the job makes the pool spawn its session.
    assert.equal((await resume(a)).status, 200);
    await waitFor(() => pool.sessionState(a).running, { what: "the job's session" });
    const sid = pool.sessionState(a).sessionId!;
    lease(a, sid);
    const y = crypto.randomUUID();
    kit.children.find((c) => c.scope === a)!.emit({ kind: 'session-id', id: y });
    assert.equal(pool.sessionState(a).sessionId, y);

    const queued = listRequests(repo.dir).length;
    const own = await resume(a);
    assert.equal(own.status, 200, own.text);
    assert.equal(listRequests(repo.dir).length, queued + 1, 'the resume is queued');
    assert.equal(await jobSession(a), true);

    // A stranger's live lease still holds the resume, and queues nothing.
    const stranger = crypto.randomUUID();
    lease(a, stranger);
    const held = await resume(a);
    assert.equal(held.status, 409);
    assert.match(JSON.parse(held.text).error, new RegExp(`^job ${a} is held by session ${stranger} \\(claimed .+\\); resume it from that session or wait until its lease expires$`));
    assert.equal(listRequests(repo.dir).length, queued + 1, 'nothing more is queued');
    assert.equal(await jobSession(a), false);

    // The session's id driving another job is a stranger there: only the job's own session counts.
    lease(b, sid);
    const elsewhere = await resume(b);
    assert.equal(elsewhere.status, 409);
    assert.match(JSON.parse(elsewhere.text).error, new RegExp(`^job ${b} is held by session ${sid} `));
    assert.equal(await jobSession(b), false);
    assert.equal(listRequests(repo.dir).length, queued + 1);
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});

test('a route that throws answers 500 and the server keeps serving', async () => {
  const repo = tempRepo();
  // An agent can leave job.json unreadable; the environment route is async, so its throw is a rejection.
  fs.mkdirSync(path.join(repo.dir, '.forge', 'jobs', 'j-1'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', 'j-1', 'job.json'), '{');
  const s = await startServer(repo.dir, { daemon: daemonKit().opts });
  const port = s.port;
  try {
    const token = await tokenOf(port);
    const broken = await raw(port, 'GET', `${P}/jobs/j-1/environment`, { 'x-forge-token': token, 'sec-fetch-site': 'same-origin' });
    assert.equal(broken.status, 500);
    assert.match(broken.type, /^application\/json/);
    assert.match(JSON.parse(broken.text).error, /cannot read/);
    assert.equal((await raw(port, 'GET', '/api/about', {})).status, 200);
  } finally {
    await s.cleanup();
    repo.cleanup();
  }
});
