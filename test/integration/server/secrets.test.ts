// The dashboard server never serves a job's known value (lib/known-secrets.ts), and never serves the
// private job files that hold them: not on a route, not in a state frame, not in the support bundle.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { repoTemplate } from '../../helpers.ts';
import { FIXTURE_DIST } from '../../dist.ts';
import { startServer, stateFrame } from '../../../lib/server.ts';
import type { DaemonSessionState } from '../../../lib/types.ts';
import { defaults } from '../../../lib/config.ts';
import { sessionFiles } from '../../../lib/daemon-files.ts';
import { attachAgent, claimJob, createJob, jobDir, recordAgent } from '../../../lib/jobs.ts';
import { recordKnown } from '../../../lib/known-secrets.ts';
import { fingerprint, mask, refuseSecrets, textUnit } from '../../../lib/secrets.ts';
import { projectSlug } from '../../../lib/transcripts.ts';
import { hasBinary } from '../../../lib/util.ts';

const OWNER = '11111111-2222-4333-8444-555555555555';

// Every test needs only a git repo: the jobs are created in-process.
const scratchRepo = repoTemplate(() => {});

function hit(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string }> {
  return new Promise((resolve, reject) => {
    // A fresh socket per request: a pooled keep-alive socket the server times out under load resets.
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode!, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function serve(root: string, projects: string) {
  const srv = await startServer(root, { port: 0, projectsDir: projects, distDir: FIXTURE_DIST });
  const port = Number(new URL(srv.url).port);
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, '/')).text)?.[1] ?? '';
  assert.ok(token, 'the page carries the token');
  return { srv, port, token };
}

/** A job whose known value sits in an event, a job file, a background log, a session log line and a transcript line. */
async function setup() {
  const repo = scratchRepo();
  const root = repo.dir;
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projects-'));
  const value = `kv"\\-${crypto.randomBytes(8).toString('hex')}`;
  const config = defaults();
  const job = createJob(root, config, { title: 'Secrets' });
  claimJob(root, job.id, OWNER);
  recordAgent(root, job.id, { role: 'reviewer:security', phase: 'start', model: 'opus' }, config);
  attachAgent(root, job.id, 'reviewer:security', 'abc123');
  recordKnown(root, job.id, { DB: value });
  const dir = jobDir(root, job.id);
  // Written past logEvent, as an older Forge or the agent itself could have.
  fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), type: 'note', text: `leak ${value}` })}\n`);
  fs.writeFileSync(path.join(dir, 'build.md'), `# Build\n\nleak ${value}\n`);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'logs', 'dev.log'), `server says ${value}\n`);
  fs.writeFileSync(path.join(dir, 'backing-db.json'), JSON.stringify({ v: 1, databases: {} }));
  const f = sessionFiles(root, job.id);
  fs.mkdirSync(f.dir, { recursive: true });
  fs.writeFileSync(f.log, `${JSON.stringify({ type: 'forge-raw', at: new Date().toISOString(), text: `session ${value}` })}\n`);
  const agentFile = path.join(projects, projectSlug(root), OWNER, 'subagents', 'agent-abc123.jsonl');
  fs.mkdirSync(path.dirname(agentFile), { recursive: true });
  fs.writeFileSync(agentFile, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-15T10:00:00.000Z', message: { content: [{ type: 'text', text: `transcript ${value}` }] } })}\n`);
  const { srv, port, token } = await serve(root, projects);
  return {
    root,
    job,
    value,
    get: (p: string) => hit(port, p, { 'x-forge-token': token, origin: `http://127.0.0.1:${port}` }),
    cleanup: async () => {
      await srv.close();
      repo.cleanup();
      fs.rmSync(projects, { recursive: true, force: true });
    },
  };
}

describe('server secrets', { concurrency: 4 }, () => {
  test('known values never leave the server', async () => {
    const s = await setup();
    try {
      const escaped = JSON.stringify(s.value).slice(1, -1);
      const id = s.job.id;
      const routes = [
        '/api/state',
        `/api/jobs/${id}`,
        `/api/jobs/${id}/file?path=build.md`,
        `/api/jobs/${id}/file?path=logs/dev.log`,
        `/api/jobs/${id}/raw?path=logs/dev.log`,
        `/api/daemons/log?session=${id}`,
        `/api/jobs/${id}/transcript?agent=reviewer:security`,
      ];
      for (const p of routes) {
        const r = await s.get(p);
        assert.equal(r.status, 200, `${p}: ${r.text}`);
        assert.ok(!r.text.includes(s.value) && !r.text.includes(escaped), `${p} serves the value`);
        assert.ok(r.text.includes('[redacted]'), `${p} shows where it was`);
      }
    } finally {
      await s.cleanup();
    }
  });

  test('private job files are not served', async () => {
    const s = await setup();
    try {
      const id = s.job.id;
      for (const name of ['known-secrets.json', 'backing-db.json']) {
        assert.ok(fs.existsSync(path.join(jobDir(s.root, id), name)));
        for (const route of ['file', 'raw']) {
          for (const p of [name, `./${name}`, `logs/../${name}`]) {
            const r = await s.get(`/api/jobs/${id}/${route}?path=${encodeURIComponent(p)}`);
            assert.equal(r.status, 404, `${route} ${p}`);
          }
        }
      }
      // Another letter case (the default macOS volume ignores it) and links to a private file.
      for (const route of ['file', 'raw']) for (const p of ['KNOWN-SECRETS.JSON', 'Backing-DB.json']) assert.equal((await s.get(`/api/jobs/${id}/${route}?path=${p}`)).status, 404, `${route} ${p}`);
      const dir = jobDir(s.root, id);
      fs.mkdirSync(path.join(dir, 'screenshots'), { recursive: true });
      let linked = true;
      try {
        fs.symlinkSync('../known-secrets.json', path.join(dir, 'logs', 'x.json'));
        fs.symlinkSync('../backing-db.json', path.join(dir, 'screenshots', 'x.png'));
      } catch {
        linked = false; // Windows without the symlink privilege
      }
      if (linked) {
        for (const p of ['logs/x.json', 'screenshots/x.png']) for (const route of ['file', 'raw']) assert.equal((await s.get(`/api/jobs/${id}/${route}?path=${p}`)).status, 404, `${route} ${p}`);
      }
      const files: string[] = JSON.parse((await s.get(`/api/jobs/${id}`)).text).files;
      assert.ok(files.includes('build.md'));
      assert.equal(files.some((f) => f.endsWith('known-secrets.json') || f.endsWith('backing-db.json')), false);
    } finally {
      await s.cleanup();
    }
  });

  test('daemon state frames are redacted', () => {
    const value = `kv"\\-${crypto.randomBytes(8).toString('hex')}`;
    const escaped = JSON.stringify(value).slice(1, -1);
    const st: DaemonSessionState = {
      scope: 'job-1', wanted: true, running: true, status: 'busy', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false,
      lastError: `last turn failed: ${value}`,
      permissions: [{ id: 'p1', tool: 'Bash', input: JSON.stringify({ command: `curl -H "Authorization: ${value}"` }), description: null, agentId: null, blockedPath: null, sessionRules: [], sessionDirs: [] } as DaemonSessionState['permissions'][number]],
      permissionMode: null, kept: null, effort: null,
    };
    const frame = stateFrame(st, [value]);
    assert.ok(frame.startsWith('event: state\ndata: '));
    assert.ok(!frame.includes(value) && !frame.includes(escaped), frame);
    const sent = JSON.parse(frame.split('data: ')[1]);
    assert.equal(sent.lastError, 'last turn failed: [redacted]');
    assert.equal(JSON.parse(sent.permissions[0].input).command, 'curl -H "Authorization: [redacted]"', 'the JSON-escaped form in a tool input');
    assert.equal(stateFrame(st, []), `event: state\ndata: ${JSON.stringify(st)}\n\n`, 'nothing to redact');
  });
});

/** A job with a spec.md marker, served: the support bundle must carry no text. */
async function bundleSetup() {
  const repo = scratchRepo();
  const root = repo.dir;
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projects-'));
  const job = createJob(root, defaults(), { title: 'Bundle route' });
  fs.writeFileSync(path.join(jobDir(root, job.id), 'spec.md'), '# Spec\nSPEC-ROUTE-MARKER\n');
  const { srv, port, token } = await serve(root, projects);
  return {
    root,
    job,
    port,
    token,
    get: (p: string, headers: Record<string, string> = { 'x-forge-token': token }) => hit(port, p, headers),
    cleanup: async () => {
      await srv.close();
      repo.cleanup();
      fs.rmSync(projects, { recursive: true, force: true });
    },
  };
}

describe('GET /api/doctor/bundle', { concurrency: 4 }, () => {
  test('guards', async () => {
    const s = await bundleSetup();
    try {
      const ours = `http://127.0.0.1:${s.port}`;
      assert.equal((await s.get('/api/doctor/bundle', {})).status, 403, 'no token');
      assert.equal((await s.get('/api/doctor/bundle', { 'x-forge-token': 'nope' })).status, 403, 'wrong token');
      assert.equal((await s.get(`/api/doctor/bundle?${new URLSearchParams({ token: s.token })}`, {})).status, 403, 'a query token is not a token');
      assert.equal((await s.get('/api/doctor/bundle', { 'x-forge-token': s.token, origin: 'https://evil.example' })).status, 403, 'foreign origin');
      assert.equal((await s.get('/api/doctor/bundle', { 'x-forge-token': s.token, 'sec-fetch-site': 'cross-site' })).status, 403, 'cross-site fetch');
      assert.equal((await s.get('/api/doctor/bundle', { 'x-forge-token': s.token, host: `evil.example:${s.port}` })).status, 421, 'rebinding host');
      const bad = await s.get('/api/doctor/bundle?job=../etc', { 'x-forge-token': s.token, origin: ours });
      assert.equal(bad.status, 400);
      assert.ok(JSON.parse(bad.text).error);
      const missing = await s.get('/api/doctor/bundle?job=no-such-job');
      assert.equal(missing.status, 404);
      assert.ok(JSON.parse(missing.text).error);
    } finally {
      await s.cleanup();
    }
  });

  test('bundle omits private job files', { skip: !hasBinary('unzip') && 'needs unzip' }, async () => {
    const s = await bundleSetup();
    try {
      const value = `kv-${crypto.randomBytes(8).toString('hex')}`;
      recordKnown(s.root, s.job.id, { DB: value });
      const dir = jobDir(s.root, s.job.id);
      fs.writeFileSync(path.join(dir, 'backing-db.json'), JSON.stringify({ v: 1, databases: {} }));
      // `cmd` is not a prose key, so the bundle keeps it: only the known pass takes the value out.
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), type: 'note', cmd: `leak ${value}` })}\n`);
      // A refused gate logs a secret-found event: its finding must not carry the value's sha256 or prefix either.
      assert.throws(() => refuseSecrets(s.root, defaults(), [textUnit('(pr body)', `uses ${value}`)], { what: 'the PR body', id: s.job.id, gate: 'pr' }), /known-secret/);
      const r = await s.get(`/api/doctor/bundle?job=${s.job.id}`, { 'x-forge-token': s.token, origin: `http://127.0.0.1:${s.port}` });
      assert.equal(r.status, 200);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bundle-private-'));
      try {
        const file = path.join(tmp, 'b.zip');
        fs.writeFileSync(file, r.body);
        const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
        assert.ok(names.includes(`jobs/${s.job.id}/events.jsonl`), names.join(','));
        assert.equal(names.some((n) => n.includes('known-secrets') || n.includes('backing-db')), false, names.join(','));
        const all = execFileSync('unzip', ['-p', file], { encoding: 'utf8' });
        assert.ok(!all.includes(value), 'no known value in any entry');
        assert.match(all, /known-secret/, 'the secret-found event is in the bundle');
        assert.ok(!all.includes(fingerprint(value).slice('sha256:'.length)), "no known value's sha256");
        assert.ok(!all.includes(mask(value)), "no known value's masked prefix");
        assert.match(all, /leak <secret:known>/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      await s.cleanup();
    }
  });

  test('returns the redacted zip, never with text', async () => {
    const s = await bundleSetup();
    try {
      for (const q of ['', `?job=${s.job.id}`, `?job=${s.job.id}&include-text=1`, '?include-text=1']) {
        const r = await s.get(`/api/doctor/bundle${q}`, { 'x-forge-token': s.token, origin: `http://127.0.0.1:${s.port}`, 'sec-fetch-site': 'same-origin' });
        assert.equal(r.status, 200, `${q}: ${r.text.slice(0, 200)}`);
        assert.equal(r.headers['content-type'], 'application/zip');
        assert.match(String(r.headers['content-disposition']), /^attachment; filename="forge-support-\d{4}-\d{2}-\d{2}\.zip"$/);
        assert.equal(r.headers['cache-control'], 'no-store');
        assert.equal(r.headers['x-content-type-options'], 'nosniff');
        assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin');
        assert.ok(r.body.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'a zip');
        assert.ok(!r.body.includes('SPEC-ROUTE-MARKER'), 'no text');
        if (hasBinary('unzip')) {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bundle-route-'));
          try {
            const file = path.join(dir, 'b.zip');
            fs.writeFileSync(file, r.body);
            assert.match(execFileSync('unzip', ['-t', file], { encoding: 'utf8' }), /No errors detected/);
            const names = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n').filter(Boolean);
            assert.ok(names.includes(`jobs/${s.job.id}/job.json`), names.join(','));
            assert.ok(!names.some((n) => n.includes('/text/') || n.endsWith('diff.patch')), names.join(','));
            const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'manifest.json'], { encoding: 'utf8' }));
            assert.equal(manifest.includeText, false);
          } finally {
            fs.rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    } finally {
      await s.cleanup();
    }
  });
});
