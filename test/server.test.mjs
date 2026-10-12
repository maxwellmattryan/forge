import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

/** @param {number} port @param {string} path @param {string} [host] @returns {Promise<{status:number|undefined, type:string|undefined}>} */
function get(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] }));
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
    for (const p of ['/app.js', '/util.js', '/budget.js', '/deps.js']) {
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
