import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';
import { verifiedHead } from '../lib/worktree.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const commitAll = (cwd, msg) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};

test('end-to-end: init, intake, worktree, verify, eval isolation', () => {
  const repo = tempRepo();
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: repo.dir } });
    try {
      return JSON.parse(out);
    } catch {
      return out.trim();
    }
  };
  try {
    const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'echo build', test: 'test -f feature.txt', lint: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
    assert.equal(f('init', 'write', '--answers', answers).ok, true);
    assert.equal(f('config', 'validate').ok, true);
    assert.ok(fs.existsSync(path.join(repo.dir, '.forge', '.gitignore')));

    f('tracker', 'create', '--title', 'Ship feature');
    const job = f('next', '--claim', '--session', 's1');
    assert.equal(job.id, 'ship-feature');
    const wt = f('worktree', 'create', job.id);
    assert.equal(wt.ok, true);
    assert.equal(wt.port, 4100);
    assert.ok(fs.statSync(path.join(wt.path, '.git')).isFile(), 'non-eval jobs still get a git worktree');

    f('job', 'round', job.id);
    const failingVerify = () => {
      try {
        f('verify', job.id);
        assert.fail('verify should have failed');
      } catch (e) {
        return JSON.parse(e.stdout);
      }
    };
    let verify = failingVerify();
    assert.equal(verify.ok, false, 'test command fails before the feature exists');
    assert.equal(verify.attempt, 1);
    fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'x');
    verify = failingVerify();
    assert.equal(verify.failure.name, 'worktree-clean', 'uncommitted changes fail the gate before any command runs');
    assert.match(verify.failure.tail, /feature\.txt/);
    commitAll(wt.path, 'feature');
    const passed = f('verify', job.id);
    assert.equal(passed.ok, true);
    assert.equal(passed.attempt, 3);
    assert.equal(f('job', 'get', job.id, 'verify.1'), 'PASS');
    const attempts = f('job', 'get', job.id, 'verifyRuns');
    assert.equal(attempts.length, 3, 'every attempt is kept');
    assert.equal(attempts[2].sha.length, 40);
    const verifyDir = path.join(repo.dir, '.forge', 'jobs', job.id, 'verify');
    assert.ok(fs.existsSync(path.join(verifyDir, 'round-1-attempt-1.md')) && fs.existsSync(path.join(verifyDir, 'round-1-attempt-2.md')), 'earlier attempts are archived');
    assert.match(fs.readFileSync(path.join(verifyDir, 'round-1.md'), 'utf8'), /^VERIFY: PASS/);
    assert.equal(f('stats', '--json').quality.verifyFirstPassRate, 0, 'retries within a round do not count as a first pass');
    assert.equal(verifiedHead(repo.dir, job.id).verified, true);
    fs.writeFileSync(path.join(wt.path, 'later.txt'), 'x');
    commitAll(wt.path, 'later');
    assert.equal(verifiedHead(repo.dir, job.id).verified, false, 'a commit after verify is unverified evidence');

    fs.mkdirSync(path.join(repo.dir, '.forge', 'evals', 'hello', 'check', 'files'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.forge', 'evals', 'hello', 'task.yml'), 'title: Hello\nrequest: Create hello.txt\ncheck:\n  files: check/files\n  command: test -f hello.txt && test -f secret-check.txt\n');
    fs.writeFileSync(path.join(repo.dir, '.forge', 'evals', 'hello', 'check', 'files', 'secret-check.txt'), 'hidden');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'add forge + eval');
    const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
    const base = sh(repo.dir, 'rev-parse', 'HEAD');
    // A "solution" commit the eval builder must not be able to reach through git.
    repo.git('checkout', '-qb', 'solution');
    fs.writeFileSync(path.join(repo.dir, 'hello.txt'), 'the real fix');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'solution');
    const leak = sh(repo.dir, 'rev-parse', 'HEAD');
    repo.git('checkout', '-q', 'main');
    const run = f('eval', 'start', '--label', 'test');
    const evalJob = run.tasks[0].job;
    const ewt = f('job', 'get', evalJob, 'worktree');
    assert.deepEqual(sh(ewt, 'log', '--all', '--format=%H').split('\n'), [base], 'eval history holds only the base commit');
    assert.equal(sh(ewt, 'remote', '-v'), '');
    assert.ok(fs.statSync(path.join(ewt, '.git')).isDirectory(), 'eval checkout is a standalone clone');
    assert.equal(fs.existsSync(path.join(ewt, '.git', 'objects', 'info', 'alternates')), false);
    assert.equal(fs.existsSync(path.join(ewt, '.git', 'FETCH_HEAD')), false);
    assert.throws(() => sh(ewt, 'cat-file', '-e', leak), 'the solution commit is unreachable');
    assert.equal(sh(ewt, 'rev-parse', 'main'), base);
    assert.equal(fs.existsSync(path.join(ewt, '.forge', 'evals')), false, 'hidden checks are not visible in eval worktrees');
    assert.equal(fs.existsSync(path.join(ewt, '.forge', 'config.yml')), true);
    fs.writeFileSync(path.join(ewt, 'hello.txt'), 'hi');
    commitAll(ewt, 'hello');
    assert.deepEqual(sh(ewt, 'log', '--all', '--format=%H').split('\n'), [sh(ewt, 'rev-parse', 'HEAD'), base]);
    assert.equal(sh(ewt, 'diff', '--name-only', 'main...HEAD'), 'hello.txt');
    const graded = f('eval', 'grade', evalJob);
    assert.equal(graded.check.pass, true);
    fs.writeFileSync(path.join(ewt, 'scratch.txt'), 'x');
    assert.throws(() => execFileSync(process.execPath, [BIN, 'worktree', 'remove', evalJob], { cwd: repo.dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: repo.dir } }));
    assert.ok(fs.existsSync(ewt), 'a dirty eval checkout is kept without --force');
    f('worktree', 'remove', evalJob, '--force');
    assert.equal(fs.existsSync(ewt), false);
    assert.ok(!f('job', 'get', evalJob, 'worktree'), 'job.worktree is cleared');
    const runs = f('eval', 'runs');
    assert.equal(runs[0].status, 'done');
    assert.equal(runs[0].summary.checkPassRate, 1);
  } finally {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  }
});
