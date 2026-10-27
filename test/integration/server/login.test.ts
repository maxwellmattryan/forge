// The dashboard login: POST /api/session exchanges the login link's key for the per-port HttpOnly,
// SameSite=Strict cookie, that cookie alone reaches every kind of /api request the page makes (pages,
// POSTs, images, the raw mockup iframe and event streams), and the Origin and Fetch Metadata guards
// still refuse another site or another loopback port that carries it (docs/architecture/dashboard-security.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { serveProjects, tempRepo, withLease } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, jobDir } from '#core/job/store.ts';
import { listRequests } from '#core/job/requests.ts';
import { projectSlug } from '#integrations/claude/transcripts.ts';

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: string };

/** One request on its own connection, with no credentials but those in `headers`. */
function raw(port: number, method: string, p: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** The status and headers of a GET whose body may never end (an event stream); the connection is dropped once they arrive. */
function head(port: number, p: string, headers: Record<string, string>): Promise<{ status: number; type: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type'] ?? '') });
      req.destroy();
    });
    req.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e)));
    req.end();
  });
}

const P = '/api/p/a';

test('the session exchange sets the login cookie only for the right key', async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const s = await serveProjects([{ dir: repo.dir, name: 'a' }]);
  t.after(() => s.cleanup());
  const origin = `http://127.0.0.1:${s.port}`;
  const json = { origin, 'content-type': 'application/json' };
  const session = (body: string, headers: Record<string, string> = json) => raw(s.port, 'POST', '/api/session', headers, body);
  const good = JSON.stringify({ k: s.token });

  // Dispatch's POST checks run first: the exchange needs no login, but it does need our Origin and JSON.
  assert.deepEqual(await session(good, { 'content-type': 'application/json' }).then((r) => [r.status, r.text]), [403, 'bad origin']);
  assert.deepEqual(await session(good, { ...json, origin: 'http://evil.example' }).then((r) => [r.status, r.text]), [403, 'bad origin']);
  assert.deepEqual(await session(good, { ...json, 'content-type': 'text/plain' }).then((r) => [r.status, r.text]), [415, 'json only']);

  for (const body of ['[]', '{}', '{"k":1}', JSON.stringify({ k: s.token, x: 1 })]) {
    const r = await session(body);
    assert.deepEqual([r.status, JSON.parse(r.text)], [400, { error: 'body must be {"k": string}' }], body);
    assert.equal(r.headers['set-cookie'], undefined, body);
  }
  const sameLength = s.token.replace(/^./, (c) => (c === '0' ? '1' : '0'));
  for (const k of ['', sameLength, `${s.token}x`, s.token.slice(0, 16)]) {
    const r = await session(JSON.stringify({ k }));
    assert.deepEqual([r.status, JSON.parse(r.text)], [401, { error: 'wrong login key' }], k);
    assert.equal(r.headers['set-cookie'], undefined, `${k}: no cookie`);
  }

  const ok = await session(good);
  assert.deepEqual([ok.status, JSON.parse(ok.text)], [200, { ok: true }]);
  assert.deepEqual(ok.headers['set-cookie'], [`forge-${s.port}=${s.token}; HttpOnly; SameSite=Strict; Path=/`]);
  const cookie = ok.headers['set-cookie']![0]!.split(';')[0]!;
  assert.equal((await raw(s.port, 'GET', '/api/projects', { cookie })).status, 200, 'the cookie alone signs in');
});

test('the cookie alone reaches pages, images, the raw iframe and streams', async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-login-projects-')));
  t.after(() => fs.rmSync(projects, { recursive: true, force: true }));
  const id = createJob(repo.dir, loadConfig(repo.dir).config, { title: 'with files' }).id;
  const dir = jobDir(repo.dir, id);
  fs.mkdirSync(path.join(dir, 'screenshots'));
  fs.writeFileSync(path.join(dir, 'screenshots', 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  fs.writeFileSync(path.join(dir, 'mockup.html'), '<p>mockup</p>');
  // An interactive owner's transcript, which the job detail's live view streams.
  const sid = crypto.randomUUID();
  withLease(repo.dir, id, sid);
  const slugDir = path.join(projects, projectSlug(fs.realpathSync(repo.dir)));
  fs.mkdirSync(slugDir, { recursive: true });
  fs.writeFileSync(path.join(slugDir, `${sid}.jsonl`), '{"type":"system"}\n');
  const s = await serveProjects([{ dir: repo.dir, name: 'a' }], { projectsDir: projects });
  t.after(() => s.cleanup());
  const cookie = { cookie: `forge-${s.port}=${s.token}` };
  const same = { ...cookie, 'sec-fetch-site': 'same-origin' };

  const state = await raw(s.port, 'GET', `${P}/state`, cookie);
  assert.equal(state.status, 200, state.text);
  const queued = await raw(s.port, 'POST', `${P}/requests`, { ...cookie, origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/json' }, '{"type":"sync"}');
  assert.equal(queued.status, 200, queued.text);
  assert.deepEqual(listRequests(repo.dir).map((r) => r.type), ['sync']);
  const shot = await raw(s.port, 'GET', `${P}/jobs/${id}/file?path=screenshots/x.png`, same);
  assert.deepEqual([shot.status, shot.headers['content-type']], [200, 'image/png']);
  const mockup = await raw(s.port, 'GET', `${P}/jobs/${id}/raw?path=mockup.html`, same);
  assert.deepEqual([mockup.status, mockup.text], [200, '<p>mockup</p>']);
  const stream = await head(s.port, `${P}/jobs/${id}/transcript/events`, same);
  assert.deepEqual([stream.status, stream.type.split(';')[0]], [200, 'text/event-stream']);
});

test('a cross-site or other-port request with the cookie is still refused', async (t) => {
  const repo = tempRepo();
  t.after(repo.cleanup);
  const s = await serveProjects([{ dir: repo.dir, name: 'a' }]);
  t.after(() => s.cleanup());
  const cookie = { cookie: `forge-${s.port}=${s.token}` };
  const post = (origin: string) => raw(s.port, 'POST', `${P}/requests`, { ...cookie, origin, 'content-type': 'application/json' }, '{"type":"sync"}').then((r) => [r.status, r.text]);
  const get = (headers: Record<string, string>) => raw(s.port, 'GET', `${P}/state`, { ...cookie, ...headers }).then((r) => [r.status, r.text]);

  assert.deepEqual(await post('http://evil.example'), [403, 'bad origin']);
  assert.deepEqual(await post(`http://127.0.0.1:${s.port + 1}`), [403, 'bad origin'], 'another loopback port is another origin');
  assert.deepEqual(await get({ 'sec-fetch-site': 'same-site' }), [403, 'cross-site'], 'another port on 127.0.0.1 is same-site');
  assert.deepEqual(await get({ 'sec-fetch-site': 'cross-site' }), [403, 'cross-site']);
  assert.deepEqual(await get({ origin: 'http://evil.example' }), [403, 'bad origin']);
  assert.deepEqual(listRequests(repo.dir), [], 'nothing is queued');
});
