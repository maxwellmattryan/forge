// POST /api/projects, the dashboard's Add project: it registers an initialised repo as `forge project add` does and
// serves it at once, the same repo again is a no-op, every refusal leaves the machine index as it was, and
// registering never approves the project's trusted files, so its pool waits for a human's Start.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fakeClaude, serveProjects, tempRepo } from '../../helpers.ts';
import * as yaml from '#core/format/yaml.ts';
import { CONFIG_SCHEMA_VERSION } from '#core/job/schema.ts';
import { defaultProjectName } from '#engine/project/machine-index.ts';
import { trustApproved } from '#engine/project/trust-approval.ts';

/** A scratch repo set up with /forge: `.forge/config.yml`, with the daemon enabled when `daemon` is set. */
function initialized(daemon = false): ReturnType<typeof tempRepo> {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.forge'), { recursive: true });
  const config = daemon ? { schemaVersion: CONFIG_SCHEMA_VERSION, daemon: { enabled: true, command: 'claude {session}', maxConcurrent: 2 } } : { schemaVersion: CONFIG_SCHEMA_VERSION };
  fs.writeFileSync(path.join(r.dir, '.forge', 'config.yml'), yaml.stringify(config));
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

/** POST /api/projects with the page's token, a matching Origin and JSON: `raw` sends the text as it is. */
async function poster(port: number) {
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, { path: '/' })).text)![1]!;
  const headers = { 'x-forge-token': token, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' };
  const raw = (body: string) => hit(port, { method: 'POST', path: '/api/projects', headers, body });
  return { raw, post: (body: unknown) => raw(JSON.stringify(body)) };
}

const getJson = async (port: number, p: string) => {
  const r = await hit(port, { path: p });
  assert.equal(r.status, 200, `${p}: ${r.text}`);
  return JSON.parse(r.text);
};

/** The index's bytes, or null while there is none. */
const indexBytes = (home: string): string | null => {
  try {
    return fs.readFileSync(path.join(home, 'projects.json'), 'utf8');
  } catch {
    return null;
  }
};

test('POST /api/projects registers a repo and serves it at once', async () => {
  const a = initialized();
  const b = initialized();
  // No timed re-read: only the POST's own refresh can load the project.
  const s = await serveProjects([], { refreshMs: 3_600_000 });
  try {
    const { post } = await poster(s.port);
    const r = await post({ path: a.dir });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    const name = defaultProjectName(a.dir);
    assert.equal(body.added, true);
    assert.deepEqual([body.project.name, body.project.path, body.project.status, body.project.loaded], [name, fs.realpathSync(a.dir), 'ok', true]);
    assert.deepEqual(
      (await getJson(s.port, '/api/projects')).projects.map((p: { name: string }) => p.name),
      [name],
    );
    assert.deepEqual((await getJson(s.port, s.api(name, '/state'))).jobs, []);

    const custom = await post({ path: b.dir, name: 'custom' });
    assert.equal(custom.status, 200, custom.text);
    assert.deepEqual([JSON.parse(custom.text).added, JSON.parse(custom.text).project.name], [true, 'custom']);
    assert.equal((await hit(s.port, { path: s.api('custom', '/state') })).status, 200);
  } finally {
    await s.cleanup();
    a.cleanup();
    b.cleanup();
  }
});

test('the same repo again is a no-op', async () => {
  const a = initialized();
  const wt = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-add-wt-')));
  fs.rmdirSync(wt);
  a.git('worktree', 'add', '-q', '--detach', wt);
  fs.mkdirSync(path.join(a.dir, 'src'));
  const s = await serveProjects([]);
  try {
    const { post } = await poster(s.port);
    const first = JSON.parse((await post({ path: a.dir, name: 'mine' })).text);
    assert.equal(first.added, true);
    const before = indexBytes(s.home);
    assert.ok(before);
    for (const body of [{ path: path.join(a.dir, 'src') }, { path: wt }, { path: a.dir, name: 'another' }]) {
      const r = await post(body);
      assert.equal(r.status, 200, `${JSON.stringify(body)}: ${r.text}`);
      const got = JSON.parse(r.text);
      assert.deepEqual([got.added, got.project.name, got.project.path, got.project.loaded], [false, 'mine', a.dir, true], JSON.stringify(body));
      assert.equal(indexBytes(s.home), before, `${JSON.stringify(body)} leaves projects.json as it was`);
    }
  } finally {
    await s.cleanup();
    a.cleanup();
    fs.rmSync(wt, { recursive: true, force: true });
  }
});

test('refusals', async () => {
  const taken = initialized();
  const fresh = initialized();
  const bare = tempRepo();
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-add-plain-')));
  const missing = path.join(plain, 'gone');
  const random = `forge-add-missing-${crypto.randomBytes(6).toString('hex')}`;
  const s = await serveProjects([{ dir: taken.dir, name: 'taken' }]);
  try {
    const { raw, post } = await poster(s.port);
    const before = indexBytes(s.home);
    assert.ok(before);
    type Row = { why: string; send: () => Promise<{ status: number; text: string }>; status: number; error?: string };
    const rows: Row[] = [
      { why: 'an array body', send: () => raw('[]'), status: 400 },
      { why: 'a string body', send: () => raw('"x"'), status: 400 },
      { why: 'null', send: () => raw('null'), status: 400 },
      { why: 'not JSON', send: () => raw('{"path":'), status: 400 },
      { why: 'an unknown key', send: () => post({ path: fresh.dir, force: true }), status: 400 },
      { why: 'no path', send: () => post({}), status: 400 },
      { why: 'a non-string path', send: () => post({ path: 1 }), status: 400 },
      { why: 'a non-string name', send: () => post({ path: fresh.dir, name: 1 }), status: 400 },
      { why: 'an empty path', send: () => post({ path: '' }), status: 400 },
      { why: 'a relative path', send: () => post({ path: 'src/x' }), status: 400 },
      { why: "another user's home", send: () => post({ path: '~bob/x' }), status: 400 },
      { why: 'a NUL', send: () => post({ path: `${fresh.dir}\0x` }), status: 400 },
      { why: 'a newline', send: () => post({ path: `${fresh.dir}\nx` }), status: 400 },
      { why: 'a carriage return', send: () => post({ path: `${fresh.dir}\rx` }), status: 400 },
      { why: 'over 4096 characters', send: () => post({ path: `/${'a'.repeat(4096)}` }), status: 400 },
      { why: 'a bad name', send: () => post({ path: fresh.dir, name: 'Bad Name' }), status: 400 },
      { why: 'a missing directory', send: () => post({ path: missing }), status: 400, error: `${missing} is not a directory` },
      { why: 'not a git repo', send: () => post({ path: plain }), status: 400, error: `${plain} is not inside a git repository` },
      { why: 'no .forge/config.yml', send: () => post({ path: bare.dir }), status: 400, error: `${bare.dir} has no .forge/config.yml` },
      { why: 'a name another path holds', send: () => post({ path: fresh.dir, name: 'taken' }), status: 409, error: `the name taken is already registered for ${taken.dir}` },
      // Accepted as non-relative, then expanded under the home directory.
      { why: '~/ a missing directory', send: () => post({ path: `~/${random}` }), status: 400, error: `${path.join(os.homedir(), random)} is not a directory` },
    ];
    for (const r of rows) {
      const got = await r.send();
      assert.equal(got.status, r.status, `${r.why}: ${got.text}`);
      const error = JSON.parse(got.text).error;
      assert.equal(typeof error, 'string', r.why);
      if (r.error) assert.ok(error.includes(r.error), `${r.why}: ${error}`);
      assert.equal(indexBytes(s.home), before, `${r.why} leaves projects.json as it was`);
    }
    assert.deepEqual(
      (await getJson(s.port, '/api/projects')).projects.map((p: { name: string }) => p.name),
      ['taken'],
    );
  } finally {
    await s.cleanup();
    taken.cleanup();
    fresh.cleanup();
    bare.cleanup();
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('registering never approves trust', async () => {
  const a = initialized(true);
  const fake = fakeClaude();
  const s = await serveProjects([], { daemon: { claude: fake.adapter, pollMs: 3_600_000, syncMs: 0, reconcileMs: 0, graceMs: 50 } });
  try {
    const { post } = await poster(s.port);
    const r = await post({ path: a.dir, name: 'auto' });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(r.text).project.daemon.wanted, false, 'its pool is off');
    const daemons = (await getJson(s.port, s.api('auto', '/state'))).daemons;
    assert.deepEqual([daemons.enabled, daemons.wanted, daemons.needsApproval], [true, false, true], 'it waits for a human Start');
    assert.equal(trustApproved(s.home, a.dir), false);
    assert.equal(fake.children.length, 0, 'no claude child was spawned');
  } finally {
    await s.cleanup();
    a.cleanup();
  }
});
