import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, jobDir, logEvent, recordAgent, roundVerdicts } from '#core/job/store.ts';
import { sleepSync } from '#core/os/process.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** A scratch repo with Forge initialised and a CLI bound to it through FORGE_ROOT. */
function scratch() {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env, stdio: 'pipe' });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  };
  const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' } }));
  f('init', 'write', '--answers', answers);
  fs.rmSync(answers, { force: true });
  return {
    repo,
    f,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(`${repo.dir}.worktrees`, { recursive: true, force: true });
    },
  };
}

test('forge job round and forge job paths create the review dirs before reviewers write into them', () => {
  const { f, cleanup } = scratch();
  try {
    const { id } = f('job', 'new', '--title', 'Review dirs');
    f('job', 'set', id, '--field', 'reviewers=["code"]');
    const p0 = f('job', 'paths', id);
    assert.ok(fs.statSync(p0.reviewDir).isDirectory(), 'paths creates the reviewDir it hands out, even before round 1');
    assert.ok(fs.statSync(path.dirname(p0.integrationReview)).isDirectory(), 'and the integration review dir');

    f('job', 'round', id);
    f('job', 'round', id);
    const round2 = path.join(p0.jobDir, 'review', 'round-2');
    assert.ok(fs.statSync(round2).isDirectory(), 'round creates the dir of the round it starts');
    assert.equal(f('job', 'paths', id).reviewDir, round2);

    // The failure this guards against: a shell redirect into the reviewDir.
    execFileSync('sh', ['-c', `cat > "${path.join(round2, 'code.md')}" <<'EOF'\nVERDICT: PASS\nEOF`]);
    assert.equal(f('job', 'verdicts', id, '--compact').outcome, 'PASS');
    assert.equal(f('job', 'paths', id).reviewDir, round2, 'paths is idempotent over an existing dir');
  } finally {
    cleanup();
  }
});

test('forge job verdicts --compact reports MISSING for a reviewer that ended without writing its file', () => {
  const { f, cleanup } = scratch();
  try {
    const { id } = f('job', 'new', '--title', 'Missing review');
    f('job', 'set', id, '--field', 'reviewers=["code","tests"]');
    f('job', 'round', id);
    const { reviewDir } = f('job', 'paths', id);
    const verdicts = () => f('job', 'verdicts', id, '--compact');

    let v = verdicts();
    assert.equal(v.outcome, 'PENDING', 'no reviewer has run yet');
    assert.equal(v.missing, undefined);

    f('job', 'agent', id, 'start', '--role', 'reviewer:code', '--model', 'sonnet');
    f('job', 'agent', id, 'start', '--role', 'reviewer:tests', '--model', 'sonnet');
    f('job', 'agent', id, 'end', '--role', 'reviewer:code', '--summary', 'REVIEW code: PASS · blockers 0 · majors 0');
    v = verdicts();
    assert.deepEqual(v.reviewers, { code: 'MISSING', tests: 'PENDING' });
    assert.equal(v.outcome, 'PENDING', 'a reviewer still running keeps the round pending');
    assert.deepEqual(v.missing, { code: path.join(reviewDir, 'code.md') }, 'the expected absolute path, ready for a re-spawn brief');

    fs.writeFileSync(path.join(reviewDir, 'tests.md'), 'VERDICT: PASS\n');
    f('job', 'agent', id, 'end', '--role', 'reviewer:tests');
    v = verdicts();
    assert.equal(v.outcome, 'MISSING');
    assert.equal(v.complete, false);
    assert.deepEqual(v.reviewers, { code: 'MISSING', tests: 'PASS' });
    const full = f('job', 'verdicts', id);
    assert.deepEqual(full.reviewers.code, { verdict: 'MISSING', file: path.join('review', 'round-1', 'code.md'), path: path.join(reviewDir, 'code.md') });
    assert.equal(f('job', 'show', id, '--full').verdicts[1], undefined, 'an incomplete round records no verdicts');

    f('job', 'agent', id, 'start', '--role', 'reviewer:code', '--model', 'sonnet');
    assert.equal(verdicts().reviewers.code, 'PENDING', 'a re-spawned reviewer is pending again');
    fs.writeFileSync(path.join(reviewDir, 'code.md'), 'VERDICT: PASS\n');
    f('job', 'agent', id, 'end', '--role', 'reviewer:code');
    v = verdicts();
    assert.deepEqual({ outcome: v.outcome, complete: v.complete, missing: v.missing }, { outcome: 'PASS', complete: true, missing: undefined });

    // A reviewer that ended in round 1 says nothing about round 2's file.
    f('job', 'round', id);
    assert.deepEqual(verdicts().reviewers, { code: 'PENDING', tests: 'PENDING' });
  } finally {
    cleanup();
  }
});

test('roundVerdicts: an integration review is MISSING only for a reviewer started after the conflicted integration', () => {
  const repo = tempRepo();
  try {
    const root = repo.dir;
    const config = defaults();
    const job = createJob(root, config, { title: 'Integration missing', issues: [{ tracker: 'local', ref: 'integ-missing', url: null }] });
    const integ = () => roundVerdicts(root, job.id, 'integration', ['code'], ['blocker', 'major']);
    recordAgent(root, job.id, { role: 'reviewer:code', phase: 'start' }, config);
    recordAgent(root, job.id, { role: 'reviewer:code', phase: 'end' }, config);
    assert.equal(integ().outcome, 'PENDING', 'the round review ran, but no integration review has');
    sleepSync(5); // timestamps have millisecond resolution

    logEvent(root, job.id, 'integrate-conflicts', { strategy: 'merge', conflicts: ['a.ts'], behind: 1 });
    assert.equal(integ().outcome, 'PENDING', 'the earlier round reviewer predates the integration');
    recordAgent(root, job.id, { role: 'reviewer:code', phase: 'start' }, config);
    assert.equal(integ().outcome, 'PENDING');
    recordAgent(root, job.id, { role: 'reviewer:code', phase: 'end' }, config);
    const v = integ();
    assert.equal(v.outcome, 'MISSING');
    assert.equal(v.reviewers.code.path, path.join(jobDir(root, job.id), 'review', 'integration', 'code.md'));
  } finally {
    repo.cleanup();
  }
});
