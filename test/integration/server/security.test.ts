// The dashboard server's request guards: it answers loopback Hosts only, and its POSTs need the token,
// a matching Origin and a JSON body (docs/ARCHITECTURE.md "Dashboard security"). Kept through the test
// rewrite (docs/test-rewrite/README.md): the security posture AGENTS.md says to preserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fakeClaude, tempRepo, type FakeClaudeChild } from '../../helpers.ts';
import type { ClaudeAdapter } from '#integrations/claude/types.ts';
import { startServer as serve } from '../../../lib/server/start.ts';
import { ROUTES, matchRoute } from '../../../lib/server/start.ts';
import { FIXTURE_DIST } from '../../dist.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';

// Every server here serves the committed fixture dist unless a test names its own, so the page (and the token
// in it) needs no real build: develop never commits dashboard/dist/.
const startServer: typeof serve = (root, opts = {}) => serve(root, { distDir: FIXTURE_DIST, ...opts });

/** @param {number} port @param {Record<string,string>} headers @param {string} [method] @param {string} [body] */
function call(port, headers, method = 'GET', body?: any) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: method === 'GET' ? '/api/state' : '/api/requests', method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('dashboard server rejects DNS-rebound hosts and cross-origin posts', async () => {
  const repo = tempRepo();
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  try {
    assert.equal(await call(port, { host: `127.0.0.1:${port}` }), 200);
    assert.equal(await call(port, { host: `localhost:${port}` }), 200);
    assert.equal(await call(port, { host: `evil.example:${port}` }), 421);
    const post = { 'content-type': 'application/json', 'x-forge-token': 'wrong', host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` };
    assert.equal(await call(port, post, 'POST', '{"type":"sync"}'), 403);
    const { origin: _o, ...noOrigin } = post;
    assert.equal(await call(port, noOrigin, "POST", "{\"type\":\"sync\"}"), 403);
  } finally {
    server.close();
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
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: '/api/daemon', headers, body });
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
    const after = JSON.parse((await hit(port, { path: '/api/state' })).text).daemons;
    assert.equal(after.inbox.running, false);
    assert.equal(after.inbox.status, 'off');
    assert.equal(kit.children.filter((c) => !c.exited).length, 0, 'no child left after the final stop');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('POST /api/config is token, origin and JSON guarded', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: false });
  const file = path.join(repo.dir, '.forge', 'config.yml');
  const before = fs.readFileSync(file);
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: daemonKit().opts });
  const port = Number(new URL(url).port);
  try {
    const good = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: '/api/config', headers, body });
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
    await close();
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

test('every guarded route refuses before its handler runs', async () => {
  const repo = tempRepo();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: daemonKit().opts });
  const port = Number(new URL(url).port);
  try {
    const token = await tokenOf(port);
    const origin = `http://127.0.0.1:${port}`;
    const evil = 'http://evil.example';
    type Row = { method: string; path: string; headers: Record<string, string>; body?: string; status: number; text: string };
    const rows: Row[] = [];
    // Invalid JSON: a guard that ran after the body parse would answer 400 instead.
    const body = '{"x":';
    const posts = ['/api/jobs', '/api/requests', '/api/config', '/api/budget/ack', '/api/daemon', '/api/daemon/permission', '/api/daemon/mode', '/api/focus', ...['effort', 'delete', 'repos', 'environment', 'run', 'editor'].map((s) => `/api/jobs/j-1/${s}`)];
    for (const p of posts) {
      rows.push({ method: 'POST', path: p, body, headers: { 'x-forge-token': 'wrong', origin, 'content-type': 'application/json' }, status: 403, text: 'bad token' });
      rows.push({ method: 'POST', path: p, body, headers: { 'x-forge-token': token, 'content-type': 'application/json' }, status: 403, text: 'bad origin' });
      rows.push({ method: 'POST', path: p, body, headers: { 'x-forge-token': token, origin, 'content-type': 'text/plain' }, status: 415, text: 'json only' });
    }
    const readRows = (p: string): Row[] => [
      { method: 'GET', path: p, headers: { 'sec-fetch-site': 'cross-site' }, status: 403, text: 'cross-site' },
      { method: 'GET', path: p, headers: { origin: evil }, status: 403, text: 'bad origin' },
    ];
    for (const p of ['/api/doctor', '/api/github/preview?url=https://github.com/a/b']) {
      rows.push({ method: 'GET', path: p, headers: {}, status: 403, text: 'bad token' });
      rows.push({ method: 'GET', path: p, headers: { 'x-forge-token': token, origin: evil }, status: 403, text: 'bad origin' });
    }
    for (const p of ['/api/events?session=_inbox', '/api/daemons/log?session=_inbox', '/api/jobs/j-1']) rows.push(...readRows(p));
    for (const p of ['/api/environments', '/api/jobs/j-1/environment', '/api/jobs/j-1/transcript', '/api/doctor/bundle']) {
      rows.push(...readRows(p), { method: 'GET', path: p, headers: { 'sec-fetch-site': 'same-origin' }, status: 403, text: 'bad token' });
    }
    for (const p of ['/api/jobs/j-1/transcript/events', '/api/jobs/j-1/environment/logs?source=dev']) {
      rows.push(...readRows(p), { method: 'GET', path: p, headers: { 'x-forge-token': token }, status: 403, text: 'bad token' });
    }
    const guarded = [...new Map(rows.map((r) => [`${r.method} ${r.path}`, r])).values()];
    for (const r of [...guarded, { method: 'GET', path: '/' }, { method: 'GET', path: '/assets/index-Fx1.js' }, { method: 'GET', path: '/api/state' }]) {
      rows.push({ method: r.method, path: r.path, headers: { host: `evil.example:${port}`, 'x-forge-token': token, origin }, status: 421, text: 'misdirected request' });
    }

    const before = filesOf(repo.dir);
    for (const r of rows) {
      const got = await raw(port, r.method, r.path, r.headers, r.body);
      assert.deepEqual({ status: got.status, text: got.text }, { status: r.status, text: r.text }, `${r.method} ${r.path} ${JSON.stringify(r.headers)}`);
    }
    assert.deepEqual(filesOf(repo.dir), before, 'a refused request writes nothing');

    // A route added later with guards, or as a POST, needs a row above.
    const covered = new Set(rows.map((r) => matchRoute(ROUTES, r.method, r.path.split('?')[0])?.route));
    const missing = ROUTES.filter((r) => (r.method === 'POST' || r.guards?.length) && !covered.has(r)).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(missing, [], 'every guarded route has a row');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('a route that throws answers 500 and the server keeps serving', async () => {
  const repo = tempRepo();
  // An agent can leave job.json unreadable; the environment route is async, so its throw is a rejection.
  fs.mkdirSync(path.join(repo.dir, '.forge', 'jobs', 'j-1'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', 'j-1', 'job.json'), '{');
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: daemonKit().opts });
  const port = Number(new URL(url).port);
  try {
    const token = await tokenOf(port);
    const broken = await raw(port, 'GET', '/api/jobs/j-1/environment', { 'x-forge-token': token, 'sec-fetch-site': 'same-origin' });
    assert.equal(broken.status, 500);
    assert.match(broken.type, /^application\/json/);
    assert.match(JSON.parse(broken.text).error, /cannot read/);
    assert.equal((await raw(port, 'GET', '/api/about', {})).status, 200);
  } finally {
    await close();
    repo.cleanup();
  }
});
