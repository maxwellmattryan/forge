// The CLI copy of job state (#448): what loadJob, listJobs and readEvents return once a job folder's
// job.json and events.jsonl are tampered with, and the jobs that predate the copy. Also the review
// directory, which a link planted in the job folder never redirects.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '../config/keys/defaults.ts';
import { jobDir, jobRecordDir } from '../paths.ts';
import { createJob, ensureReviewDir, listJobs, loadJob, readEvents, setJob, updateJob } from './store.ts';
import type { ProtectedPaths } from '../types.ts';

const FLAG: ProtectedPaths = { hits: [{ path: '.github/workflows/ci.yml', rule: 0, glob: '.github/**', reason: 'CI', blob: null }], more: 0, at: '2026-10-01T00:00:00.000Z', gate: 'verify', head: null };

function repo(t: any) {
  const r = tempRepo();
  t.after(r.cleanup);
  return r.dir;
}

test('the CLI copy is what Forge reads', (t) => {
  const root = repo(t);
  const job = createJob(root, defaults(), { title: 'guarded' });
  setJob(root, job.id, { owned: { 'pr.pushedSha': 'a'.repeat(40) } });
  updateJob(root, job.id, (j) => {
    j.protectedPaths = FLAG;
    j.budget.limits = { ...j.budget.limits, tokens: 1000 };
    j.usage.totalTokens = 900;
  });
  assert.ok(fs.statSync(path.join(jobRecordDir(root, job.id), 'job.json')).isFile(), 'the copy exists');
  assert.ok(fs.statSync(path.join(jobRecordDir(root, job.id), 'events.jsonl')).isFile(), 'with its events');
  const before = { job: loadJob(root, job.id), listed: listJobs(root).find((j) => j.id === job.id), events: readEvents(root, job.id) };

  const folder = jobDir(root, job.id);
  const raw = JSON.parse(fs.readFileSync(path.join(folder, 'job.json'), 'utf8'));
  const tampers: { name: string; apply: () => void }[] = [
    { name: 'pr.pushedSha', apply: () => (raw.pr = { ...raw.pr, pushedSha: 'b'.repeat(40) }) },
    { name: 'budget.limits', apply: () => (raw.budget.limits.tokens = 10 ** 9) },
    { name: 'usage.totalTokens', apply: () => (raw.usage.totalTokens = 0) },
    { name: 'protectedPaths: null', apply: () => (raw.protectedPaths = null) },
  ];
  for (const tamper of tampers) tamper.apply();
  fs.writeFileSync(path.join(folder, 'job.json'), JSON.stringify(raw));
  const ts = new Date(Date.now() + 60_000).toISOString();
  fs.appendFileSync(path.join(folder, 'events.jsonl'), `${JSON.stringify({ v: 2, ts, type: 'human', action: 'approve', actor: { source: 'cli', login: 'x' } })}\n`);
  fs.appendFileSync(path.join(folder, 'events.jsonl'), `${JSON.stringify({ v: 2, ts, type: 'decision', decision: 'APPROVE' })}\n`);

  assert.deepEqual(loadJob(root, job.id), before.job, `loadJob ignores ${tampers.map((x) => x.name).join(', ')}`);
  assert.deepEqual(listJobs(root).find((j) => j.id === job.id), before.listed, 'listJobs too');
  assert.deepEqual(readEvents(root, job.id), before.events, 'readEvents ignores the appended lines');
  // protectedApproved's inputs (lib/engine/guard/protected.ts, a layer this test may not import): the flag stands and no human approved it.
  assert.deepEqual(loadJob(root, job.id).protectedPaths, FLAG, 'the protected flag stands');
  assert.ok(!readEvents(root, job.id).some((e) => e.type === 'human' || e.type === 'decision'), 'no approve line is read');

  setJob(root, job.id, { note: 'next write' });
  const mirrored = JSON.parse(fs.readFileSync(path.join(folder, 'job.json'), 'utf8'));
  assert.deepEqual(
    { sha: mirrored.pr.pushedSha, tokens: mirrored.budget.limits.tokens, used: mirrored.usage.totalTokens, flag: mirrored.protectedPaths },
    { sha: 'a'.repeat(40), tokens: 1000, used: 900, flag: FLAG },
    'the next write rewrites the job folder from the copy',
  );
});

test('a CLI copy without a job folder is no job, and a job without a copy reads its folder', (t) => {
  const root = repo(t);
  const config = defaults();
  // An issue ref makes the id deterministic (12-gone), so the second createJob takes the same one.
  const opts = { title: 'gone', issues: [{ tracker: 'backlog', ref: '12', url: null }] };
  const job = createJob(root, config, opts);
  fs.rmSync(jobDir(root, job.id), { recursive: true, force: true });
  assert.throws(() => loadJob(root, job.id), (e: any) => e.code === 'not_found', 'a leftover copy is not a job');
  assert.equal(listJobs(root).length, 0);

  // createJob reuses the id (its folder is free) and starts the copy fresh.
  const again = createJob(root, config, opts);
  assert.equal(again.id, job.id);
  assert.deepEqual(readEvents(root, again.id).map((e) => e.type), ['created']);
  assert.equal(loadJob(root, again.id).createdAt, again.createdAt);

  const dir = jobDir(root, 'by-hand');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(jobDir(root, job.id), 'job.json'), 'utf8')), id: 'by-hand', title: 'by hand' }));
  assert.equal(loadJob(root, 'by-hand').title, 'by hand', 'a job folder with no copy loads from the folder');
  setJob(root, 'by-hand', { note: 'written' });
  assert.equal(fs.existsSync(jobRecordDir(root, 'by-hand')), false, 'and gets no copy');
  assert.deepEqual(readEvents(root, 'by-hand').map((e) => e.type), ['note']);
});

test('the review directory is never created through a link', (t) => {
  const root = repo(t);
  const linked = createJob(root, defaults(), { title: 'linked review' });
  const clean = createJob(root, defaults(), { title: 'clean review' });
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const review = path.join(jobDir(root, linked.id), 'review');
  fs.rmSync(review, { recursive: true, force: true });
  try {
    // A directory symlink on POSIX, a junction (no privilege needed) on Windows.
    fs.symlinkSync(outside, review, 'junction');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPERM') return t.skip('cannot create a link here');
    throw e;
  }
  assert.throws(() => ensureReviewDir(root, linked.id, 1), /not a real directory/);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing is created in the link target');

  const dir = ensureReviewDir(root, clean.id, 1);
  assert.equal(dir, path.join(jobDir(root, clean.id), 'review', 'round-1'), 'the lexical path is returned');
  assert.ok(fs.lstatSync(dir).isDirectory());
});
