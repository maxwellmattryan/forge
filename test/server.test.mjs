import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { startServer } from '../lib/server.mjs';

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
