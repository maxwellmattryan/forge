import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { broadcast, distAllowlist, startServer } from '../lib/server.ts';
import { TURN_LINE } from '../lib/daemon.ts';
import * as yaml from '../lib/yaml.ts';
import { API_VERSION as DASH_API_VERSION } from '../dashboard/src/lib/types.ts';
import { API_VERSION } from '../lib/schema.ts';

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

/** @param {number} port @param {string} path @param {string} [host] @returns {Promise<{status:number|undefined, type:string|undefined, headers:http.IncomingHttpHeaders, body:Buffer}>} */
function get(port, path, host = `127.0.0.1:${port}`): any {
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

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'dist');
const NOT_BUILT = 'dashboard is not built: run npm run build:dashboard';

test('dashboard server serves the page no-store and only manifest-allowlisted dist assets', async () => {
  const repo = tempRepo();
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  try {
    for (const p of ['/', '/index.html']) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.type, 'text/html; charset=utf-8', p);
      assert.equal(r.headers['cache-control'], 'no-store', p);
      const html = r.body.toString('utf8');
      assert.ok(!html.includes('__FORGE_TOKEN__'), p);
      assert.match(html, /<meta name="forge-token" content="[0-9a-f]{32}" \/>/, p);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
    const files = Object.values(manifest).flatMap((/** @type {any} */ e: any) => [e.file, ...(e.css ?? []), ...(e.assets ?? [])]);
    assert.ok(files.some((f) => f.endsWith('.js')) && files.some((f) => f.endsWith('.css')));
    for (const f of files) {
      const r = await get(port, '/' + f);
      assert.equal(r.status, 200, f);
      assert.equal(r.type, f.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', f);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', f);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', f);
      assert.ok(r.body.equals(fs.readFileSync(path.join(DIST, f))), `${f} bytes`);
    }
    const real = files[0];
    const notFound = [
      '/app.js', '/util.js', '/budget.js', '/deps.js', '/screenshots.js', '/daemon.js',
      '/style.css', '/vite.config.mjs', '/build-stamp.mjs', '/manifest.json', '/build-stamp.json',
      '/dist/index.html', '/dashboard/dist/index.html', '/dashboard/app.js', '/assets', '/assets/',
      `/${real}.map`, `/${real}/`, `/${real}%00`, `/ASSETS/${real.slice('assets/'.length)}`,
      '/assets/..%2Fmanifest.json', '/..%2Flib%2Fserver.ts', '/../lib/server.ts', '/%2e%2e/lib/server.ts',
      '/lib.js', '/server.ts', '/index.js', '/package.json', '/node_modules/vite/package.json',
      '/src/lib/util.ts', '/dashboard/src/lib/util.ts', '/src/lib/types.ts', '/tsconfig.json', '/dashboard/tsconfig.json',
      '/src/main.ts', '/src/App.svelte', '/dashboard/src/App.svelte', '/src/lib/view.ts', '/svelte.config.mjs', '/dashboard/svelte.config.mjs',
    ];
    for (const p of notFound) assert.equal((await get(port, p)).status, 404, p);
    assert.equal((await get(port, '/' + real, `evil.example:${port}`)).status, 421);
  } finally {
    server.close();
    repo.cleanup();
  }
});

test('distAllowlist accepts only plain assets/*.js|css entries', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-dist-'));
  try {
    assert.equal(distAllowlist(tmp).size, 0, 'missing manifest');
    fs.writeFileSync(path.join(tmp, 'manifest.json'), '{not json');
    assert.equal(distAllowlist(tmp).size, 0, 'invalid JSON');
    fs.writeFileSync(path.join(tmp, 'manifest.json'), 'null');
    assert.equal(distAllowlist(tmp).size, 0, 'null manifest');
    const manifest = {
      'index.html': { file: 'assets/index-AbC_1.js', css: ['assets/index-x.y-2.css', '../lib/server.ts', 7], assets: ['assets/extra-3.js', null] },
      a: { file: '../lib/server.ts' },
      b: { file: '/etc/passwd' },
      c: { file: 'assets/../../x.js' },
      d: { file: 'assets/sub/x.js' },
      e: { file: 'assets/x.svg', css: ['assets/x.html'] },
      f: { file: 'index.html' },
      g: { file: 42, css: 'assets/notarray.css' },
      h: null,
      i: 'assets/str.js',
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
    const map = distAllowlist(tmp);
    assert.deepEqual([...map.keys()].sort(), ['/assets/extra-3.js', '/assets/index-AbC_1.js', '/assets/index-x.y-2.css']);
    assert.deepEqual(map.get('/assets/index-AbC_1.js'), { file: path.join(tmp, 'assets', 'index-AbC_1.js'), type: 'text/javascript; charset=utf-8' });
    assert.deepEqual(map.get('/assets/index-x.y-2.css'), { file: path.join(tmp, 'assets', 'index-x.y-2.css'), type: 'text/css; charset=utf-8' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('missing dist answers 503 for the page and keeps the API up', async () => {
  const repo = tempRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nodist-'));
  const { server, url } = await startServer(repo.dir, { port: 0, distDir: tmp });
  const port = Number(new URL(url).port);
  try {
    for (const p of ['/', '/index.html']) {
      const r = await get(port, p);
      assert.equal(r.status, 503, p);
      assert.match(r.type ?? '', /^text\/plain/, p);
      assert.equal(r.body.toString('utf8'), NOT_BUILT, p);
    }
    assert.equal((await get(port, '/assets/x.js')).status, 404);
    // index.html without a manifest is still not built, and serves nothing under /assets/.
    fs.writeFileSync(path.join(tmp, 'index.html'), '<!doctype html>');
    assert.equal((await get(port, '/')).status, 503);
    assert.equal((await get(port, '/api/state')).status, 200);
  } finally {
    server.close();
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
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
    for (const [rel, type, bytes] of [['screenshots/a.png', 'image/png', PNG], ['screenshots/b.jpg', 'image/jpeg', JPG], ['screenshots/c.webp', 'image/webp', WEBP], ['screenshots/nested/d.png', 'image/png', PNG]] as any) {
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

// ---- Daemon endpoints. Every pool here gets in-memory children: nothing real is spawned or signalled.

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

function fakeChildren() {
  const children = [];
  const spawn: any = (cmd, args, opts) => {
    const c: any = new EventEmitter();
    Object.assign(c, { cmd, args, opts, scope: opts.env.FORGE_DAEMON_SCOPE, pid: 4_100_000 + children.length, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), written: '' });
    c.stdin.on('data', (d) => (c.written += d.toString()));
    c.exit = (code, signal) => {
      if (c.exited) return;
      c.exited = true;
      c.stdout.end();
      c.stderr.end();
      c.emit('exit', code, signal);
      c.emit('close', code, signal);
    };
    c.line = (obj) => c.stdout.write(JSON.stringify(obj) + '\n');
    children.push(c);
    const live = children.filter((x) => !x.exited && x.scope === c.scope).length;
    if (live > kit.maxLive) kit.maxLive = live;
    return c;
  };
  const killTree = (c, signal) => setTimeout(() => c.exit(null, signal), 5);
  const kit = { children, maxLive: 0, of: (scope) => children.filter((c) => c.scope === scope), opts: { spawn, killTree, pollMs: 3_600_000, graceMs: 500 } };
  return kit;
}

/** @param {string} dir @param {Record<string, any>} daemon */
function writeConfig(dir, daemon) {
  fs.mkdirSync(path.join(dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 2, daemon }));
}

/** A job dir the pool and the server accept as an existing job. */
function seedJob(dir, id) {
  const d = path.join(dir, '.forge', 'jobs', id);
  fs.mkdirSync(d, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ schemaVersion: 3, id, title: id, stage: 'build', state: 'running', createdAt: now, updatedAt: now }));
  return id;
}

/** An SSE reader that collects parsed frames. @param {number} port @param {Record<string,string>} [headers] */
function sse(port, headers = {}, session = '_inbox'): any {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: `/api/events?session=${encodeURIComponent(session)}`, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
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

/** Queues a request the way the dashboard does, then pokes the pool. */
async function postRequest(port, body) {
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
  return hit(port, { method: 'POST', path: '/api/requests', headers: { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

test('per-session SSE is scoped, validated and slot-limited', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const jobA = seedJob(repo.dir, 'job-a');
  const kit = fakeChildren();
  const { url, pool, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts, ssePingMs: 50 });
  const port = Number(new URL(url).port);
  const open = [];
  try {
    const c = kit.children[0];
    assert.equal(c.scope, '_inbox');
    c.line({ type: 'system', subtype: 'init', session_id: pool.state().inbox.sessionId });
    c.line({ type: 'assistant', n: 1 });
    await until(() => pool.recent('_inbox').length >= 3);
    const buffered = pool.recent('_inbox');

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
    assert.equal(st.scope, '_inbox');
    assert.equal(st.running, true);
    const replay = a.frames.slice(2, 2 + buffered.length);
    assert.deepEqual(replay.map((f) => f.event), buffered.map(() => 'line'));
    assert.deepEqual(replay.map((f) => Number(f.id)), buffered.map((b) => b.offset), 'ids are line offsets');
    assert.deepEqual(replay.map((f) => f.data), buffered.map((b) => b.line));

    // A job session's stream gets only that session's state and lines.
    const forA = await sse(port, {}, jobA);
    open.push(forA);
    await until(() => forA.frames.length >= 2);
    assert.deepEqual(JSON.parse(forA.frames[1].data).scope, jobA);
    assert.equal(JSON.parse(forA.frames[1].data).status, 'off', 'an unknown session streams an off state');
    const r = await postRequest(port, { type: 'resume', job: jobA });
    assert.equal(r.status, 200);
    await until(() => kit.of(jobA).length === 1);
    kit.of(jobA)[0].line({ type: 'assistant', only: 'A' });
    await until(() => forA.frames.some((f) => f.event === 'line' && f.data === '{"type":"assistant","only":"A"}'));
    assert.ok(forA.frames.some((f) => f.event === 'state' && JSON.parse(f.data).status === 'busy'), "A's state changes reach A's stream");
    assert.ok(forA.frames.filter((f) => f.event === 'state').every((f) => JSON.parse(f.data).scope === jobA));
    c.line({ type: 'assistant', n: 2 });
    await until(() => a.frames.some((f) => f.event === 'line' && f.data === '{"type":"assistant","n":2}'));
    assert.ok(!a.frames.some((f) => f.data === '{"type":"assistant","only":"A"}'), "the inbox stream never sees A's lines");
    assert.ok(!forA.frames.some((f) => f.data === '{"type":"assistant","n":2}'), "A's stream never sees the inbox's lines");
    const aIds = forA.frames.filter((f) => f.event === 'line').map((f) => Number(f.id));
    assert.deepEqual(aIds, pool.recent(jobA).map((x) => x.offset).slice(-aIds.length));

    c.line({ type: 'result', subtype: 'success' });
    await until(() => a.frames.slice(2).some((f) => f.event === 'state' && JSON.parse(f.data).lastResultAt), 2000);
    await until(() => a.frames.some((f) => f.comment === 'ping'), 2000);
    const lines = a.frames.filter((f) => f.event === 'line').map((f) => Number(f.id));
    assert.deepEqual(lines, [...lines].sort((x, y) => x - y), 'ids increase');
    assert.equal(new Set(lines).size, lines.length);

    const n = buffered[1].offset;
    const b = await sse(port, { 'last-event-id': String(n) });
    open.push(b);
    await until(() => b.frames.filter((f) => f.event === 'line').length >= pool.recent('_inbox', n).length);
    assert.deepEqual(b.frames.filter((f) => f.event === 'line').map((f) => Number(f.id)), pool.recent('_inbox', n).map((x) => x.offset), 'only lines after Last-Event-ID');
    const ahead = await sse(port, { 'last-event-id': '999999999' });
    open.push(ahead);
    await until(() => ahead.frames.filter((f) => f.event === 'line').length === pool.recent('_inbox').length);

    c.line({ type: 'big', pad: 'x'.repeat(70 * 1024) });
    await until(() => a.frames.some((f) => f.data?.includes('forge-truncated')));
    const big = JSON.parse(a.frames.find((f) => f.data?.includes('forge-truncated')).data);
    assert.equal(big.originalType, 'big');
    assert.ok(big.bytes > 64 * 1024);

    for (const q of ['', '?session=', '?session=..%2Fx', '?session=--flag', `?session=${'a'.repeat(201)}`]) {
      const bad = await hit(port, { path: `/api/events${q}` });
      assert.equal(bad.status, 400, q);
      assert.ok(JSON.parse(bad.text).error);
    }
    const ev = '/api/events?session=_inbox';
    assert.equal((await hit(port, { path: ev, headers: { host: `evil.example:${port}` } })).status, 421);
    assert.equal((await hit(port, { path: ev, headers: { origin: 'http://evil.example' } })).status, 403);
    assert.equal((await hit(port, { path: ev, headers: { origin: 'null' } })).status, 403);
    // A no-cors cross-site request has no Origin; Fetch Metadata still names it.
    for (const site of ['cross-site', 'same-site']) assert.equal((await hit(port, { path: ev, headers: { 'sec-fetch-site': site } })).status, 403, site);
    const fm = await sse(port, { 'sec-fetch-site': 'same-origin' });
    open.push(fm);
    assert.equal(fm.status, 200);
    const same = await sse(port, { origin: `http://127.0.0.1:${port}` });
    open.push(same);
    assert.equal(same.status, 200);

    // The cap counts streams across every session.
    while (open.length < 7) open.push(await sse(port));
    open.push(await sse(port, {}, 'some-deleted-job'));
    assert.equal(open.at(-1).status, 200, "a deleted job's log stays viewable");
    const ninth = await hit(port, { path: `/api/events?session=${jobA}` });
    assert.equal(ninth.status, 503);
    assert.equal(ninth.text, 'too many event streams');
    assert.equal(JSON.parse((await hit(port, { path: '/api/state' })).text).daemons.clients, 8);
    open.pop().close();
    await until(() => true);
    await new Promise((res) => setTimeout(res, 50));
    const again = await sse(port, {}, jobA);
    open.push(again);
    assert.equal(again.status, 200, 'a freed slot is reusable');

    // Streams are recycled after sseMaxAgeMs, so idle clients can't hold slots forever.
    const other = tempRepo();
    const short = await startServer(other.dir, { port: 0, daemon: fakeChildren().opts, sseMaxAgeMs: 100 });
    const shortPort = Number(new URL(short.url).port);
    try {
      const s = await sse(shortPort);
      assert.equal(s.status, 200);
      await new Promise((res) => setTimeout(res, 400));
      assert.equal(JSON.parse((await hit(shortPort, { path: '/api/state' })).text).daemons.clients, 0, 'an old stream is ended, freeing its slot');
    } finally {
      await short.close();
      other.cleanup();
    }

    const ended = [];
    const stub = (writableLength) => ({ writableLength, write() {}, end() { ended.push(writableLength); } });
    const slow = stub(2 * 1024 * 1024);
    const fast = stub(10);
    const set = new Set([slow, fast]);
    broadcast(set, 'event: line\ndata: {}\n\n');
    assert.deepEqual(ended, [2 * 1024 * 1024], 'the slow client is ended');
    assert.deepEqual([...set], [fast]);
    const writes = [];
    const tagged = (name) => ({ writableLength: 0, write: (f) => writes.push([name, f]), end() {} });
    const map = new Map([[tagged('x'), 'job-x'], [tagged('y'), 'job-y']]);
    broadcast(map, 'frame', undefined, 'job-y');
    assert.deepEqual(writes, [['y', 'frame']], 'a scoped broadcast reaches only that session');
  } finally {
    for (const o of open) o.close();
    await close();
    repo.cleanup();
  }
});

test('session log history is paged and confined', async () => {
  const repo = tempRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  const dir = path.join(repo.dir, '.forge', 'runtime', 'daemons');
  const page = async (q, headers = {}) => {
    const r = await hit(port, { path: `/api/daemons/log?${q}`, headers });
    return { status: r.status, body: r.status === 200 || r.headers['content-type']?.startsWith('application/json') ? JSON.parse(r.text) : r.text, text: r.text };
  };
  try {
    assert.deepEqual((await page('session=job-a')).body, { scope: 'job-a', lines: [], start: 0, end: 0, more: false }, 'a missing log is an empty page');
    fs.mkdirSync(dir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 1500; i++) lines.push(JSON.stringify({ type: 'assistant', i }));
    lines.splice(700, 0, JSON.stringify({ type: 'huge', pad: 'z'.repeat(100 * 1024) }));
    const logBase = 5000;
    fs.writeFileSync(path.join(dir, 'job-a.log'), lines.join('\n') + '\n' + '{"type":"partial"');
    fs.writeFileSync(path.join(dir, 'job-a.json'), JSON.stringify({ logBase }));
    const offsets = [];
    let at = logBase;
    for (const l of lines) {
      offsets.push(at);
      at += Buffer.byteLength(l) + 1;
    }
    const first = (await page('session=job-a')).body;
    assert.equal(first.scope, 'job-a');
    assert.equal(first.end, at, 'ends at the last complete line');
    assert.ok(!first.lines.some((l) => l.line.includes('partial')), 'an unfinished last line is left out');
    assert.ok(first.lines.length <= 1000);
    assert.equal(first.more, true);
    for (const l of first.lines) if (!l.line.includes('forge-truncated')) assert.equal(l.offset, offsets[lines.indexOf(l.line)], `offset of ${l.line.slice(0, 30)}`);
    assert.equal(first.lines.at(-1).line, lines.at(-1), 'newest last');
    // Walk back to the start with `before`.
    const all = [...first.lines];
    let cur = first;
    let guard = 0;
    while (cur.more && guard++ < 20) {
      cur = (await page(`session=job-a&before=${cur.start}`)).body;
      assert.ok(cur.end <= all[0].offset);
      all.unshift(...cur.lines);
    }
    assert.equal(cur.more, false);
    assert.equal(all.length, lines.length);
    assert.deepEqual(all.map((l) => l.offset), offsets, 'every line once, in order, at its real offset');
    const huge = all[700];
    assert.deepEqual(JSON.parse(huge.line), { type: 'forge-truncated', originalType: 'huge', bytes: Buffer.byteLength(lines[700]) });
    assert.equal(huge.offset, offsets[700]);
    assert.deepEqual((await page(`session=job-a&before=${logBase}`)).body.lines, [], 'nothing before the current log');

    for (const q of ['session=', 'session=..%2Fx', 'session=--x', 'session=job-a&before=-1', 'session=job-a&before=abc']) assert.equal((await page(q)).status, 400, q);
    assert.equal((await page('session=job-a', { origin: 'http://evil.example' })).status, 403);
    assert.equal((await page('session=job-a', { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await hit(port, { path: '/api/daemons/log?session=job-a', headers: { host: `evil.example:${port}` } })).status, 421);
    // A <scope>.log symlink pointing outside the daemons dir serves nothing.
    fs.writeFileSync(path.join(outside, 'secret.log'), '{"type":"secret","token":"hunter2"}\n');
    fs.symlinkSync(path.join(outside, 'secret.log'), path.join(dir, 'job-b.log'));
    const escaped = await page('session=job-b');
    assert.equal(escaped.status, 404);
    assert.ok(!escaped.text.includes('hunter2'));
    fs.mkdirSync(path.join(dir, 'job-c.log'));
    assert.equal((await page('session=job-c')).status, 404, 'a non-file is refused');
    // A symlinked daemons dir moves nothing: the confinement root is the real .forge/runtime/daemons.
    const moved = path.join(outside, 'daemons');
    fs.mkdirSync(moved);
    fs.writeFileSync(path.join(moved, 'job-d.log'), '{"type":"moved","token":"hunter3"}\n');
    const other = tempRepo();
    try {
      fs.mkdirSync(path.join(other.dir, '.forge', 'runtime'), { recursive: true });
      fs.symlinkSync(moved, path.join(other.dir, '.forge', 'runtime', 'daemons'));
      const srv2 = await startServer(other.dir, { port: 0, daemon: fakeChildren().opts });
      try {
        const r = await hit(Number(new URL(srv2.url).port), { path: '/api/daemons/log?session=job-d' });
        assert.equal(r.status, 404);
        assert.ok(!r.text.includes('hunter3'));
      } finally {
        await srv2.close();
      }
    } finally {
      other.cleanup();
    }
  } finally {
    await close();
    repo.cleanup();
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a FIFO planted as a session record never hangs the server', { skip: process.platform === 'win32' && 'POSIX-only' }, async () => {
  const repo = tempRepo();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  const dir = path.join(repo.dir, '.forge', 'runtime', 'daemons');
  const open = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['fifo-a.json', 'fifo-b.json', 'fifo-b.log']) assert.equal(spawnSync('mkfifo', [path.join(dir, name)]).status, 0, name);
    fs.unlinkSync(path.join(dir, 'fifo-b.log'));
    fs.writeFileSync(path.join(dir, 'fifo-b.log'), '{"type":"ok"}\n');
    // A record that is a symlink to a real file is not followed either.
    fs.writeFileSync(path.join(repo.dir, 'elsewhere.json'), JSON.stringify({ logBase: 999, sessionId: '11111111-2222-3333-4444-555555555555' }));
    fs.symlinkSync(path.join(repo.dir, 'elsewhere.json'), path.join(dir, 'link-c.json'));
    fs.writeFileSync(path.join(dir, 'link-c.log'), '{"type":"ok"}\n');
    const t0 = Date.now();
    const s = await sse(port, {}, 'fifo-a');
    open.push(s);
    assert.equal(s.status, 200);
    await until(() => s.frames.some((f) => f.event === 'state'), 2000);
    assert.equal(JSON.parse(s.frames.find((f) => f.event === 'state').data).sessionId, null);
    const page = await hit(port, { path: '/api/daemons/log?session=fifo-b' });
    assert.equal(page.status, 200);
    assert.deepEqual(JSON.parse(page.text).lines.map((l) => l.offset), [0], 'a FIFO record counts as no record (logBase 0)');
    const linked = JSON.parse((await hit(port, { path: '/api/daemons/log?session=link-c' })).text);
    assert.equal(linked.lines[0].offset, 0, 'a symlinked record is not followed');
    assert.equal((await hit(port, { path: '/api/state' })).status, 200, 'the server still answers');
    assert.ok(Date.now() - t0 < 3000);
  } finally {
    for (const o of open) o.close();
    await close();
    repo.cleanup();
  }
});

test('POST /api/daemon is token, origin and JSON guarded', async () => {
  const repo = tempRepo();
  const kit = fakeChildren();
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

test('POST /api/daemon starts and stops one session', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const jobA = seedJob(repo.dir, 'job-a');
  const jobB = seedJob(repo.dir, 'job-b');
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: '/api/daemon', headers, body: JSON.stringify(body) });
    const keys = ['enabled', 'wanted', 'maxConcurrent', 'live', 'lastError', 'inbox', 'jobs', 'clients'];
    assert.equal((await post({ action: 'stop', scope: jobA }, { ...good, 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await post({ action: 'stop', scope: jobA }, { ...good, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post({ action: 'stop', scope: jobA }, { ...good, 'content-type': 'text/plain' })).status, 415);
    for (const scope of ['../x', '--flag', '', 7, 'a'.repeat(201)]) assert.equal((await post({ action: 'start', scope })).status, 400, String(scope));
    const unknown = await post({ action: 'start', scope: 'no-such-job' });
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.text), { error: 'no job no-such-job' });

    await postRequest(port, { type: 'resume', job: jobA });
    await postRequest(port, { type: 'resume', job: jobB });
    await until(() => kit.of(jobA).length === 1 && kit.of(jobB).length === 1);
    const stopA = await post({ action: 'stop', scope: jobA });
    assert.equal(stopA.status, 200);
    const pool = JSON.parse(stopA.text);
    assert.deepEqual(Object.keys(pool), keys, 'the reply is DaemonPoolState');
    assert.equal(pool.wanted, true, 'stopping one session leaves the pool wanted');
    assert.equal(pool.jobs[jobA].wanted, false);
    assert.equal(pool.jobs[jobA].running, false);
    assert.equal(kit.of(jobA)[0].exited, true);
    assert.equal(pool.jobs[jobB].running, true, 'B keeps running');
    assert.equal(pool.inbox.running, true, 'the inbox keeps running');
    // A stopped session spawns nothing for new work until it is started again.
    await postRequest(port, { type: 'answer', job: jobA, text: 'more' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(kit.of(jobA).length, 1);
    const startA = await post({ action: 'start', scope: jobA });
    assert.equal(startA.status, 200);
    await until(() => kit.of(jobA).length === 2);
    assert.equal(JSON.parse((await hit(port, { path: '/api/state' })).text).daemons.jobs[jobA].wanted, true);

    // Unscoped behaviour is unchanged; a scoped start needs a wanted pool.
    assert.equal((await post({ action: 'stop' })).status, 200);
    const refused = await post({ action: 'start', scope: jobA });
    assert.equal(refused.status, 409);
    assert.deepEqual(JSON.parse(refused.text), { error: 'start the daemon first' });
    assert.equal((await post({ action: 'stop', scope: '_inbox' })).status, 200, 'the inbox is a valid scope');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('/api/state exposes the session pool', async () => {
  const repo = tempRepo();
  const keys = ['enabled', 'wanted', 'maxConcurrent', 'live', 'lastError', 'inbox', 'jobs', 'clients'];
  const sessionKeys = ['scope', 'wanted', 'running', 'status', 'sessionId', 'pid', 'lastTurnAt', 'lastResultAt', 'turns', 'failures', 'held', 'waiting', 'lastError'];
  const kitOff = fakeChildren();
  let srv = await startServer(repo.dir, { port: 0, daemon: kitOff.opts });
  try {
    const s = JSON.parse((await hit(Number(new URL(srv.url).port), { path: '/api/state' })).text);
    assert.equal(s.apiVersion, API_VERSION);
    assert.equal(s.apiVersion, DASH_API_VERSION);
    assert.deepEqual(s.config.daemon, { enabled: false });
    assert.equal('launcher' in s.config, false);
    assert.equal('daemon' in s, false, 'no top-level daemon key any more');
    assert.deepEqual(Object.keys(s.daemons), keys);
    assert.deepEqual(Object.keys(s.daemons.inbox), sessionKeys);
    assert.equal(s.daemons.inbox.scope, '_inbox');
    assert.equal(s.daemons.inbox.running, false);
    assert.deepEqual(s.daemons.jobs, {});
    assert.equal(kitOff.children.length, 0, 'disabled: nothing is spawned');
  } finally {
    await srv.close();
  }

  writeConfig(repo.dir, { enabled: true, command: 'claude {session}', maxConcurrent: 2 });
  const jobA = seedJob(repo.dir, 'job-a');
  const kit = fakeChildren();
  srv = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(srv.url).port);
  try {
    const s = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.deepEqual(s.config.daemon, { enabled: true });
    assert.deepEqual(Object.keys(s.daemons), keys);
    assert.equal(s.daemons.enabled, true);
    assert.equal(s.daemons.maxConcurrent, 2);
    assert.equal(s.daemons.inbox.running, true, 'an enabled pool starts its inbox with the server, no request needed');
    assert.equal(s.daemons.inbox.status, 'idle');
    assert.equal(kit.children.length, 1);

    const r = await postRequest(port, { type: 'next' });
    assert.equal(r.status, 200);
    const rec = JSON.parse(r.text);
    assert.equal(rec.daemon, true);
    assert.equal('launched' in rec, false);
    await until(() => kit.children[0].written === TURN_LINE);
    assert.equal(srv.pool.state().inbox.status, 'busy', 'the enqueue pokes the pool');
    await postRequest(port, { type: 'resume', job: jobA });
    await until(() => kit.of(jobA).length === 1);
    const s2 = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.deepEqual(Object.keys(s2.daemons.jobs), [jobA]);
    assert.deepEqual(Object.keys(s2.daemons.jobs[jobA]), sessionKeys);
    assert.equal(s2.daemons.live, 1);
  } finally {
    await srv.close();
    repo.cleanup();
  }
  const src = path.resolve(import.meta.dirname, '..', 'dashboard', 'src');
  const app = fs
    .readdirSync(src, { recursive: true })
    .map(String)
    .filter((f) => /\.(ts|svelte)$/.test(f))
    .map((f) => fs.readFileSync(path.join(src, f), 'utf8'))
    .join('\n');
  assert.ok(app.includes('/api/requests'), 'read the dashboard sources');
  assert.equal(DASH_API_VERSION, 8, 'the dashboard reads API_VERSION from src/lib/types.ts');
  assert.doesNotMatch(app, /launcher|launched/);
});

// ---- Settings endpoints: /api/config, /api/doctor, /api/about.

const tokenOf = async (port) => /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];

test('POST /api/config is token, origin and JSON guarded', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: false });
  const file = path.join(repo.dir, '.forge', 'config.yml');
  const before = fs.readFileSync(file);
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
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

test('/api/config reads the schema and writes only editable keys', async () => {
  const { FIELDS } = await import('../lib/config-fields.ts');
  const bare = tempRepo();
  let srv = await startServer(bare.dir, { port: 0, daemon: fakeChildren().opts });
  try {
    const c = JSON.parse((await hit(Number(new URL(srv.url).port), { path: '/api/config' })).text);
    assert.equal(c.initialized, false);
    assert.equal(c.writable, false);
    assert.equal(c.lockedBy, 'uninitialized');
  } finally {
    await srv.close();
    bare.cleanup();
  }

  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: false });
  const file = path.join(repo.dir, '.forge', 'config.yml');
  srv = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  let port = Number(new URL(srv.url).port);
  const post = async (body) => {
    const headers = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const r = await hit(port, { method: 'POST', path: '/api/config', headers, body: JSON.stringify(body) });
    return { status: r.status, body: JSON.parse(r.text) };
  };
  try {
    const r = await hit(port, { path: '/api/config' });
    assert.equal(r.status, 200);
    const c = JSON.parse(r.text);
    assert.equal(c.initialized, true);
    assert.equal(c.path, '.forge/config.yml');
    assert.equal(c.writable, true);
    assert.equal(c.lockedBy, null);
    assert.deepEqual(c.fields.map((f) => f.key), FIELDS.map((f) => f.key));
    assert.deepEqual(Object.keys(c.values), FIELDS.map((f) => f.key));
    assert.equal(c.values['pipeline.maxRounds'], 3);
    assert.deepEqual(c.problems, []);

    const ok = await post({ key: 'pipeline.maxRounds', value: 4 });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, { ok: true, key: 'pipeline.maxRounds', value: 4, previous: 3, changed: true });
    const settled = fs.readFileSync(file);
    const again = await post({ key: 'pipeline.maxRounds', value: 4 });
    assert.deepEqual(again.body, { ok: true, key: 'pipeline.maxRounds', value: 4, previous: 4, changed: false });
    assert.ok(fs.readFileSync(file).equals(settled), 'a no-op POST writes nothing');
    assert.equal(JSON.parse((await hit(port, { path: '/api/state' })).text).config.pipeline.maxRounds, 4);

    const before = fs.readFileSync(file);
    const locked = await post({ key: 'daemon.command', value: 'claude {session}' });
    assert.equal(locked.status, 403);
    assert.match(locked.body.error, /is not editable/);
    assert.equal((await post({ key: 'nope.key', value: 1 })).status, 400);
    const typed = await post({ key: 'pipeline.maxRounds', value: '4' });
    assert.equal(typed.status, 400, 'values arrive typed; a string is not an integer');
    assert.match(typed.body.error, /pipeline\.maxRounds/);
    assert.ok(fs.readFileSync(file).equals(before), 'refusals leave the file unchanged');
    fs.writeFileSync(file, 'schemaVersion: 2\npipeline: { maxRounds: 4 }\n');
    const flow = await post({ key: 'pipeline.maxRounds', value: 5 });
    assert.equal(flow.status, 409, 'unsupported-yaml');
    assert.match(flow.body.error, /edit it by hand/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'schemaVersion: 2\npipeline: { maxRounds: 4 }\n');
  } finally {
    await srv.close();
  }

  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const kit = fakeChildren();
  srv = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  port = Number(new URL(srv.url).port);
  try {
    assert.equal(srv.pool.state().wanted, true);
    const c = JSON.parse((await hit(port, { path: '/api/config' })).text);
    assert.equal(c.lockedBy, 'daemon');
    assert.equal(c.writable, false);
    const before = fs.readFileSync(file);
    const busy = await post({ key: 'pipeline.maxRounds', value: 5 });
    assert.equal(busy.status, 409);
    assert.match(busy.body.error, /stop the daemon first/);
    assert.ok(fs.readFileSync(file).equals(before));
    const headers = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    assert.equal((await hit(port, { method: 'POST', path: '/api/daemon', headers, body: '{"action":"stop"}' })).status, 200);
    const after = await post({ key: 'pipeline.maxRounds', value: 5 });
    assert.equal(after.status, 200);
    assert.equal(after.body.changed, true);
  } finally {
    await srv.close();
    repo.cleanup();
  }
});

test('GET /api/doctor runs forge doctor behind the token', async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 2, pr: { enabled: false }, tracker: { kind: 'local' } }));
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    assert.equal((await hit(port, { path: '/api/doctor' })).status, 403, 'no token');
    const token = await tokenOf(port);
    assert.equal((await hit(port, { path: '/api/doctor', headers: { 'x-forge-token': token, origin: 'http://evil.example' } })).status, 403, 'foreign origin');
    const r = await hit(port, { path: '/api/doctor', headers: { 'x-forge-token': token } });
    assert.equal(r.status, 200);
    const d = JSON.parse(r.text);
    assert.deepEqual(Object.keys(d), ['ok', 'checks', 'at']);
    assert.equal(typeof d.ok, 'boolean');
    assert.ok(!Number.isNaN(Date.parse(d.at)));
    for (const c of d.checks) assert.deepEqual(Object.keys(c), ['name', 'ok', 'detail']);
    const names = d.checks.map((c) => c.name);
    assert.ok(names.includes('config present') && names.includes('node >= 22.18'), names.join(', '));
    const cli = JSON.parse(execFileSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'bin', 'forge'), 'doctor'], { encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } }));
    assert.deepEqual(Object.keys(cli), ['ok', 'checks'], 'forge doctor still prints {ok, checks}');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('GET /api/about reports versions', async () => {
  const schema = await import('../lib/schema.ts');
  const { PLUGIN_ROOT } = await import('../lib/paths.ts');
  const root = path.resolve(import.meta.dirname, '..');
  const repo = tempRepo();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  try {
    const r = await hit(Number(new URL(url).port), { path: '/api/about' });
    assert.equal(r.status, 200);
    const a = JSON.parse(r.text);
    assert.equal(a.forgeVersion, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    assert.equal(a.apiVersion, 8);
    assert.equal(a.pluginRoot, PLUGIN_ROOT);
    assert.deepEqual(a.schemaVersions, { config: schema.CONFIG_SCHEMA_VERSION, job: schema.JOB_SCHEMA_VERSION, event: schema.EVENT_SCHEMA_VERSION });
    assert.equal(a.pricingAsOf, JSON.parse(fs.readFileSync(path.join(root, 'lib', 'pricing.json'), 'utf8')).asOf);
    assert.equal(a.node, process.versions.node);
    assert.deepEqual(a.links, { repo: 'https://github.com/maxwellmattryan/forge', docs: 'https://github.com/maxwellmattryan/forge/tree/main/docs' });
  } finally {
    await close();
    repo.cleanup();
  }
});

// ---- New jobs from the dashboard: POST /api/jobs, request args, a job's requests.

const postJson = async (port, path, body, headers: Record<string, string> = {}) => {
  const token = await tokenOf(port);
  return hit(port, { method: 'POST', path, headers: { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
};
const jobsIn = (dir) => (fs.existsSync(path.join(dir, '.forge', 'jobs')) ? fs.readdirSync(path.join(dir, '.forge', 'jobs')) : []);

test('POST /api/jobs creates the job and queues its resume', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: false });
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const text = 'Please add a reading-time badge. It shows minutes, like `5 min`.';
    const r = await postJson(port, '/api/jobs', { text });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.deepEqual(Object.keys(body), ['id', 'title', 'branch', 'request', 'daemon']);
    assert.equal(body.title, 'Add a reading-time badge');
    assert.match(body.id, /^add-a-reading-time-badge-[a-z0-9]+$/);
    assert.equal(body.branch, `forge/${body.id}`);
    assert.equal(body.daemon, false);
    const dir = path.join(repo.dir, '.forge', 'jobs', body.id);
    assert.equal(fs.readFileSync(path.join(dir, 'request.md'), 'utf8'), `# Add a reading-time badge\n\n${text}\n`);
    const created = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'created');
    assert.equal(created.origin, 'dashboard');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).title, 'Add a reading-time badge');
    const { request } = body;
    assert.deepEqual([request.type, request.job, request.text, request.args, request.from, request.status], ['resume', body.id, null, { intake: 'new' }, 'dashboard', 'pending']);
    const queued = JSON.parse((await hit(port, { path: '/api/requests' })).text);
    assert.deepEqual(queued, [request], 'exactly the one resume is queued');

    const titled = JSON.parse((await postJson(port, '/api/jobs', { text: 'whatever the text says', title: '  My\tcustom\n title ' })).text);
    assert.equal(titled.title, 'My custom title', 'a title override wins, cleaned');
    assert.match(titled.id, /^my-custom-title-/);

    const unslugged = await postJson(port, '/api/jobs', { text: '日本語のテキスト' });
    assert.equal(unslugged.status, 200);
    const u = JSON.parse(unslugged.text);
    assert.equal(u.title, '日本語のテキスト');
    assert.match(u.id, /^request-[a-z0-9]+$/, 'an empty slug still yields a valid id');
    assert.ok(fs.existsSync(path.join(repo.dir, '.forge', 'jobs', u.id, 'job.json')));
  } finally {
    await close();
    repo.cleanup();
  }
});

test('POST /api/jobs is guarded and validated', async () => {
  const repo = tempRepo();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const ok = { text: 'Add dark mode' };
    const uninit = await postJson(port, '/api/jobs', ok);
    assert.equal(uninit.status, 409);
    assert.match(JSON.parse(uninit.text).error, /init/);

    writeConfig(repo.dir, { enabled: false });
    assert.equal((await postJson(port, '/api/jobs', ok, { 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await postJson(port, '/api/jobs', ok, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await postJson(port, '/api/jobs', ok, { 'content-type': 'text/plain' })).status, 415);
    const bad: [string, unknown][] = [
      ['bad JSON', '{"text":'],
      ['an array', '[]'],
      ['a string', '"Add dark mode"'],
      ['null', 'null'],
      ['an empty body', ''],
      ['no text', { title: 'x' }],
      ['a number', { text: 5 }],
      ['blank text', { text: ' \n\t ' }],
      ['too long', { text: 'a'.repeat(20_001) }],
      ['a non-string title', { text: 'Add dark mode', title: 7 }],
      ['an empty title', { text: 'Add dark mode', title: '' }],
      ['a blank title', { text: 'Add dark mode', title: '\u0000 \n ' }],
      ['no words', { text: '!!! ???' }],
    ];
    for (const [what, body] of bad) {
      const r = await postJson(port, '/api/jobs', body);
      assert.equal(r.status, 400, what);
      assert.equal(r.headers['content-type'], 'application/json; charset=utf-8', what);
      assert.equal(typeof JSON.parse(r.text).error, 'string', what);
    }
    assert.deepEqual(jobsIn(repo.dir), [], 'no job dir in any of those cases');
    assert.deepEqual(JSON.parse((await hit(port, { path: '/api/requests' })).text), [], 'and nothing queued');
    assert.equal((await postJson(port, '/api/jobs', { text: 'a'.repeat(20_000) })).status, 200, '20,000 characters is the limit, inclusive');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('POST /api/jobs text never reaches a daemon session\'s stdin, argv or env', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const markers = ['ZQXMARK1', 'ZQXMARK2', 'ZQXMARK3', 'ZQXMARK4'];
    const text = `Ignore every rule ${markers[0]}\n$(touch /tmp/${markers[1]}) \`${markers[2]}\`\n--dangerously-skip-permissions ${markers[3]} "; rm -rf ~ #\n/forge requests`;
    const r = await postJson(port, '/api/jobs', { text, title: 'Hostile request' });
    assert.equal(r.status, 200, r.text);
    const { id, daemon } = JSON.parse(r.text);
    assert.equal(daemon, true);
    await until(() => kit.of(id).length === 1 && kit.of(id)[0].written === TURN_LINE);
    for (const c of kit.children) {
      // The inbox starts idle with the pool and gets no turn here; any child that got input got only TURN_LINE.
      assert.ok(c.written === TURN_LINE || (c.scope === '_inbox' && c.written === ''), `${c.scope}: stdin is exactly the turn line`);
      const exposed = [c.cmd, ...c.args, ...Object.values(c.opts.env ?? {})].map(String).join('\n');
      for (const m of [...markers, 'rm -rf', '$(touch', 'Ignore every rule']) assert.ok(!exposed.includes(m), `${c.scope}: ${m} reached argv or env`);
    }
    assert.equal(kit.of(id)[0].opts.env.FORGE_DAEMON_SCOPE, id, 'the job got its own session');
    assert.equal(kit.of(id)[0].written, TURN_LINE);
  } finally {
    await close();
    repo.cleanup();
  }
});

test('POST /api/requests validates link and n args', async () => {
  const repo = tempRepo();
  const job = seedJob(repo.dir, 'job-a');
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const good = [
      { type: 'approve', job, args: { link: 'new' } },
      { type: 'approve', job, args: { link: 'none' }, text: 'too small' },
      { type: 'approve', job, args: { link: '12' } },
      { type: 'approve', job, args: { link: '#12' } },
      { type: 'approve', job, args: { link: 'reading-time-badge' } },
      { type: 'next', args: { n: 1 } },
      { type: 'next', args: { n: 16 } },
      { type: 'next', args: {} },
    ];
    for (const body of good) {
      const r = await postJson(port, '/api/requests', body);
      assert.equal(r.status, 200, `${JSON.stringify(body)}: ${r.text}`);
      assert.deepEqual(JSON.parse(r.text).args, body.args, 'queued as sent');
    }
    const bad = [
      { type: 'answer', job, args: { link: 'new' }, text: 'x' },
      { type: 'next', args: { link: 'new' } },
      { type: 'approve', job, args: { link: '../etc' } },
      { type: 'approve', job, args: { link: '' } },
      { type: 'approve', job, args: { link: 12 } },
      { type: 'approve', job, args: { link: 'a'.repeat(101) } },
      { type: 'next', args: { n: 0 } },
      { type: 'next', args: { n: 17 } },
      { type: 'next', args: { n: 2.5 } },
      { type: 'next', args: { n: '3' } },
      { type: 'sync', args: { n: 2 } },
    ];
    for (const body of bad) {
      const r = await postJson(port, '/api/requests', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof JSON.parse(r.text).error, 'string');
    }
    const parse = await postJson(port, '/api/requests', '{"type":');
    assert.equal(parse.status, 400, 'bad JSON is a 400, not a 500');
    assert.deepEqual(JSON.parse(parse.text), { error: 'body is not JSON' });
    assert.equal(JSON.parse((await hit(port, { path: '/api/requests' })).text).length, good.length, 'only the valid ones were queued');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('job detail lists the job\'s requests', async () => {
  const repo = tempRepo();
  const a = seedJob(repo.dir, 'job-a');
  const b = seedJob(repo.dir, 'job-b');
  const { enqueue, claimRequest, ackRequest } = await import('../lib/requests.ts');
  const ids: string[] = [];
  for (let i = 0; i < 55; i++) {
    ids.push(enqueue(repo.dir, null, { type: 'answer', job: a, text: `answer ${i}`, from: 'dashboard' }).id);
    // Distinct milliseconds keep the id order the creation order.
    const t = Date.now();
    while (Date.now() === t);
  }
  enqueue(repo.dir, null, { type: 'answer', job: b, text: 'other job', from: 'dashboard' });
  enqueue(repo.dir, null, { type: 'next', from: 'dashboard' });
  claimRequest(repo.dir, ids[53], 's1');
  ackRequest(repo.dir, ids[54], { status: 'done', result: 'answered' });
  ackRequest(repo.dir, ids[52], { status: 'rejected', result: 'no' });
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const detail = JSON.parse((await hit(port, { path: `/api/jobs/${a}` })).text);
    assert.equal(detail.requests.length, 50, 'capped at 50');
    assert.deepEqual(detail.requests.map((r) => r.id), ids.slice(-50), 'the newest 50, oldest first');
    assert.ok(detail.requests.every((r) => r.job === a));
    assert.deepEqual(detail.requests.slice(-3).map((r) => [r.status, r.result ?? null]), [['rejected', 'no'], ['in-progress', null], ['done', 'answered']], 'every status');
    const other = JSON.parse((await hit(port, { path: `/api/jobs/${b}` })).text);
    assert.deepEqual(other.requests.map((r) => r.text), ['other job']);
  } finally {
    await close();
    repo.cleanup();
  }
});
