// The CLI copy of job state (#448): what loadJob, listJobs and readEvents return once a job folder's
// job.json and events.jsonl are tampered with, and the jobs that predate the copy. Also the review
// directory, which a link planted in the job folder never redirects, the agent role names job.json
// keys take, and the capped reads of agent-written reviews and decisions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { defaults } from '../config/keys/defaults.ts';
import { jobDir, jobFiles, jobRecordDir } from '../paths.ts';
import { createJob, ensureReviewDir, listJobs, loadJob, markAgentsLost, parseDecision, readEvents, recordAgent, roundVerdicts, setJob, updateJob } from './store.ts';
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

test('recordAgent refuses a name that is not a role; markAgentsLost skips one', (t) => {
  const root = repo(t);
  const config = defaults();
  const id = createJob(root, config, { title: 'roles' }).id;
  const copies = () => jobFiles(root, id, 'job.json').map((f) => fs.readFileSync(f, 'utf8'));
  const before = copies();
  for (const role of ['__proto__', 'constructor', 'reviewer:../x']) {
    assert.throws(() => recordAgent(root, id, { role, phase: 'start' }, config), (e: any) => e.exitCode === 2, role);
  }
  assert.deepEqual(copies(), before, 'job.json is unchanged');
  assert.equal(Object.hasOwn(Object.prototype, 'status'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'runs'), false);

  recordAgent(root, id, { role: 'builder', phase: 'start' }, config);
  // A key planted before the check existed stays as it is, and is never ended through recordAgent.
  updateJob(root, id, (j) => {
    j.agents['reviewer:../x'] = { runs: 1, status: 'running' } as (typeof j.agents)[string];
  });
  assert.deepEqual(markAgentsLost(root, id, ['reviewer:../x', 'builder'], 'gone', config), ['builder']);
  const agents = loadJob(root, id).agents;
  assert.equal(agents.builder.status, 'lost');
  assert.equal(agents['reviewer:../x'].status, 'running');
});

test('review and decision files are read capped, never through a link or a FIFO', { timeout: 10_000 }, async (t) => {
  const root = repo(t);
  const id = createJob(root, defaults(), { title: 'capped' }).id;
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-outside-')));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const review = path.join(ensureReviewDir(root, id, 1), 'code.md');
  const decision = path.join(jobDir(root, id), 'decision.md');
  const verdict = (opts: { malformedAs?: 'changes' } = {}) => roundVerdicts(root, id, 1, ['code'], ['blocker', 'major'], opts).reviewers.code.verdict;
  const decided = () => parseDecision(root, id);
  const NONE = { decision: null, reason: null, autoMerge: false };
  const reset = () => [review, decision].forEach((f) => fs.rmSync(f, { force: true }));

  await t.test('a regular file under the cap parses as before', () => {
    reset();
    fs.writeFileSync(review, 'VERDICT: PASS\n');
    fs.writeFileSync(decision, 'APPROVE: ok\n');
    assert.equal(verdict(), 'PASS');
    assert.equal(decided().decision, 'APPROVE');
  });

  await t.test('a file over 1 MiB is malformed, and no decision', () => {
    reset();
    const pad = 'x'.repeat(2 * 1024 * 1024);
    fs.writeFileSync(review, `VERDICT: PASS\n${pad}`);
    fs.writeFileSync(decision, `APPROVE: ok\n${pad}`);
    assert.equal(verdict(), 'MALFORMED');
    assert.equal(verdict({ malformedAs: 'changes' }), 'CHANGES');
    assert.deepEqual(decided(), NONE);
  });

  await t.test('a symlink to a valid file outside is never followed', (st) => {
    reset();
    fs.writeFileSync(path.join(outside, 'review.md'), 'VERDICT: PASS\n');
    fs.writeFileSync(path.join(outside, 'decision.md'), 'APPROVE: ok\n');
    try {
      fs.symlinkSync(path.join(outside, 'review.md'), review);
      fs.symlinkSync(path.join(outside, 'decision.md'), decision);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return st.skip('cannot create a link here');
      throw e;
    }
    assert.equal(verdict(), 'MALFORMED');
    assert.deepEqual(decided(), NONE);
  });

  await t.test('a FIFO never blocks the read', { skip: process.platform === 'win32' && 'no FIFOs on Windows' }, () => {
    reset();
    execFileSync('mkfifo', [review, decision]);
    assert.equal(verdict(), 'MALFORMED');
    assert.deepEqual(decided(), NONE);
  });
});
