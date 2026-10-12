import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tempRepo } from './helpers.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'factory');

test('end-to-end: init, intake, worktree, verify, eval isolation', () => {
  const repo = tempRepo();
  const f = (...args) => {
    const out = execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env: { ...process.env, FACTORY_ROOT: repo.dir } });
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
    assert.ok(fs.existsSync(path.join(repo.dir, '.factory', '.gitignore')));

    f('tracker', 'create', '--title', 'Ship feature');
    const job = f('next', '--claim', '--session', 's1');
    assert.equal(job.id, 'ship-feature');
    const wt = f('worktree', 'create', job.id);
    assert.equal(wt.ok, true);
    assert.equal(wt.port, 4100);

    f('job', 'round', job.id);
    let verify;
    try {
      f('verify', job.id);
    } catch (e) {
      verify = JSON.parse(e.stdout);
    }
    assert.equal(verify.ok, false, 'test command fails before the feature exists');
    fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'x');
    assert.equal(f('verify', job.id).ok, true);
    assert.equal(f('job', 'get', job.id, 'verify.1'), 'PASS');

    fs.mkdirSync(path.join(repo.dir, '.factory', 'evals', 'hello', 'check', 'files'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, '.factory', 'evals', 'hello', 'task.yml'), 'title: Hello\nrequest: Create hello.txt\ncheck:\n  files: check/files\n  command: test -f hello.txt && test -f secret-check.txt\n');
    fs.writeFileSync(path.join(repo.dir, '.factory', 'evals', 'hello', 'check', 'files', 'secret-check.txt'), 'hidden');
    repo.git('add', '-A');
    repo.git('commit', '-qm', 'add factory + eval');
    const run = f('eval', 'start', '--label', 'test');
    const evalJob = run.tasks[0].job;
    const ewt = f('job', 'get', evalJob, 'worktree');
    assert.equal(fs.existsSync(path.join(ewt, '.factory', 'evals')), false, 'hidden checks are not visible in eval worktrees');
    assert.equal(fs.existsSync(path.join(ewt, '.factory', 'config.yml')), true);
    fs.writeFileSync(path.join(ewt, 'hello.txt'), 'hi');
    execFileSync('git', ['add', '-A'], { cwd: ewt });
    execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', 'hello'], { cwd: ewt });
    const graded = f('eval', 'grade', evalJob);
    assert.equal(graded.check.pass, true);
    const runs = f('eval', 'runs');
    assert.equal(runs[0].status, 'done');
    assert.equal(runs[0].summary.checkPassRate, 1);
  } finally {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  }
});
