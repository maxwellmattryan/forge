import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { budgetRepo } from './repo-budget-fixture.ts';
import { twoRepo } from './job-repos-fixture.ts';
import { broadcast, distAllowlist, distDirFor, startServer as serve } from '../lib/server.ts';
import { FIXTURE_DIST } from './dist.ts';
import { DEV_DIST_DIR } from '../lib/paths.ts';
import { TURN_LINE } from '../lib/daemon.ts';
import * as yaml from '../lib/yaml.ts';
import { API_VERSION as DASH_API_VERSION } from '../dashboard/src/lib/types.ts';
import { API_VERSION, sanitizeLogin } from '../lib/schema.ts';

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

const DIST = FIXTURE_DIST;
const NOT_BUILT = 'dashboard is not built: run npm ci && npm run build:dashboard';
const DEV_NOT_BUILT = 'dashboard dev build is not ready: npm run dev is still building it; reload in a moment';

/** Paths the dist allowlist must answer 404 for, given one real manifest file `real`. */
function notFoundPaths(real: string): string[] {
  return [
    '/app.js', '/util.js', '/budget.js', '/deps.js', '/screenshots.js', '/daemon.js',
    '/style.css', '/vite.config.mjs', '/build-stamp.mjs', '/manifest.json', '/build-stamp.json',
    '/dist/index.html', '/dashboard/dist/index.html', '/dashboard/app.js', '/assets', '/assets/',
    `/${real}.map`, `/${real}/`, `/${real}%00`, `/ASSETS/${real.slice('assets/'.length)}`,
    '/assets/..%2Fmanifest.json', '/..%2Flib%2Fserver.ts', '/../lib/server.ts', '/%2e%2e/lib/server.ts',
    '/lib.js', '/server.ts', '/index.js', '/package.json', '/node_modules/vite/package.json',
    '/src/lib/util.ts', '/dashboard/src/lib/util.ts', '/src/lib/types.ts', '/tsconfig.json', '/dashboard/tsconfig.json',
    '/fonts/IBMPlexSans-400.woff2', '/dashboard/fonts/OFL.txt', '/fonts/README.md', '/textures/paper.svg', '/dashboard/textures/paper.svg',
    '/src/main.ts', '/src/App.svelte', '/dashboard/src/App.svelte', '/src/lib/view.ts', '/svelte.config.mjs', '/dashboard/svelte.config.mjs',
  ];
}

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
      assert.equal(r.type, f.endsWith('.js') ? 'text/javascript; charset=utf-8' : f.endsWith('.woff2') ? 'font/woff2' : 'text/css; charset=utf-8', f);
      assert.equal(r.headers['cache-control'], 'public, max-age=31536000, immutable', f);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', f);
      assert.ok(r.body.equals(fs.readFileSync(path.join(DIST, f))), `${f} bytes`);
    }
    const real = files[0];
    for (const p of notFoundPaths(real)) assert.equal((await get(port, p)).status, 404, p);
    assert.equal((await get(port, '/' + real, `evil.example:${port}`)).status, 421);
  } finally {
    server.close();
    repo.cleanup();
  }
});

test('distAllowlist accepts only plain assets/*.js|css|woff2 entries', () => {
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
      e: { file: 'assets/x.svg', css: ['assets/x.html'], assets: ['assets/x.woff', 'assets/x.ttf', 'assets/x.woff2.svg'] },
      fonts: { file: 'assets/Plex-400-a_B.woff2' },
      f: { file: 'index.html' },
      g: { file: 42, css: 'assets/notarray.css' },
      h: null,
      i: 'assets/str.js',
    };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest));
    const map = distAllowlist(tmp);
    assert.deepEqual([...map.keys()].sort(), ['/assets/Plex-400-a_B.woff2', '/assets/extra-3.js', '/assets/index-AbC_1.js', '/assets/index-x.y-2.css']);
    assert.deepEqual(map.get('/assets/Plex-400-a_B.woff2'), { file: path.join(tmp, 'assets', 'Plex-400-a_B.woff2'), type: 'font/woff2' });
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

test('serves job HTML at /raw under a no-network sandbox CSP', async () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
  const forge = (...args) => JSON.parse(execFileSync(process.execPath, [bin, ...args], { cwd: repo.dir, encoding: 'utf8', env }));
  forge('init', 'write');
  const job = forge('job', 'new', '--title', 'Mockup');
  const html = '<style>p{color:red}</style><p id=o></p><script>o.textContent="ok";fetch("https://example.com")</script><img src="https://example.com/x.png">';
  fs.writeFileSync(path.join(repo.dir, job.dir, 'mockup.html'), html);
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  try {
    const r = await get(port, `/api/jobs/${job.id}/raw?path=mockup.html`);
    assert.equal(r.status, 200);
    assert.equal(r.type, 'text/html; charset=utf-8');
    assert.ok(r.body.equals(Buffer.from(html)));
    const csp = r.headers['content-security-policy'];
    assert.equal(csp, "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:");
    assert.ok(csp.includes('sandbox allow-scripts'));
    assert.ok(csp.includes("default-src 'none'"));
    for (const loose of ['connect-src', 'http', '*', "'self'"]) assert.ok(!csp.includes(loose), loose);
  } finally {
    server.close();
    repo.cleanup();
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

// ---- `forge dash --dev`: the dev build behind the same guards.

test('dev mode serves the dev build behind the same guards', async () => {
  const repo = tempRepo();
  // A copy of the real build stands in for the dev dir: a test never writes the real DEV_DIST_DIR.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devdist-'));
  fs.cpSync(DIST, tmp, { recursive: true });
  // One file the manifest doesn't name, so serving by directory would show.
  fs.writeFileSync(path.join(tmp, 'assets', 'stray-1.js'), 'stray');
  const { url, close } = await startServer(repo.dir, { port: 0, dev: true, distDir: tmp, daemon: fakeChildren().opts });
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
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8'));
    const files: string[] = Object.values(manifest).flatMap((e: any) => [e.file, ...(e.css ?? []), ...(e.assets ?? [])]);
    const served = new Set(files.map((f) => '/' + f));
    for (const f of fs.readdirSync(path.join(tmp, 'assets'))) {
      const r = await get(port, `/assets/${f}`);
      assert.equal(r.status, served.has(`/assets/${f}`) ? 200 : 404, f);
      if (r.status === 200) assert.ok(r.body.equals(fs.readFileSync(path.join(tmp, 'assets', f))), `${f} bytes`);
    }
    assert.equal((await get(port, '/assets/stray-1.js')).status, 404, 'only manifest-listed files');
    for (const p of notFoundPaths(files[0])) assert.equal((await get(port, p)).status, 404, p);
    assert.equal((await get(port, '/', `evil.example:${port}`)).status, 421);
    assert.equal((await get(port, '/' + files[0], `evil.example:${port}`)).status, 421);

    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (headers) => hit(port, { method: 'POST', path: '/api/requests', headers, body: '{"type":"sync"}' });
    const { 'x-forge-token': _t, ...noToken } = good;
    assert.equal((await post(noToken)).status, 403);
    assert.equal((await post({ ...good, 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await post({ ...good, origin: 'http://evil.example' })).status, 403);
    const { origin: _o, ...noOrigin } = good;
    assert.equal((await post(noOrigin)).status, 403);
    assert.equal((await post({ ...good, 'content-type': 'text/plain' })).status, 415);
  } finally {
    await close();
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dev mode defaults to the gitignored dev build dir', () => {
  const plugin = path.resolve(import.meta.dirname, '..');
  assert.equal(distDirFor({}), path.join(plugin, 'dashboard', 'dist'));
  assert.equal(DEV_DIST_DIR, path.join(plugin, 'node_modules', '.cache', 'forge', 'dashboard-dev'));
  assert.equal(distDirFor({ dev: true }), DEV_DIST_DIR);
  assert.equal(distDirFor({ dev: true, distDir: '/x/y' }), '/x/y');
  assert.equal(distDirFor({ distDir: '/x/y' }), '/x/y');
});

test('dev mode not-built message', async () => {
  const repo = tempRepo();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-devnodist-'));
  const dev = await startServer(repo.dir, { port: 0, dev: true, distDir: tmp, daemon: fakeChildren().opts });
  const plain = await startServer(repo.dir, { port: 0, distDir: tmp, daemon: fakeChildren().opts });
  try {
    for (const [srv, text] of [[dev, DEV_NOT_BUILT], [plain, NOT_BUILT]] as const) {
      const port = Number(new URL(srv.url).port);
      for (const p of ['/', '/index.html']) {
        const r = await get(port, p);
        assert.equal(r.status, 503, p);
        assert.match(r.type ?? '', /^text\/plain/, p);
        assert.equal(r.headers['cache-control'], 'no-store', p);
        assert.equal(r.body.toString('utf8'), text, p);
      }
      assert.equal((await get(port, '/api/state')).status, 200);
    }
  } finally {
    await dev.close();
    await plain.close();
    repo.cleanup();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('dev mode leaves the daemon off until Start', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const kit = fakeChildren();
  const srv = await startServer(repo.dir, { port: 0, dev: true, distDir: DIST, daemon: kit.opts });
  const port = Number(new URL(srv.url).port);
  try {
    // Give a boot start every chance to happen before checking it didn't.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(kit.children.length, 0, 'no child at boot in dev mode');
    const s = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(s.daemons.wanted, false);
    assert.equal(s.daemons.inbox.running, false);
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const started = await hit(port, { method: 'POST', path: '/api/daemon', headers, body: '{"action":"start"}' });
    assert.equal(started.status, 200);
    assert.equal(JSON.parse(started.text).wanted, true);
    assert.equal(kit.children.length, 1);
    assert.equal(kit.children[0].scope, '_inbox');
  } finally {
    await srv.close();
  }
  // The control: the same setup without dev boots the inbox, as it always has.
  const ctl = fakeChildren();
  const plain = await startServer(repo.dir, { port: 0, distDir: DIST, daemon: ctl.opts });
  try {
    await until(() => ctl.children.length === 1);
    assert.equal(ctl.children[0].scope, '_inbox');
    assert.equal(JSON.parse((await hit(Number(new URL(plain.url).port), { path: '/api/state' })).text).daemons.wanted, true);
  } finally {
    await plain.close();
    repo.cleanup();
  }
});

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
    // Prefix matches: the supervisor appends a receipt-time `at` to lines without a timestamp.
    kit.of(jobA)[0].line({ type: 'assistant', only: 'A' });
    await until(() => forA.frames.some((f) => f.event === 'line' && f.data.startsWith('{"type":"assistant","only":"A"')));
    assert.ok(forA.frames.some((f) => f.event === 'state' && JSON.parse(f.data).status === 'busy'), "A's state changes reach A's stream");
    assert.ok(forA.frames.filter((f) => f.event === 'state').every((f) => JSON.parse(f.data).scope === jobA));
    c.line({ type: 'assistant', n: 2 });
    await until(() => a.frames.some((f) => f.event === 'line' && f.data.startsWith('{"type":"assistant","n":2')));
    assert.ok(!a.frames.some((f) => f.event === 'line' && f.data.startsWith('{"type":"assistant","only":"A"')), "the inbox stream never sees A's lines");
    assert.ok(!forA.frames.some((f) => f.event === 'line' && f.data.startsWith('{"type":"assistant","n":2')), "A's stream never sees the inbox's lines");
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

test('session log history reads the rotated generation', async () => {
  const repo = tempRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  const dir = path.join(repo.dir, '.forge', 'runtime', 'daemons');
  const page = async (q) => {
    const r = await hit(port, { path: `/api/daemons/log?${q}` });
    return { status: r.status, body: r.status === 200 ? JSON.parse(r.text) : null, text: r.text };
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const older = Array.from({ length: 1500 }, (_, i) => JSON.stringify({ type: 'old', i }));
    const newer = Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'new', i }));
    const text1 = older.join('\n') + '\n';
    const start1 = 3000;
    const logBase = start1 + Buffer.byteLength(text1);
    fs.writeFileSync(path.join(dir, 'job-r.log.1'), text1);
    fs.writeFileSync(path.join(dir, 'job-r.log'), newer.join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'job-r.json'), JSON.stringify({ logBase }));
    const offsets = [];
    let at = start1;
    for (const l of [...older, ...newer]) {
      offsets.push(at);
      at += Buffer.byteLength(l) + 1;
    }
    let cur = (await page('session=job-r')).body;
    assert.equal(cur.start, logBase, 'the first page reaches the start of .log');
    assert.equal(cur.more, true, 'a non-empty .log.1 means more');
    const all = [...cur.lines];
    let guard = 0;
    while (cur.more && guard++ < 20) {
      cur = (await page(`session=job-r&before=${cur.start}`)).body;
      all.unshift(...cur.lines);
    }
    assert.equal(cur.more, false, 'no more at the start of .log.1');
    assert.equal(cur.start, start1);
    assert.deepEqual(all.map((l) => l.line), [...older, ...newer], 'every line once, in order');
    assert.deepEqual(all.map((l) => l.offset), offsets, 'continuous offsets across the generations');
    // A symlinked or FIFO .log.1 is never read: paging ends at .log, and asking below logBase is a 404.
    fs.writeFileSync(path.join(outside, 'secret.log'), '{"type":"secret","token":"hunter2"}\n');
    const planted: [string, () => void][] = [['job-s', () => fs.symlinkSync(path.join(outside, 'secret.log'), path.join(dir, 'job-s.log.1'))]];
    if (process.platform !== 'win32') planted.push(['job-f', () => assert.equal(spawnSync('mkfifo', [path.join(dir, 'job-f.log.1')]).status, 0)]);
    for (const [scope, plant] of planted) {
      fs.writeFileSync(path.join(dir, `${scope}.log`), '{"type":"now"}\n');
      fs.writeFileSync(path.join(dir, `${scope}.json`), JSON.stringify({ logBase: 500 }));
      plant();
      const first = await page(`session=${scope}`);
      assert.equal(first.status, 200);
      assert.deepEqual([first.body.start, first.body.more], [500, false], `${scope}: paging ends at .log`);
      const below = await page(`session=${scope}&before=500`);
      assert.equal(below.status, 404, scope);
      assert.ok(!below.text.includes('hunter2') && !first.text.includes('hunter2'));
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

test('POST /api/daemon/permission answers a prompt, guarded like every POST', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: '/api/daemon/permission', headers, body: JSON.stringify(body) });
    await until(() => kit.children.length === 1);
    const c = kit.children[0];
    c.line({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'cp a b' } } });
    const stateNow = async () => JSON.parse((await hit(port, { path: '/api/state' })).text).daemons.inbox;
    let inbox;
    const end = Date.now() + 3000;
    while (Date.now() < end && !(inbox = await stateNow()).permissions.length) await new Promise((r) => setTimeout(r, 10));
    assert.equal(inbox.permissions.length, 1, '/api/state lists the prompt');
    const id = inbox.permissions[0].id;
    const body = { scope: '_inbox', id, decision: 'allow' };

    assert.equal((await post(body, { ...good, 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await post(body, { ...good, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(body, { ...good, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post({ ...body, scope: '../x' })).status, 400);
    assert.equal((await post({ ...body, id: 'not-a-uuid' })).status, 400);
    assert.equal((await post({ ...body, decision: 'always' })).status, 400);
    assert.equal((await post({ ...body, id: crypto.randomUUID() })).status, 404);
    assert.ok(!c.written.includes('control_response'), 'no refused POST answered the prompt');

    const ok = await post(body);
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text).inbox.permissions, []);
    assert.ok(c.written.includes('"request_id":"r1"'));
    assert.equal((await post(body)).status, 404, 'answered once');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('POST /api/daemon/mode switches one session, guarded like every POST', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session} --permission-mode dontAsk' });
  const jobA = seedJob(repo.dir, 'job-a');
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)[1];
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: '/api/daemon/mode', headers, body: JSON.stringify(body) });
    await until(() => kit.children.length === 1);
    const c = kit.children[0];
    const body = { scope: '_inbox', mode: 'auto' };

    assert.equal((await post(body, { ...good, 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await post(body, { ...good, origin: 'http://evil.example' })).status, 403);
    assert.equal((await post(body, { ...good, 'content-type': 'text/plain' })).status, 415);
    for (const scope of ['../x', '--flag', '', 7]) assert.equal((await post({ ...body, scope })).status, 400, String(scope));
    assert.equal((await post({ ...body, scope: 'no-such-job' })).status, 404);
    for (const mode of ['bypassPermissions', 'acceptEdits', 'plan', 'AUTO', '', null]) assert.equal((await post({ ...body, mode })).status, 400, String(mode));
    assert.ok(!c.written.includes('set_permission_mode'), 'no refused POST reached the session');

    const ok = await post(body);
    assert.equal(ok.status, 200);
    const st = JSON.parse(ok.text);
    assert.equal(st.permissionMode, 'dontAsk', "daemon.command's mode");
    assert.deepEqual(st.permissionModes, { _inbox: 'auto' });
    await until(() => c.written.includes('set_permission_mode'));
    assert.deepEqual(JSON.parse(c.written.trim().split('\n').at(-1)).request, { subtype: 'set_permission_mode', mode: 'auto' }, 'only the fixed-list value crosses');

    assert.equal((await post({ scope: jobA, mode: 'default' })).status, 200, 'a job without a session yet');
    const s = JSON.parse((await hit(port, { path: '/api/state' })).text).daemons;
    assert.deepEqual(s.permissionModes, { _inbox: 'auto', [jobA]: 'default' });
    assert.equal((await post({ scope: '_inbox', mode: 'dontAsk' })).status, 200);
    assert.deepEqual(JSON.parse((await hit(port, { path: '/api/state' })).text).daemons.permissionModes, { [jobA]: 'default' }, "choosing daemon.command's mode clears the choice");
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
    const keys = ['enabled', 'wanted', 'maxConcurrent', 'live', 'lastError', 'inbox', 'office', 'foreman', 'jobs', 'permissionMode', 'permissionModes', 'clients'];
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
  const keys = ['enabled', 'wanted', 'maxConcurrent', 'live', 'lastError', 'inbox', 'office', 'foreman', 'jobs', 'permissionMode', 'permissionModes', 'clients'];
  const sessionKeys = ['scope', 'wanted', 'running', 'status', 'sessionId', 'pid', 'lastTurnAt', 'lastResultAt', 'turns', 'failures', 'held', 'waiting', 'lastError', 'permissions', 'permissionMode', 'kept', 'effort'];
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
  assert.equal(DASH_API_VERSION, 29, 'the dashboard reads API_VERSION from src/lib/types.ts');
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

test('api/config masks notify webhook urls and the command', async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  const hooks = [{ url: 'https://hooks.slack.com/services/T0/B0/SECRETPATH?x=SECRETQUERY', events: ['gate'], format: 'slack' }, { url: 'not a url SECRETPATH' }, 'https://bare.example/SECRETPATH'];
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 8, daemon: { enabled: false }, notify: { webhooks: hooks, command: './page.sh {title}' } }));
  const srv = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  try {
    const r = await hit(Number(new URL(srv.url).port), { path: '/api/config' });
    assert.ok(!r.text.includes('SECRETPATH') && !r.text.includes('SECRETQUERY'), 'no webhook path or query reaches the dashboard');
    const c = JSON.parse(r.text);
    assert.deepEqual(c.values['notify.webhooks'], [{ url: 'https://hooks.slack.com/…', events: ['gate'], format: 'slack' }, { url: '<invalid>' }, '<invalid>']);
    const f = c.fields.find((x) => x.key === 'notify.webhooks');
    assert.deepEqual([f.editable, f.lockedReason], [false, 'names a URL Forge posts to']);
    assert.equal(c.values['notify.command'], '<set>', 'the command text never reaches the dashboard');
    assert.ok(!r.text.includes('page.sh'));
  } finally {
    await srv.close();
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
    // `warn` is optional: the release row has it once a newer Forge is out.
    for (const c of d.checks) assert.deepEqual(Object.keys(c).filter((k) => k !== 'warn'), ['name', 'ok', 'detail']);
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
  const { versionInfo } = await import('../lib/version.ts');
  const root = path.resolve(import.meta.dirname, '..');
  const repo = tempRepo();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  try {
    const r = await hit(Number(new URL(url).port), { path: '/api/about' });
    assert.equal(r.status, 200);
    const a = JSON.parse(r.text);
    assert.equal(a.forgeVersion, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    assert.equal(a.apiVersion, 29);
    assert.equal(a.pluginRoot, PLUGIN_ROOT);
    assert.deepEqual(a.schemaVersions, { config: schema.CONFIG_SCHEMA_VERSION, job: schema.JOB_SCHEMA_VERSION, event: schema.EVENT_SCHEMA_VERSION });
    assert.equal(a.pricingAsOf, JSON.parse(fs.readFileSync(path.join(root, 'lib', 'pricing.json'), 'utf8')).asOf);
    assert.equal(a.node, process.versions.node);
    assert.deepEqual(a.links, { repo: 'https://github.com/maxwellmattryan/forge', docs: 'https://github.com/maxwellmattryan/forge/tree/main/docs' });
    const v = versionInfo(PLUGIN_ROOT);
    assert.equal(a.commit, v.commit);
    assert.equal(a.installedAs, v.installedAs);
    assert.ok(a.commit === null || /^[0-9a-f]{40}$/.test(a.commit));
  } finally {
    await close();
    repo.cleanup();
  }
});

test('GET /api/about spawns nothing per request', async () => {
  // /api/about takes no token, so a cross-site page can hit it: the commit is found once at start.
  const repo = tempRepo();
  const stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-about-'));
  const log = path.join(stubs, 'calls.log');
  for (const cmd of ['git', 'gh']) {
    fs.writeFileSync(path.join(stubs, cmd), `#!/bin/sh\necho "${cmd} $*" >> "${log}"\nexit 1\n`, { mode: 0o755 });
  }
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const pathBefore = process.env.PATH;
  process.env.PATH = `${stubs}${path.delimiter}${pathBefore}`;
  try {
    const port = Number(new URL(url).port);
    const first = JSON.parse((await hit(port, { path: '/api/about' })).text);
    const second = JSON.parse((await hit(port, { path: '/api/about' })).text);
    assert.equal(fs.existsSync(log), false, fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
    assert.equal(second.commit, first.commit);
    assert.equal(second.installedAs, first.installedAs);
  } finally {
    process.env.PATH = pathBefore;
    await close();
    fs.rmSync(stubs, { recursive: true, force: true });
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
      { type: 'run', args: { ref: '12' } },
      { type: 'run', args: { ref: '#reading-list' } },
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
      { type: 'run', args: {} },
      { type: 'run', args: { ref: '--exec=x' } },
      { type: 'run', args: { ref: 'a b' } },
      { type: 'run' },
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

test('dashboard cannot enqueue gate requests', async () => {
  const repo = tempRepo();
  const job = seedJob(repo.dir, 'job-a');
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    for (const body of [{ type: 'gate', job, args: { gate: 'spec-approval', reserved: null } }, { type: 'gate', job }, { type: 'gate' }]) {
      const r = await postJson(port, '/api/requests', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.text).error, /gate requests are written only by/);
    }
    assert.deepEqual(JSON.parse((await hit(port, { path: '/api/requests' })).text), [], 'nothing was queued');
    // The office scope is a session the daemon endpoints accept, with no job behind it.
    const mode = await postJson(port, '/api/daemon/mode', { scope: '_office', mode: 'dontAsk' });
    assert.notEqual(mode.status, 404, mode.text);
    assert.notEqual(mode.status, 400, mode.text);
  } finally {
    await close();
    repo.cleanup();
  }
});

test('state exposes office session and gateOwner', async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 5, foreman: { enabled: true } }));
  const now = new Date().toISOString();
  const seed = (id: string, extra: Record<string, unknown>) => {
    const d = path.join(repo.dir, '.forge', 'jobs', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ schemaVersion: 9, id, title: id, stage: 'spec', state: 'running', createdAt: now, updatedAt: now, ...extra }));
  };
  seed('j-run', {});
  seed('j-spec', { state: 'waiting', waitingOn: 'spec-approval', reason: 'spec ready' });
  seed('j-auth', { stage: 'decide', state: 'waiting', waitingOn: 'escalation', reason: 'approver escalated: auth change' });
  seed('j-input', { stage: 'build', state: 'waiting', waitingOn: 'input' });
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const st = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(st.apiVersion, 29);
    assert.equal(st.daemons.foreman, true);
    assert.equal(st.daemons.office.scope, '_office');
    assert.equal(st.daemons.office.running, false);
    const owners = Object.fromEntries(st.jobs.map((j) => [j.id, j.gateOwner]));
    assert.deepEqual(owners, { 'j-run': null, 'j-spec': 'foreman', 'j-auth': 'human', 'j-input': 'human' });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 5, foreman: { enabled: false } }));
    const off = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(off.daemons.foreman, false);
    assert.ok(off.jobs.every((j) => j.gateOwner === null), 'the foreman off: no owner badge');
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
    // Distinct milliseconds keep the id order the creation order. Date.now() can read one millisecond
    // back right after it moved on (seen on macOS under load), so wait until it is two past the id's.
    const t = Number(ids[i].split('-')[0]);
    while (Date.now() <= t + 1);
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
    assert.equal(detail.request, null, 'a job without request.md has no opening message');
    fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', b, 'request.md'), `# Title line\n\n  ${'w'.repeat(2500)}\n`);
    const other = JSON.parse((await hit(port, { path: `/api/jobs/${b}` })).text);
    assert.equal(other.request, `${'w'.repeat(2000)}…`, 'the request without its title, trimmed and capped');
    assert.equal(detail.requestFromTracker, false, 'no created event: not tracker text');
    // Created from the bar, then linked at the gate: the job has issues, but only the created event's count.
    const event = (type, data) => JSON.stringify({ v: 1, ts: new Date().toISOString(), type, ...data }) + '\n';
    const jobJson = path.join(repo.dir, '.forge', 'jobs', b, 'job.json');
    fs.writeFileSync(jobJson, JSON.stringify({ ...JSON.parse(fs.readFileSync(jobJson, 'utf8')), source: { tracker: 'local', ref: 'reading-list', url: null } }));
    fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', b, 'events.jsonl'), event('created', { title: b, source: null, origin: 'dashboard' }) + event('linked', { tracker: 'local', ref: 'reading-list', url: null }));
    const linked = JSON.parse((await hit(port, { path: `/api/jobs/${b}` })).text);
    assert.equal(linked.job.issues[0].ref, 'reading-list', 'a stray source in a current job.json is folded into issues');
    assert.ok(!('source' in linked.job));
    assert.equal(linked.requestFromTracker, false, 'linked later: the request is still the user\'s words');
    fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', a, 'events.jsonl'), event('created', { title: a, source: { tracker: 'local', ref: 'reading-list', url: null } }));
    assert.equal(JSON.parse((await hit(port, { path: `/api/jobs/${a}` })).text).requestFromTracker, true, 'from-ref: the created event has the ref');
    assert.deepEqual(other.requests.map((r) => r.text), ['other job']);
  } finally {
    await close();
    repo.cleanup();
  }
});

// ---- Who holds a job: ownerStatus in /api/state and the job detail, and the resume guard.

const FAKE_CLAUDE = path.resolve(import.meta.dirname, 'fixtures', 'bin', 'claude');
const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();

/** A seeded job with `owner` (a session id and heartbeat age in minutes) and optional agents. */
function ownedJob(dir: string, id: string, owner: { session: string; minutes: number } | null, agents: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  seedJob(dir, id);
  const file = path.join(dir, '.forge', 'jobs', id, 'job.json');
  const at = owner ? minutesAgo(owner.minutes) : null;
  const o = owner ? { session: owner.session, host: 'h', since: minutesAgo(120), heartbeat: at } : null;
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), owner: o, agents, ...extra }));
  return id;
}

/** A daemon session record for `scope` whose child has exited, so its session holds nothing. */
function deadRecord(dir: string, scope: string, sessionId: string) {
  const d = path.join(dir, '.forge', 'runtime', 'daemons');
  fs.mkdirSync(d, { recursive: true });
  const pid = spawnSync(process.execPath, ['-e', '0']).pid;
  fs.writeFileSync(path.join(d, `${scope}.json`), JSON.stringify({ resumable: true, serverPid: null, argv0: FAKE_CLAUDE, startedAt: new Date().toISOString(), sessionId, spawnSessionId: sessionId, pid }));
}

test('owner status in /api/state and job detail', async () => {
  const repo = tempRepo();
  const dead = '0b6c3c55-6a39-4c34-9d0d-5d1b2c7a9e10';
  ownedJob(repo.dir, 'j-none', null);
  ownedJob(repo.dir, 'j-live', { session: 'sess-live', minutes: 1 });
  ownedJob(repo.dir, 'j-agent', { session: 'sess-agent', minutes: 45 }, { builder: { runs: 1, status: 'running', startedAt: minutesAgo(5) } });
  ownedJob(repo.dir, 'j-stale', { session: 'sess-stale', minutes: 45 });
  ownedJob(repo.dir, 'j-dead', { session: dead, minutes: 1 });
  deadRecord(repo.dir, 'j-dead', dead);
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const st = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(st.apiVersion, 29);
    const byId = Object.fromEntries(st.jobs.map((j) => [j.id, j.ownerStatus]));
    assert.deepEqual(Object.fromEntries(Object.entries(byId).map(([k, v]: [string, any]) => [k, v.status])), { 'j-none': 'none', 'j-live': 'live', 'j-agent': 'live', 'j-stale': 'stale', 'j-dead': 'live' }, 'the time rule only: never dead');
    assert.deepEqual(byId['j-none'], { status: 'none', session: null, since: null, heartbeat: null, agentRunning: false, reason: null, jobSession: false });
    assert.equal(byId['j-agent'].agentRunning, true);
    assert.equal(byId['j-live'].session, 'sess-live');
    const detail = (id) => hit(port, { path: `/api/jobs/${id}` }).then((r) => JSON.parse(r.text).job.ownerStatus);
    assert.deepEqual([(await detail('j-dead')).status, (await detail('j-dead')).reason], ['dead', 'not-running'], 'the detail adds the daemon proof');
    assert.equal((await detail('j-live')).status, 'live');
    assert.equal((await detail('j-stale')).status, 'stale');
    assert.equal((await detail('j-none')).status, 'none');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('POST resume refuses a live owner and queues otherwise', async () => {
  const repo = tempRepo();
  const dead = '7d1e9a52-2f0b-4b1e-8c3a-1f4e5d6c7b8a';
  ownedJob(repo.dir, 'j-live', { session: 'sess-live', minutes: 1 });
  ownedJob(repo.dir, 'j-agent', { session: 'sess-agent', minutes: 45 }, { builder: { runs: 1, status: 'running', startedAt: minutesAgo(5) } });
  ownedJob(repo.dir, 'j-none', null);
  ownedJob(repo.dir, 'j-stale', { session: 'sess-stale', minutes: 45 });
  ownedJob(repo.dir, 'j-dead', { session: dead, minutes: 1 });
  deadRecord(repo.dir, 'j-dead', dead);
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  const queued = async () => JSON.parse((await hit(port, { path: '/api/requests' })).text).length;
  try {
    // The CSRF guards run before any job lookup.
    assert.equal((await postJson(port, '/api/requests', { type: 'resume', job: 'j-live' }, { 'x-forge-token': 'wrong' })).status, 403);
    assert.equal((await postJson(port, '/api/requests', { type: 'resume', job: 'j-live' }, { origin: 'http://evil.example' })).status, 403);

    const refused: [string, Record<string, unknown>, RegExp][] = [
      ['heartbeat', { type: 'resume', job: 'j-live', text: null, args: {} }, /^job j-live is held by session sess-live \(claimed \S+, last active \S+\); resume it from that session or wait until it stops$/],
      ['agent', { type: 'resume', job: 'j-agent', text: null, args: {} }, /^job j-agent is held by session sess-agent \(claimed \S+; an agent is still running\); resume it from that session or wait until it stops$/],
      ['force', { type: 'resume', job: 'j-live', args: { force: true } }, /sess-live/],
      ['intake', { type: 'resume', job: 'j-live', args: { intake: 'new' } }, /sess-live/],
    ];
    for (const [what, body, error] of refused) {
      const r = await postJson(port, '/api/requests', body);
      assert.equal(r.status, 409, `${what}: ${r.text}`);
      assert.match(JSON.parse(r.text).error, error, what);
    }
    assert.equal(await queued(), 0, 'nothing queued for a live owner');

    for (const job of ['j-none', 'j-stale', 'j-dead']) {
      const r = await postJson(port, '/api/requests', { type: 'resume', job, text: null, args: {} });
      assert.equal(r.status, 200, `${job}: ${r.text}`);
      assert.equal(JSON.parse(r.text).job, job);
    }
    assert.equal(await queued(), 3);

    for (const job of ['../etc', 'a'.repeat(300), 12, 'no-such-job']) {
      const r = await postJson(port, '/api/requests', { type: 'resume', job });
      assert.ok(r.status < 500, `${String(job).slice(0, 20)}: ${r.status} ${r.text}`);
    }
  } finally {
    await close();
    repo.cleanup();
  }
});

test("resume text never reaches a daemon session's stdin, argv or env", async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const id = ownedJob(repo.dir, 'j-resume', null, {}, { state: 'queued', stage: 'backlog' });
  const kit = fakeChildren();
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(url).port);
  try {
    const marker = `MARKER-${Math.random().toString(36).slice(2)}`;
    const r = await postJson(port, '/api/requests', { type: 'resume', job: id, text: `${marker} $(touch /tmp/${marker})`, args: {} });
    assert.equal(r.status, 200, r.text);
    await until(() => kit.of(id).length === 1 && kit.of(id)[0].written === TURN_LINE);
    for (const c of kit.children) {
      assert.ok(c.written === TURN_LINE || (c.scope === '_inbox' && c.written === ''), `${c.scope}: stdin is exactly the turn line`);
      const exposed = [c.cmd, ...c.args, ...Object.values(c.opts.env ?? {})].map(String).join('\n');
      assert.ok(!exposed.includes(marker), `${c.scope}: the marker reached argv or env`);
    }
  } finally {
    await close();
    repo.cleanup();
  }
});

test("a resume reaches the job's own live daemon session", { skip: process.platform === 'win32' && 'POSIX-only' }, async () => {
  const repo = tempRepo();
  const sid = '3c2b1a09-8f7e-4d6c-9b5a-4f3e2d1c0b9a';
  ownedJob(repo.dir, 'j-own', { session: sid, minutes: 1 });
  ownedJob(repo.dir, 'j-other', { session: sid, minutes: 1 });
  // A provably live child: the recorded claude executable running with the recorded session id.
  const child = spawn(FAKE_CLAUDE, ['--session-id', sid], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    await new Promise((r) => setTimeout(r, 200));
    const d = path.join(repo.dir, '.forge', 'runtime', 'daemons');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'j-own.json'), JSON.stringify({ resumable: true, serverPid: process.pid, argv0: FAKE_CLAUDE, startedAt: new Date().toISOString(), sessionId: sid, spawnSessionId: sid, pid: child.pid }));
    const own = JSON.parse((await hit(port, { path: '/api/jobs/j-own' })).text).job.ownerStatus;
    assert.deepEqual([own.status, own.jobSession], ['live', true]);
    const st = JSON.parse((await hit(port, { path: '/api/state' })).text).jobs.find((j) => j.id === 'j-own').ownerStatus;
    assert.equal(st.jobSession, false, '/api/state never runs the proof');
    const r = await postJson(port, '/api/requests', { type: 'resume', job: 'j-own', text: null, args: {} });
    assert.equal(r.status, 200, r.text);
    // The same session owning another job is that job's live foreign owner.
    const other = await postJson(port, '/api/requests', { type: 'resume', job: 'j-other', text: null, args: {} });
    assert.equal(other.status, 409, other.text);
    assert.equal(JSON.parse((await hit(port, { path: '/api/jobs/j-other' })).text).job.ownerStatus.jobSession, false);
    // The detail runs `ps`, so other sites may not request it.
    assert.equal((await hit(port, { path: '/api/jobs/j-own', headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await hit(port, { path: '/api/jobs/j-own', headers: { origin: 'http://evil.example' } })).status, 403);
  } finally {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch {}
    await close();
    repo.cleanup();
  }
});

// ---- Effort per job (issue #121).

/** A job dir at the current schema with `effort` as written, valid or not. */
function effortJob(dir: string, id: string, effort: unknown) {
  seedJob(dir, id);
  const file = path.join(dir, '.forge', 'jobs', id, 'job.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), schemaVersion: 7, effort }));
  return id;
}

test('/api/state and job detail carry effort', async () => {
  const repo = tempRepo();
  const config = (effort: unknown, daemon: Record<string, unknown>) => {
    fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 2, runtime: { effort }, daemon }));
  };
  config('medium', { enabled: true, command: 'claude {session}' });
  const plain = seedJob(repo.dir, 'job-plain');
  const high = effortJob(repo.dir, 'job-high', 'high');
  const bad = effortJob(repo.dir, 'job-bad', '--add-dir=/');
  const kit = fakeChildren();
  let srv = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  try {
    const port = Number(new URL(srv.url).port);
    const s = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(s.apiVersion, 29);
    assert.equal(s.config.effort, 'medium');
    const row = (id) => s.jobs.find((j) => j.id === id);
    assert.equal(row(plain).effort, null, 'a v3 job reads as inherit');
    assert.equal(row(plain).complexity, null, 'jobs carry complexity, null before a spec records one');
    assert.equal(row(high).effort, 'high');
    assert.equal(row(bad).effort, null, 'a tampered value reads as inherit');
    assert.equal(s.daemons.inbox.effort, 'medium', 'the inbox child got runtime.effort');
    const detail = JSON.parse((await hit(port, { path: `/api/jobs/${high}` })).text);
    assert.equal(detail.job.effort, 'high');
    await postRequest(port, { type: 'resume', job: high });
    await until(() => kit.of(high).length === 1);
    const s2 = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(s2.daemons.jobs[high].effort, 'high');
    assert.equal(kit.of(high)[0].args[kit.of(high)[0].args.indexOf('--effort') + 1], 'high');
  } finally {
    await srv.close();
  }
  config('ultra', { enabled: false });
  srv = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  try {
    const s = JSON.parse((await hit(Number(new URL(srv.url).port), { path: '/api/state' })).text);
    assert.equal(s.config.effort, null, 'an invalid runtime.effort reads as none');
    assert.equal(s.daemons.inbox.effort, null, 'no child, no effort');
  } finally {
    await srv.close();
    repo.cleanup();
  }
});

test('POST /api/jobs/:id/effort sets a job\'s effort, guarded like every POST', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session}' });
  const id = seedJob(repo.dir, 'job-a');
  const dir = path.join(repo.dir, '.forge', 'jobs', id);
  const kit = fakeChildren();
  const srv = await startServer(repo.dir, { port: 0, daemon: kit.opts });
  const port = Number(new URL(srv.url).port);
  const snapshot = () => fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]);
  const effortEvents = () => (fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'effort') : []);
  try {
    await until(() => kit.children.length === 1);
    assert.equal(srv.pool.state().wanted, true, 'the pool is wanted');
    const token = await tokenOf(port);
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good, job = id) => hit(port, { method: 'POST', path: `/api/jobs/${job}/effort`, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

    const before = snapshot();
    const refusals: [number, any, any?, string?][] = [
      [403, { effort: 'high' }, { ...good, 'x-forge-token': 'wrong' }],
      [403, { effort: 'high' }, (({ 'x-forge-token': _t, ...rest }) => rest)(good)],
      [403, { effort: 'high' }, { ...good, origin: 'http://evil.example' }],
      [415, { effort: 'high' }, { ...good, 'content-type': 'text/plain' }],
      [400, { effort: 'ultra' }],
      [400, { effort: 5 }],
      [400, { effort: '--dangerously-skip-permissions' }],
      [400, {}],
      [400, []],
      [400, 'null'],
      [400, '{not json'],
      [404, { effort: 'high' }, good, 'no-such-job'],
      [404, { effort: 'high' }, good, '_inbox'],
      [404, { effort: 'high' }, good, '..%2Fx'],
    ];
    for (const [status, body, headers, job] of refusals) {
      const r = await post(body, headers ?? good, job ?? id);
      assert.equal(r.status, status, `${JSON.stringify(body)} ${job ?? ''}: ${r.text}`);
      if (status === 400 && typeof body === 'object') assert.equal(JSON.parse(r.text).error, 'effort must be one of low, medium, high, xhigh, max, or null');
    }
    assert.equal((await hit(port, { path: `/api/jobs/${id}/effort` })).status, 404, 'GET is not a route');
    assert.deepEqual(snapshot(), before, 'no refusal wrote anything');
    assert.equal(fs.existsSync(path.join(repo.dir, '.forge', 'jobs', 'no-such-job')), false);

    const ok = await post({ effort: 'high' });
    assert.equal(ok.status, 200);
    assert.deepEqual(JSON.parse(ok.text), { id, effort: 'high', previous: null, changed: true });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).effort, 'high');
    assert.deepEqual(effortEvents().map(({ effort, previous, from }) => ({ effort, previous, from })), [{ effort: 'high', previous: null, from: 'dashboard' }]);
    assert.deepEqual(JSON.parse((await post({ effort: 'high' })).text), { id, effort: 'high', previous: 'high', changed: false });
    assert.equal(effortEvents().length, 1, 'a no-op logs nothing');
    assert.deepEqual(JSON.parse((await post({ effort: null })).text), { id, effort: null, previous: 'high', changed: true }, 'null inherits');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).effort, null);
    assert.equal(kit.children.length, 1, 'nothing was spawned or stopped');
  } finally {
    await srv.close();
    repo.cleanup();
  }
});

test('backlog carries readiness from the triage cache', async () => {
  const repo = tempRepo();
  const forge = path.join(repo.dir, '.forge');
  fs.mkdirSync(path.join(forge, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(forge, 'backlog.md'), '# Backlog\n\n- [?] Vague\n  Needs info: a clear outcome\n- [ ] Clear\n- [ ] Untriaged\n');
  fs.writeFileSync(
    path.join(forge, 'runtime', 'triage.json'),
    JSON.stringify({
      items: {
        'local:vague': { hash: '0123456789abcdef', ready: false, missing: ['outcome', 'bogus'], duplicateOf: null, noted: ['outcome'], at: '2026-10-16T00:00:00.000Z' },
        'local:clear': { hash: 'fedcba9876543210', ready: true, missing: [], duplicateOf: null, noted: null, at: '2026-10-16T00:00:01.000Z' },
        'local:untriaged': { hash: 'not-a-hash', ready: true, missing: [], at: 'x' },
        'github:clear': { hash: '0000000000000000', ready: false, missing: ['scope'], duplicateOf: null, noted: null, at: 'x' },
      },
    }),
  );
  const { server, url } = await startServer(repo.dir, { port: 0 });
  const port = Number(new URL(url).port);
  try {
    const r = await get(port, '/api/backlog');
    assert.equal(r.status, 200);
    const items = JSON.parse(r.body.toString('utf8')).items;
    const by = Object.fromEntries(items.map((i: any) => [i.ref, i]));
    assert.equal(by.vague.needsInfo, true);
    assert.deepEqual(by.vague.triage, { ready: false, missing: ['outcome'], at: '2026-10-16T00:00:00.000Z' });
    assert.equal(by.clear.needsInfo, false);
    assert.deepEqual(by.clear.triage, { ready: true, missing: [], at: '2026-10-16T00:00:01.000Z' });
    assert.ok(!('triage' in by.untriaged), 'a malformed entry is no entry');
  } finally {
    server.close();
    repo.cleanup();
  }
});

test('state carries protectedPaths', async () => {
  const repo = tempRepo();
  fs.mkdirSync(path.join(repo.dir, '.forge'), { recursive: true });
  fs.writeFileSync(path.join(repo.dir, '.forge', 'config.yml'), yaml.stringify({ schemaVersion: 6 }));
  const now = new Date().toISOString();
  const flag = { hits: [{ path: '<img src=x onerror=alert(1)>.yml', rule: 1, glob: '.github/workflows/**', reason: 'CI/CD configuration', blob: 'a'.repeat(40) }], more: 0, at: now, gate: 'commit', head: 'b'.repeat(40) };
  const seed = (id: string, extra: Record<string, unknown>) => {
    const d = path.join(repo.dir, '.forge', 'jobs', id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'job.json'), JSON.stringify({ schemaVersion: 10, id, title: id, stage: 'decide', state: 'running', createdAt: now, updatedAt: now, ...extra }));
  };
  seed('j-flag', { protectedPaths: flag });
  seed('j-old', { schemaVersion: 9 });
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const st = JSON.parse((await hit(port, { path: '/api/state' })).text);
    const byId = Object.fromEntries(st.jobs.map((j) => [j.id, j.protectedPaths]));
    assert.deepEqual(byId, { 'j-flag': flag, 'j-old': null });
    const detail = JSON.parse((await get(port, '/api/jobs/j-flag')).body.toString('utf8'));
    assert.deepEqual(detail.job.protectedPaths, flag);
  } finally {
    await close();
    repo.cleanup();
  }
});

/** What a dashboard action records: the OS user running `forge dash`. */
const DASH_ACTOR = { login: sanitizeLogin(os.userInfo().username) || null, source: 'dashboard' };
const jobEvents = (dir: string, id: string) => fs.readFileSync(path.join(dir, '.forge', 'jobs', id, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('mode switch on a job scope writes daemon-mode', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: true, command: 'claude {session} --permission-mode dontAsk' });
  const jobA = seedJob(repo.dir, 'job-a');
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const token = await tokenOf(port);
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (p: string, body: unknown) => hit(port, { method: 'POST', path: p, headers: good, body: JSON.stringify(body) });
    assert.equal((await post('/api/daemon/mode', { scope: jobA, mode: 'auto' })).status, 200);
    assert.deepEqual(jobEvents(repo.dir, jobA).filter((e) => e.type === 'daemon-mode').map((e) => [e.mode, e.actor]), [['auto', DASH_ACTOR]]);
    assert.equal((await post('/api/daemon/mode', { scope: '_inbox', mode: 'auto' })).status, 200);
    assert.equal(jobEvents(repo.dir, jobA).filter((e) => e.type === 'daemon-mode').length, 1, 'the inbox writes to no job');

    // A config change from the dashboard lands in the repo audit log as the dashboard's person.
    writeConfig(repo.dir, { enabled: false });
  } finally {
    await close();
  }
  const srv = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const p2 = Number(new URL(srv.url).port);
  try {
    const headers = { 'x-forge-token': await tokenOf(p2), origin: `http://127.0.0.1:${p2}`, 'content-type': 'application/json' };
    const r = await hit(p2, { method: 'POST', path: '/api/config', headers, body: JSON.stringify({ key: 'runtime.effort', value: 'high' }) });
    assert.equal(r.status, 200, r.text);
    const audit = fs.readFileSync(path.join(repo.dir, '.forge', 'runtime', 'audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((e) => [e.type, e.key, e.value, e.actor]), [['config-set', 'runtime.effort', 'high', DASH_ACTOR]]);
  } finally {
    await srv.close();
    repo.cleanup();
  }
});

test('state carries lastHuman', async () => {
  const repo = tempRepo();
  writeConfig(repo.dir, { enabled: false });
  const acted = seedJob(repo.dir, 'j-acted');
  const legacy = seedJob(repo.dir, 'j-legacy');
  const quiet = seedJob(repo.dir, 'j-quiet');
  const lines = (id: string, events: Record<string, unknown>[]) => fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
  lines(acted, [
    { v: 2, ts: '2026-03-01T00:00:00.000Z', type: 'human', action: 'approve', actor: { login: '<b>al</b>', source: 'gh' } },
    { v: 2, ts: '2026-03-01T00:00:01.000Z', type: 'budget-ack', keys: ['usd'], actor: { login: 'bob', source: 'env' } },
    { v: 2, ts: '2026-03-01T00:00:02.000Z', type: 'agent-end', role: 'builder' },
  ]);
  lines(legacy, [{ v: 1, ts: '2026-03-01T00:00:00.000Z', type: 'human', action: 'rework', actor: 'foreman' }]);
  lines(quiet, [{ v: 2, ts: '2026-03-01T00:00:00.000Z', type: 'claimed', session: 's' }]);
  const { url, close } = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const st = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(st.apiVersion, 29);
    const by = Object.fromEntries(st.jobs.map((j) => [j.id, j.lastHuman]));
    assert.deepEqual(by, {
      [acted]: { ts: '2026-03-01T00:00:01.000Z', type: 'budget-ack', action: null, actor: { login: 'bob', source: 'env' } },
      [legacy]: { ts: '2026-03-01T00:00:00.000Z', type: 'human', action: 'rework', actor: { login: null, source: 'foreman' } },
      [quiet]: null,
    });
    assert.deepEqual(st.jobs.find((j) => j.id === legacy).lastEvent.actor, { login: null, source: 'foreman' }, 'events reach the dashboard normalised');
    const detail = JSON.parse((await get(port, `/api/jobs/${acted}`)).body.toString('utf8'));
    assert.deepEqual(detail.events[0].actor, { login: 'balb', source: 'gh' }, 'a login is sanitised on read');
  } finally {
    await close();
    repo.cleanup();
  }
});

test('state carries repo budget', async () => {
  const s = budgetRepo({ usdPerMonth: 10 }, 12);
  const runtime = path.join(s.root, '.forge', 'runtime');
  fs.rmSync(runtime, { recursive: true, force: true });
  const { url, close } = await startServer(s.root, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  try {
    const st = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(st.apiVersion, 29);
    assert.equal(st.budget.month, new Date().toISOString().slice(0, 7));
    assert.deepEqual(st.budget.spent, { dayUsd: 12, monthUsd: 12, monthTokens: 12 });
    assert.deepEqual(st.budget.exceeded, ['usdPerMonth']);
    assert.equal(st.budget.held, true);
    assert.equal(st.budget.reason, 'repo budget: $12.00 of $10.00 this month');
    const written = fs.existsSync(runtime) ? fs.readdirSync(runtime, { recursive: true }).filter((f) => !String(f).startsWith('daemons')) : [];
    assert.deepEqual(written, [], 'the GET writes no file under .forge/runtime/');
  } finally {
    await close();
    s.cleanup();
  }
});

test('budget ack endpoint guards', async () => {
  const s = budgetRepo({ usdPerMonth: 10, usdPerDay: 1000 }, 12);
  const { url, close } = await startServer(s.root, { port: 0, daemon: fakeChildren().opts });
  const port = Number(new URL(url).port);
  const auditFile = path.join(s.root, '.forge', 'runtime', 'audit.jsonl');
  const acks = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  try {
    const good = { 'x-forge-token': await tokenOf(port), origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good) => hit(port, { method: 'POST', path: '/api/budget/ack', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const d = new Date();
    const past = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
    const { origin: _o, ...noOrigin } = good;
    const refusals: [number, unknown, any?][] = [
      [403, { period: month }, { ...good, 'x-forge-token': 'wrong' }],
      [403, { period: month }, noOrigin],
      [403, { period: month }, { ...good, origin: 'http://evil.example' }],
      [415, { period: month }, { ...good, 'content-type': 'text/plain' }],
      [400, '{not json'],
      [400, {}],
      [400, { period: 202610 }],
      [400, { period: '2026-13' }],
      [400, { period: past }],
      [409, { period: today }],
    ];
    for (const [status, body, headers] of refusals) assert.equal((await post(body, headers)).status, status, JSON.stringify(body));
    assert.deepEqual(acks(), [], 'no refusal wrote an ack');
    const within = await post({ period: today });
    assert.match(JSON.parse(within.text).error, /nothing to acknowledge/);

    const ok = await post({ period: month });
    assert.equal(ok.status, 200, ok.text);
    const st = JSON.parse(ok.text);
    assert.equal(st.caps.usdPerMonth, 20);
    assert.equal(st.held, false);
    const [ack] = acks();
    assert.equal(ack.type, 'repo-budget-ack');
    assert.equal(ack.period, month);
    assert.equal(ack.actor.source, 'dashboard');
    const state = JSON.parse((await hit(port, { path: '/api/state' })).text);
    assert.equal(state.budget.held, false, 'the next poll sees the ack at once');
  } finally {
    await close();
    s.cleanup();
  }
});

test('job detail serves issues', async () => {
  const repo = tempRepo();
  const old = seedJob(repo.dir, 'job-old');
  const oldFile = path.join(repo.dir, '.forge', 'jobs', old, 'job.json');
  fs.writeFileSync(oldFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(oldFile, 'utf8')), source: { tracker: 'github', ref: '12', url: 'https://github.com/o/r/issues/12' } }));
  const now = seedJob(repo.dir, 'job-now');
  const nowDir = path.join(repo.dir, '.forge', 'jobs', now);
  const issues = [{ tracker: 'github', ref: 'o/r#5', url: 'https://github.com/o/r/issues/5' }, { tracker: 'github', ref: 'x/y#9', url: null }];
  fs.writeFileSync(path.join(nowDir, 'job.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(nowDir, 'job.json'), 'utf8')), schemaVersion: 11, issues }));
  const event = (type, data) => JSON.stringify({ v: 1, ts: new Date().toISOString(), type, ...data }) + '\n';
  fs.writeFileSync(path.join(nowDir, 'events.jsonl'), event('created', { title: now, issues }));
  const srv = await startServer(repo.dir, { port: 0, daemon: fakeChildren().opts });
  try {
    const port = Number(new URL(srv.url).port);
    const s = JSON.parse((await hit(port, { path: '/api/state' })).text);
    const row = (id) => s.jobs.find((j) => j.id === id);
    assert.deepEqual(row(old).issues, [{ tracker: 'github', ref: 'o/r#12', url: 'https://github.com/o/r/issues/12' }], 'an old source is served as issues');
    assert.deepEqual(row(now).issues, issues);
    for (const id of [old, now]) assert.ok(!('source' in row(id)), `${id} has no source in /api/state`);
    const detail = JSON.parse((await hit(port, { path: `/api/jobs/${now}` })).text);
    assert.deepEqual(detail.job.issues, issues);
    assert.ok(!('source' in detail.job));
    assert.equal(detail.requestFromTracker, true, 'a created event with an issue ref');
    fs.writeFileSync(path.join(nowDir, 'events.jsonl'), event('created', { title: now, issues: [{ tracker: 'local', ref: null, url: 'https://x' }] }));
    assert.equal(JSON.parse((await hit(port, { path: `/api/jobs/${now}` })).text).requestFromTracker, false, 'a url-only issue is not tracker text');
  } finally {
    await srv.close();
    repo.cleanup();
  }
});

test('POST /api/jobs/:id/repos decides pending proposals', async () => {
  const p = await twoRepo();
  p.config((c) => c.repos.push({ name: 'tools', remote: 'https://example.com/tools.git', defaultBranch: 'main' }));
  const parked = (await p.f('job', 'new', '--title', 'parked')).id;
  await p.f('job', 'repo', 'propose', parked, 'lib', '--reason', '<script>alert(1)</script> core API');
  await p.f('job', 'set', parked, '--stage', 'spec', '--state', 'waiting', '--waiting-on', 'human', '--reason', 'repo proposal: lib');
  const idle = (await p.f('job', 'new', '--title', 'nothing pending')).id;
  const noClone = (await p.f('job', 'new', '--title', 'no clone')).id;
  await p.f('job', 'repo', 'propose', noClone, 'tools', '--reason', 'cli flag');
  const rejected = (await p.f('job', 'new', '--title', 'rejected')).id;
  await p.f('job', 'repo', 'propose', rejected, 'lib', '--reason', 'maybe');
  // Two pending, with repo-proposals.json edited (as a session could) to list only lib.
  const hidden = (await p.f('job', 'new', '--title', 'hidden repo')).id;
  await p.f('job', 'repo', 'propose', hidden, 'lib', '--reason', 'core API');
  await p.f('job', 'repo', 'propose', hidden, 'tools', '--reason', 'cli flag');
  const shownFile = path.join(p.root, '.forge', 'jobs', hidden, 'repo-proposals.json');
  const shown = JSON.parse(fs.readFileSync(shownFile, 'utf8'));
  fs.writeFileSync(shownFile, JSON.stringify({ proposals: shown.proposals.filter((r: any) => r.repo === 'lib') }));
  const srv = await startServer(p.root, { port: 0 });
  const port = Number(new URL(srv.url).port);
  const dir = (id: string) => path.join(p.root, '.forge', 'jobs', id);
  const snapshot = () => [parked, idle, noClone, hidden].map((id) => ['job.json', 'events.jsonl'].map((f) => fs.readFileSync(path.join(dir(id), f), 'utf8')).join('\0'));
  const resumes = () => {
    const d = path.join(p.root, '.forge', 'runtime', 'requests');
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))).filter((r) => r.type === 'resume') : [];
  };
  try {
    const token = await tokenOf(port);
    const good = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
    const post = (body, headers: any = good, job = parked) => hit(port, { method: 'POST', path: `/api/jobs/${job}/repos`, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
    const before = snapshot();
    const lib = { decision: 'approve', repos: ['lib'] };
    const refusals: [number, any, any?, string?][] = [
      [403, lib, { ...good, 'x-forge-token': 'wrong' }],
      [403, lib, (({ 'x-forge-token': _t, ...rest }) => rest)(good)],
      [403, lib, { ...good, origin: 'http://evil.example' }],
      [415, lib, { ...good, 'content-type': 'text/plain' }],
      [400, { decision: 'maybe', repos: ['lib'] }],
      [400, {}],
      [400, []],
      [400, 'null'],
      [400, '{not json'],
      [400, { ...lib, note: 5 }],
      [400, { ...lib, note: 'x'.repeat(2001) }],
      [400, { decision: 'approve' }],
      [400, { decision: 'approve', repos: [] }],
      [400, { decision: 'approve', repos: 'lib' }],
      [400, { decision: 'approve', repos: [5] }],
      [400, { decision: 'approve', repos: ['../evil'] }],
      [400, { decision: 'approve', repos: Array.from({ length: 101 }, (_, i) => `r${i}`) }],
      [404, lib, good, 'no-such-job'],
      [404, lib, good, '_inbox'],
      [409, lib, good, idle],
      [409, { decision: 'reject', repos: ['lib'] }, good, idle],
      [409, { decision: 'approve', repos: ['tools'] }, good, noClone],
      [409, { decision: 'approve', repos: ['tools'] }, good, parked],
      [409, lib, good, hidden],
      [409, { decision: 'reject', repos: ['lib'] }, good, hidden],
    ];
    for (const [status, body, headers, job] of refusals) {
      const r = await post(body, headers ?? good, job ?? parked);
      assert.equal(r.status, status, `${JSON.stringify(body)} ${job ?? ''}: ${r.text}`);
    }
    assert.match(JSON.parse((await post({ decision: 'approve', repos: ['tools'] }, good, noClone)).text).error, /repo tools: no path in \.forge\/local\.yml/);
    // The hidden-repo case: the drawer listed lib only, so neither decision goes through while tools is pending.
    assert.match(JSON.parse((await post(lib, good, hidden)).text).error, /also has tools pending, which this decision did not list/);
    assert.equal((await hit(port, { path: `/api/jobs/${parked}/repos` })).status, 404, 'GET is not a route');
    assert.deepEqual(snapshot(), before, 'no refusal wrote anything');
    assert.deepEqual(resumes(), []);

    const ok = await post({ ...lib, note: 'needed' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(JSON.parse(ok.text), { id: parked, decision: 'approve', repos: ['lib'], added: ['lib'], pending: [], resumed: true });
    const job = JSON.parse(fs.readFileSync(path.join(dir(parked), 'job.json'), 'utf8'));
    assert.equal(job.state, 'running');
    assert.equal(job.repos[1].repo, 'lib');
    const human = p.events(parked).filter((e) => e.type === 'human');
    assert.deepEqual(human.map((e) => [e.action, e.repos, e.note, e.actor.source]), [['approve-repos', ['lib'], 'needed', 'dashboard']]);
    assert.deepEqual(resumes().map((r) => [r.job, r.from]), [[parked, 'dashboard']]);

    // A job that never parked on the proposal is decided but not moved or resumed.
    const no = await post({ decision: 'reject', repos: ['lib'], note: null }, good, rejected);
    assert.equal(no.status, 200, no.text);
    assert.deepEqual(JSON.parse(no.text), { id: rejected, decision: 'reject', repos: ['lib'], added: [], pending: [], resumed: false });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir(rejected), 'job.json'), 'utf8')).state, 'queued');
    assert.equal(resumes().length, 1);
  } finally {
    await srv.close();
    p.cleanup();
  }
});
