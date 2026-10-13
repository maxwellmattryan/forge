import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { broadcast, startServer } from '../lib/server.mjs';
import { TURN_LINE } from '../lib/daemon.mjs';
import * as yaml from '../lib/yaml.mjs';

/** @param {number} port @param {Record<string,string>} headers @param {string} [method] @param {string} [body] */
function call(port, headers, method = 'GET', body) {
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

/** @param {number} port @param {string} path @param {string} [host] @returns {Promise<{status:number|undefined, type:string|undefined, headers:http.IncomingHttpHeaders, body:Buffer}>} */
function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      /** @type {Buffer[]} */
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard server serves only the allowlisted modules', async () => {
  const repo = tempRepo();
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  try {
    for (const p of ['/app.js', '/util.js', '/budget.js', '/deps.js', '/screenshots.js']) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.match(r.type ?? '', /^text\/javascript/, p);
    }
    for (const p of ['/lib.js', '/server.mjs', '/..%2Flib%2Fserver.mjs', '/index.js', '/../lib/server.mjs', '/dashboard/app.js']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
    assert.equal((await get(port, '/budget.js', `evil.example:${port}`)).status, 421);
  } finally {
    server.close();
    repo.cleanup();
  }
});

test('serves job screenshots as images only, confined to screenshots/', async () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
  const forge = (...args) => JSON.parse(execFileSync(process.execPath, [bin, ...args], { cwd: repo.dir, encoding: 'utf8', env }));
  const outside = path.join(repo.dir, '..', `outside-${path.basename(repo.dir)}.png`);
  forge('init', 'write');
  const job = forge('job', 'new', '--title', 'Shots');
  const dir = path.join(repo.dir, job.dir);
  const shots = path.join(dir, 'screenshots');
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP')]);
  fs.mkdirSync(path.join(shots, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(shots, 'a.png'), PNG);
  fs.writeFileSync(path.join(shots, 'b.jpg'), JPG);
  fs.writeFileSync(path.join(shots, 'c.webp'), WEBP);
  fs.writeFileSync(path.join(shots, 'nested', 'd.png'), PNG);
  fs.writeFileSync(path.join(shots, 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
  fs.writeFileSync(path.join(shots, '.hidden.png'), PNG);
  fs.writeFileSync(path.join(dir, 'logo.png'), PNG);
  fs.writeFileSync(outside, PNG);
  fs.symlinkSync(outside, path.join(shots, 'link.png'));
  const outsideDir = path.join(repo.dir, '..', `outside-dir-${path.basename(repo.dir)}`);
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.writeFileSync(path.join(outsideDir, 'e.png'), PNG);
  fs.symlinkSync(outsideDir, path.join(shots, 'linkdir'));
  fs.mkdirSync(path.join(shots, 'l1', 'l2', 'l3'), { recursive: true });
  fs.writeFileSync(path.join(shots, 'l1', 'l2', 'two-deep.png'), PNG);
  fs.writeFileSync(path.join(shots, 'l1', 'l2', 'l3', 'too-deep.png'), PNG);
  const fifo = path.join(shots, 'pipe.png');
  const hasFifo = spawnSync('mkfifo', [fifo]).status === 0;
  fs.writeFileSync(path.join(shots, 'huge.png'), Buffer.alloc(11 * 1024 * 1024));
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  const file = (rel) => `/api/jobs/${job.id}/file?path=${encodeURIComponent(rel)}`;
  try {
    for (const [rel, type, bytes] of [['screenshots/a.png', 'image/png', PNG], ['screenshots/b.jpg', 'image/jpeg', JPG], ['screenshots/c.webp', 'image/webp', WEBP], ['screenshots/nested/d.png', 'image/png', PNG]]) {
      const r = await get(port, file(rel));
      assert.equal(r.status, 200, rel);
      assert.equal(r.type, type, rel);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', rel);
      assert.equal(r.headers['content-security-policy'], "default-src 'none'", rel);
      assert.equal(r.headers['cache-control'], 'no-store', rel);
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', rel);
      assert.ok(r.body.equals(bytes), rel);
    }
    for (const rel of ['screenshots/x.svg', 'logo.png', 'screenshots/../../../etc/x.png', 'screenshots/../logo.png', 'screenshots/link.png', 'screenshots/linkdir/e.png', 'screenshots/missing.png', 'screenshots/nested', ...(hasFifo ? ['screenshots/pipe.png'] : [])])
      assert.equal((await get(port, file(rel))).status, 404, rel);
    assert.equal((await get(port, `/api/jobs/${job.id}/raw?path=screenshots/a.png`)).status, 404);
    const huge = await get(port, file('screenshots/huge.png'));
    assert.equal(huge.status, 413);
    assert.equal(huge.headers['cross-origin-resource-policy'], 'same-origin');
    assert.equal(huge.headers['cache-control'], 'no-store');
    assert.equal((await get(port, file('screenshots/a.png'), `evil.example:${port}`)).status, 421);

    const detail = JSON.parse((await get(port, `/api/jobs/${job.id}`)).body.toString('utf8'));
    assert.deepEqual(detail.screenshots, ['screenshots/a.png', 'screenshots/b.jpg', 'screenshots/c.webp', 'screenshots/huge.png', 'screenshots/l1/l2/two-deep.png', 'screenshots/nested/d.png']);
    assert.ok(Array.isArray(detail.files));
    // The list is capped at 200.
    for (let i = 0; i < 205; i++) fs.writeFileSync(path.join(shots, 'nested', `many-${i}.png`), PNG);
    assert.equal(JSON.parse((await get(port, `/api/jobs/${job.id}`)).body.toString('utf8')).screenshots.length, 200);
    fs.rmSync(shots, { recursive: true });
    assert.deepEqual(JSON.parse((await get(port, `/api/jobs/${job.id}`)).body.toString('utf8')).screenshots, []);
  } finally {
    server.close();
    repo.cleanup();
    fs.rmSync(outside, { force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ---- Daemon endpoints (AC15–AC17). Every daemon here gets in-memory children: nothing real is spawned or signalled.

/** @param {number} port @param {{method?:string, path:string, headers?:Record<string,string>, body?:string}} o */
function hit(port, o) {
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

function fakeChildren() {
  const children = [];
  const spawn = (cmd, args, opts) => {
    const c = new EventEmitter();
    Object.assign(c, { cmd, args, opts, pid: 4_100_000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), written: '' });
    c.stdin.on('data', (d) => (c.written += d.toString()));
    c.exit = (code, signal) => {
      c.stdout.end();
      c.stderr.end();
      c.emit('exit', code, signal);
      c.emit('close', code, signal);
    };
    c.line = (obj) => c.stdout.write(JSON.stringify(obj) + '\n');
    children.push(c);
    return c;
  };
  const killTree = (c, signal) => setImmediate(() => c.exit(null, signal));
  return { children, opts: { spawn, killTree, pollMs: 3_600_000, graceMs: 500 } };
}

/** @param {string} dir @param {Record<string, any>} daemon */
function writeConfig(dir, daemon) {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 2, daemon }));
}

/** An SSE reader that collects parsed frames. @param {number} port @param {Record<string,string>} [headers] */
function sse(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events', headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const client = { status: res.statusCode, headers: res.headers, frames: [], raw: '', close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', (d) => {
        client.raw += d;
        let i;
        while ((i = client.raw.indexOf('\n\n')) !== -1) {
          const block = client.raw.slice(0, i);
          client.raw = client.raw.slice(i + 2);
          const f = {};
          for (const l of block.split('\n')) {
            const m = /^([a-z]*): ?(.*)$/.exec(l);
            if (m) f[m[1] || 'comment'] = m[2];
          }
          client.frames.push(f);
        }
      });
      res.on('error', () => {});
      resolve(client);
    });
    req.on('error', reject);
    req.end();
  });
}

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('timed out');
};

test('AC15: SSE event stream is loopback-only, capped and replayable', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'fake-claude {session}' });
  const kit = fakeChildren();
  const { url, daemon, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  const open = [];
  try {
    const c = kit.children[0];
    c.line({ type: 'system', subtype: 'init', session_id: daemon.state().sessionId });
    c.line({ type: 'assistant', n: 1 });
    await until(() => daemon.recent().length >= 3);
    const buffered = daemon.recent();

    const a = await sse(port);
    open.push(a);
    assert.equal(a.status, 200);
    assert.equal(a.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(a.headers['cache-control'], 'no-store');
    assert.equal(a.headers['x-content-type-options'], 'nosniff');
    assert.equal(a.headers['access-control-allow-origin'], undefined, 'no CORS');
    await until(() => a.frames.length >= 2 + buffered.length);
    assert.equal(a.frames[0].retry, '3000');
    assert.equal(a.frames[1].event, 'state');
    const st = JSON.parse(a.frames[1].data);
    assert.equal(st.running, true);
    assert.equal(st.clients, 1);
    const replay = a.frames.slice(2, 2 + buffered.length);
    assert.deepEqual(replay.map((f) => f.event), buffered.map(() => 'line'));
    assert.deepEqual(replay.map((f) => Number(f.id)), buffered.map((b) => b.seq));
    assert.deepEqual(replay.map((f) => f.data), buffered.map((b) => b.line));

    c.line({ type: 'assistant', n: 2 });
    await until(() => a.frames.some((f) => f.event === 'line' && f.data === '{"type":"assistant","n":2}'));
    const lines = a.frames.filter((f) => f.event === 'line').map((f) => Number(f.id));
    assert.deepEqual(lines, [...lines].sort((x, y) => x - y), 'ids increase');
    assert.equal(new Set(lines).size, lines.length);

    const n = buffered[1].seq;
    const b = await sse(port, { 'last-event-id': String(n) });
    open.push(b);
    await until(() => b.frames.filter((f) => f.event === 'line').length >= daemon.recent(n).length);
    assert.deepEqual(b.frames.filter((f) => f.event === 'line').map((f) => Number(f.id)), daemon.recent(n).map((r) => r.seq), 'only lines after Last-Event-ID');
    const ahead = await sse(port, { 'last-event-id': '999999' });
    open.push(ahead);
    await until(() => ahead.frames.filter((f) => f.event === 'line').length === daemon.recent().length);

    c.line({ type: 'big', pad: 'x'.repeat(70 * 1024) });
    await until(() => a.frames.some((f) => f.data?.includes('forge-truncated')));
    const big = JSON.parse(a.frames.find((f) => f.data?.includes('forge-truncated')).data);
    assert.equal(big.originalType, 'big');
    assert.ok(big.bytes > 64 * 1024);

    assert.equal((await hit(port, { path: '/api/events', headers: { host: `evil.example:${port}` } })).status, 421);
    assert.equal((await hit(port, { path: '/api/events', headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await hit(port, { path: '/api/events', headers: { origin: 'null' } })).status, 403);
    const same = await sse(port, { origin: `http://127.0.0.1:${port}` });
    open.push(same);
    assert.equal(same.status, 200);

    while (open.length < 8) open.push(await sse(port));
    const ninth = await hit(port, { path: '/api/events' });
    assert.equal(ninth.status, 503);
    assert.equal(ninth.text, 'too many event streams');
    open.pop().close();
    await until(() => JSON.parse(a.frames.filter((f) => f.event === 'state').at(-1).data).clients === 7);
    const again = await sse(port);
    open.push(again);
    assert.equal(again.status, 200, 'a freed slot is reusable');

    const ended = [];
    const stub = (writableLength) => ({ writableLength, write() {}, end() { ended.push(writableLength); } });
    const slow = stub(2 * 1024 * 1024);
    const fast = stub(10);
    const set = new Set([slow, fast]);
    broadcast(set, 'event: line\ndata: {}\n\n');
    assert.deepEqual(ended, [2 * 1024 * 1024], 'the slow client is ended');
    assert.deepEqual([...set], [fast]);
  } finally {
    for (const o of open) o.close();
    await close();
    repo.cleanup();
  }
});

test('AC16: POST /api/daemon is token, origin and JSON guarded', async () => {
  const repo = tempRepo();
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers = good) => hit(port, { method: 'POST', path: '/api/daemon', headers, body });
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

    writeConfig(repo.dir, { enabled: true, command: 'fake-claude {session}' });
    const started = await post('{"action":"start"}');
    assert.equal(started.status, 200);
    assert.equal(JSON.parse(started.text).running, true);
    assert.equal(kit.children.length, 1);
    const stopped = await post('{"action":"stop"}');
    assert.equal(stopped.status, 200);
    assert.equal(JSON.parse(stopped.text).wanted, false);
    const after = JSON.parse((await hit(port, { path: '/api/state' })).text).daemon;
    assert.equal(after.running, false);
    assert.equal(after.status, 'off');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('AC17: /api/state v4 exposes daemon state and boots an enabled daemon', async () => {
  const repo = tempRepo();
  const keys = ['enabled', 'wanted', 'running', 'status', 'sessionId', 'pid', 'lastTurnAt', 'lastResultAt', 'turns', 'held', 'lastError', 'clients'];
  const kitOff = fakeChildren();
  let srv = await startServer(repo.dir, { port: 0, daemon: kitOff.opts });
  try {
    const s = JSON.parse((await hit(Number(new URL(srv.url).port), { path: '/api/state' })).text);
    assert.equal(s.apiVersion, 4);
    assert.deepEqual(s.config.daemon, { enabled: false });
    assert.equal('launcher' in s.config, false);
    assert.deepEqual(Object.keys(s.daemon), keys);
    assert.equal(s.daemon.running, false);
    assert.equal(kitOff.children.length, 0, 'disabled: nothing is spawned');
  } finally {
    await srv.close();
  }

  writeConfig(repo.dir, { enabled: true, command: 'fake-claude {session}' });
  const kit = fakeChildren();
  srv = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(srv.url).port);
  try {
    const s = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.deepEqual(s.config.daemon, { enabled: true });
    assert.deepEqual(Object.keys(s.daemon), keys);
    assert.equal(s.daemon.running, true, 'an enabled daemon starts with the server, no request needed');
    assert.equal(s.daemon.status, 'idle');
    assert.equal(kit.children.length, 1);

    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const r = await hit(port, {
      method: 'POST',
      path: '/api/requests',
      headers: { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'next' }),
    });
    assert.equal(r.status, 200);
    const rec = JSON.parse(r.text);
    assert.equal(rec.daemon, true);
    assert.equal('launched' in rec, false);
    await until(() => kit.children[0].written === TURN_LINE);
    assert.equal(srv.daemon.state().status, 'busy', 'the enqueue pokes the daemon');
  } finally {
    await srv.close();
    repo.cleanup();
  }
  const app = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'dashboard', 'app.js'), 'utf8');
  assert.match(app, /const API_VERSION = 4;/);
  assert.doesNotMatch(app, /launcher|launched/);
});
