import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { tempRepo } from './helpers.ts';
import { defaults } from '../lib/config.ts';
import crypto from 'node:crypto';
import { createJob, jobDir } from '../lib/jobs.ts';
import { recordKnown } from '../lib/known-secrets.ts';
import { startServer } from '../lib/server.ts';
import { hasBinary } from '../lib/util.ts';

function hit(port: number, p: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function setup() {
  const repo = tempRepo();
  const root = repo.dir;
  const job = createJob(root, defaults(), { title: 'Bundle route' });
  fs.writeFileSync(path.join(jobDir(root, job.id), 'spec.md'), '# Spec\nSPEC-ROUTE-MARKER\n');
  const srv = await startServer(root, { port: 0, projectsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'forge-projects-')) });
  const port = Number(new URL(srv.url).port);
  const token = /name="forge-token" content="([0-9a-f]+)"/.exec((await hit(port, '/')).body.toString('utf8'))?.[1] ?? '';
  assert.ok(token, 'the page carries the token');
  return {
    root,
    job,
    port,
    token,
    get: (p: string, headers: Record<string, string> = { 'x-forge-token': token }) => hit(port, p, headers),
    cleanup: async () => {
      await srv.close();
      repo.cleanup();
    },
  };
}

describe('GET /api/doctor/bundle', { concurrency: 4 }, () => {
  test('guards', async () => {
    const s = await setup();
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
      assert.ok(JSON.parse(bad.body.toString('utf8')).error);
      const missing = await s.get('/api/doctor/bundle?job=no-such-job');
      assert.equal(missing.status, 404);
      assert.ok(JSON.parse(missing.body.toString('utf8')).error);
    } finally {
      await s.cleanup();
    }
  });

  test('bundle omits private job files', { skip: !hasBinary('unzip') && 'needs unzip' }, async () => {
    const s = await setup();
    try {
      const value = `kv-${crypto.randomBytes(8).toString('hex')}`;
      recordKnown(s.root, s.job.id, { DB: value });
      const dir = jobDir(s.root, s.job.id);
      fs.writeFileSync(path.join(dir, 'backing-db.json'), JSON.stringify({ v: 1, databases: {} }));
      // `cmd` is not a prose key, so the bundle keeps it: only the known pass takes the value out.
      fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({ v: 1, ts: new Date().toISOString(), type: 'note', cmd: `leak ${value}` })}\n`);
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
        assert.match(all, /leak <secret:known>/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    } finally {
      await s.cleanup();
    }
  });

  test('returns the redacted zip, never with text', async () => {
    const s = await setup();
    try {
      for (const q of ['', `?job=${s.job.id}`, `?job=${s.job.id}&include-text=1`, '?include-text=1']) {
        const r = await s.get(`/api/doctor/bundle${q}`, { 'x-forge-token': s.token, origin: `http://127.0.0.1:${s.port}`, 'sec-fetch-site': 'same-origin' });
        assert.equal(r.status, 200, `${q}: ${r.body.toString('utf8').slice(0, 200)}`);
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
