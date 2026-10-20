// The dashboard server never serves a job's known value (lib/known-secrets.ts), and never serves the
// private job files that hold them.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from './helpers.ts';
import { startServer, stateFrame } from '../lib/server.ts';
import type { DaemonSessionState } from '../lib/types.ts';
import { defaults } from '../lib/config.ts';
import { sessionFiles } from '../lib/daemon.ts';
import { attachAgent, claimJob, createJob, jobDir, recordAgent } from '../lib/jobs.ts';
import { recordKnown } from '../lib/known-secrets.ts';
import { projectSlug } from '../lib/transcripts.ts';

const OWNER = '11111111-2222-4333-8444-555555555555';

function hit(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** A job whose known value sits in an event, a job file, a background log, a session log line and a transcript line. */
async function setup() {
  const repo = tempRepo();
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
  const srv = await startServer(root, { port: 0, projectsDir: projects });
  const port = Number(new URL(srv.url).port);
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, '/')).text)?.[1] ?? '';
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
