// The job-file routes (GET /api/p/:project/jobs/:id/file and /raw) read files the job's own agents write, so
// every read is confined to the real job dir (docs/architecture/dashboard-security.md): a link out, a
// FIFO, a device, a hard link or a symlinked job dir is a 404 that never blocks the server, private
// job files stay private under any name, and /raw serves only HTML mockups, capped.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { serveProjects, tempRepo } from '../../helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { createJob, jobDir } from '#core/job/store.ts';
import { recordKnown } from '#engine/guard/known-secrets.ts';

const POSIX = process.platform !== 'win32';
const MAX_FILE = 2 * 1024 * 1024;

type Reply = { status: number; headers: http.IncomingHttpHeaders; body: Buffer; text: string };

/** One GET on its own connection that fails, rather than waits, when the server takes over 5 s. */
function get(port: number, p: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString('utf8') });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error(`GET ${p} took over 5 s`)));
    req.on('error', reject);
    req.end();
  });
}

/** A scratch repo with one job, a server on it, and a separate dir on the same filesystem for outside files. */
async function setup() {
  const repo = tempRepo();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  const { config } = loadConfig(repo.dir);
  const id = createJob(repo.dir, config, { title: 'job files' }).id;
  const dir = jobDir(repo.dir, id);
  const s = await serveProjects([{ dir: repo.dir, name: 'a' }]);
  return {
    repo,
    outside,
    id,
    dir,
    port: s.port,
    cleanup: async () => {
      await s.cleanup();
      repo.cleanup();
      fs.rmSync(outside, { recursive: true, force: true });
    },
  };
}

test('job file reads stay inside the real job dir', async () => {
  const s = await setup();
  try {
    const secret = `outside-secret-${crypto.randomBytes(6).toString('hex')}`;
    const known = `known-value-${crypto.randomBytes(6).toString('hex')}`;
    recordKnown(s.repo.dir, s.id, { token: known });
    const png = crypto.randomBytes(64);
    fs.mkdirSync(path.join(s.dir, 'screenshots'));
    fs.writeFileSync(path.join(s.dir, 'screenshots', 'a.png'), png);
    fs.writeFileSync(path.join(s.dir, 'notes.md'), `notes ${known}\n`);
    for (const f of ['secret.md', 'secret.html', 'x.yml', 'x.html']) fs.writeFileSync(path.join(s.outside, f), secret);

    // The files a request may name, planted the way an agent could.
    const refused: { kind: 'file' | 'raw'; rel: string; job?: string }[] = [{ kind: 'file', rel: 'KNOWN-SECRETS.JSON' }, { kind: 'raw', rel: 'KNOWN-SECRETS.JSON' }];
    if (POSIX) {
      const at = (f: string) => path.join(s.dir, f);
      const ks = at('known-secrets.json');
      fs.symlinkSync(path.join(s.outside, 'secret.md'), at('link.md'));
      fs.symlinkSync(path.join(s.outside, 'secret.html'), at('link.html'));
      fs.symlinkSync(s.outside, at('h'));
      fs.symlinkSync('/dev/zero', at('zero.log'));
      fs.symlinkSync('/dev/zero', at('zero.html'));
      fs.linkSync(path.join(s.outside, 'secret.md'), at('hard.md'));
      fs.linkSync(path.join(s.outside, 'secret.html'), at('hard.html'));
      fs.symlinkSync(ks, at('private.md'));
      fs.symlinkSync(ks, at('private.html'));
      fs.linkSync(ks, at('private-hard.md'));
      fs.linkSync(ks, at('private-hard.html'));
      refused.push(
        ...(['link.md', 'h/x.yml', 'zero.log', 'hard.md', 'private.md', 'private-hard.md'] as const).map((rel) => ({ kind: 'file' as const, rel })),
        ...(['link.html', 'h/x.html', 'zero.html', 'hard.html', 'private.html', 'private-hard.html'] as const).map((rel) => ({ kind: 'raw' as const, rel })),
      );
      if (spawnSync('mkfifo', [at('pipe.log')]).status === 0 && spawnSync('mkfifo', [at('pipe.html')]).status === 0) {
        refused.push({ kind: 'file', rel: 'pipe.log' }, { kind: 'raw', rel: 'pipe.html' });
      }
      // A job dir that is itself a symlink: everything under it, screenshots included, is refused.
      const elsewhere = path.join(s.outside, 'job');
      fs.mkdirSync(path.join(elsewhere, 'screenshots'), { recursive: true });
      fs.writeFileSync(path.join(elsewhere, 'notes.md'), secret);
      fs.writeFileSync(path.join(elsewhere, 'm.html'), secret);
      fs.writeFileSync(path.join(elsewhere, 'screenshots', 'a.png'), secret);
      fs.symlinkSync(elsewhere, path.join(s.repo.dir, '.forge', 'jobs', 'linked'));
      refused.push({ kind: 'file', rel: 'notes.md', job: 'linked' }, { kind: 'raw', rel: 'm.html', job: 'linked' }, { kind: 'file', rel: 'screenshots/a.png', job: 'linked' });
    }

    for (const r of refused) {
      const p = `/api/p/a/jobs/${r.job ?? s.id}/${r.kind}?path=${encodeURIComponent(r.rel)}`;
      const got = await get(s.port, p);
      assert.deepEqual({ status: got.status, text: got.text }, { status: 404, text: 'not found' }, p);
      assert.ok(!got.text.includes(secret) && !got.text.includes(known), `${p} leaks nothing`);
      assert.equal((await get(s.port, '/api/p/a/state')).status, 200, `the server still answers after ${p}`);
    }

    // What the job really wrote is still served: text redacted, the screenshot byte for byte.
    const notes = await get(s.port, `/api/p/a/jobs/${s.id}/file?path=notes.md`);
    assert.deepEqual({ status: notes.status, type: notes.headers['content-type'], text: notes.text }, { status: 200, type: 'text/plain; charset=utf-8', text: 'notes [redacted]\n' });
    const shot = await get(s.port, `/api/p/a/jobs/${s.id}/file?path=screenshots/a.png`);
    assert.equal(shot.status, 200);
    assert.ok(shot.body.equals(png), 'exact bytes');
    assert.deepEqual(
      ['content-type', 'content-security-policy', 'cache-control', 'cross-origin-resource-policy', 'x-content-type-options'].map((h) => shot.headers[h]),
      ['image/png', "default-src 'none'", 'no-store', 'same-origin', 'nosniff'],
    );
  } finally {
    await s.cleanup();
  }
});

test('raw serves html mockups only, capped', async () => {
  const s = await setup();
  try {
    const known = `known-value-${crypto.randomBytes(6).toString('hex')}`;
    recordKnown(s.repo.dir, s.id, { token: known });
    const mockup = `<!doctype html><style>p{color:red}</style><p>é ${known} ✓</p>\n`;
    fs.writeFileSync(path.join(s.dir, 'mockup.html'), mockup);
    fs.mkdirSync(path.join(s.dir, 'logs'));
    fs.writeFileSync(path.join(s.dir, 'logs', 'dev.log'), '<script>alert(1)</script>\n');
    fs.writeFileSync(path.join(s.dir, 'notes.json'), '{"a":"<script>alert(1)</script>"}');
    fs.writeFileSync(path.join(s.dir, 'big.html'), Buffer.alloc(MAX_FILE + 1, 'a'));
    // Varied bytes, so a tail taken from the wrong offset can't match by accident.
    const big = Buffer.from(Array.from({ length: MAX_FILE + 4096 }, (_, i) => 97 + (i % 23)));
    fs.writeFileSync(path.join(s.dir, 'logs', 'big.log'), big);

    const raw = await get(s.port, `/api/p/a/jobs/${s.id}/raw?path=mockup.html`);
    assert.deepEqual({ status: raw.status, type: raw.headers['content-type'], text: raw.text }, { status: 200, type: 'text/html; charset=utf-8', text: mockup.replace(known, '[redacted]') });
    for (const rel of ['logs/dev.log', 'notes.json']) {
      const got = await get(s.port, `/api/p/a/jobs/${s.id}/raw?path=${rel}`);
      assert.deepEqual({ status: got.status, text: got.text }, { status: 404, text: 'not found' }, rel);
    }
    const tooBig = await get(s.port, `/api/p/a/jobs/${s.id}/raw?path=big.html`);
    assert.deepEqual({ status: tooBig.status, text: tooBig.text }, { status: 413, text: 'file too large' });
    const tail = await get(s.port, `/api/p/a/jobs/${s.id}/file?path=logs/big.log`);
    assert.equal(tail.status, 200);
    assert.equal(tail.text, `…truncated (${big.length} bytes); showing the last 2 MB…\n` + big.subarray(big.length - MAX_FILE).toString('utf8'));
  } finally {
    await s.cleanup();
  }
});
