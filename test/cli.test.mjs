import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { scratchGitConfig, tempRepo } from './helpers.mjs';
import { createWorktree, removeWorktree, verifiedHead } from '../lib/worktree.mjs';
import { loadConfig } from '../lib/config.mjs';
import { setJob } from '../lib/jobs.mjs';

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
    // The eval checkout is a standalone clone, so it does not share the scratch repo's config.
    scratchGitConfig((...args) => sh(ewt, ...args));
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

    // job.worktree is writable state: a bad value must never turn removal into rm -rf of the main checkout.
    f('job', 'set', evalJob, '--field', `worktree=${repo.dir}`);
    assert.throws(() => removeWorktree(repo.dir, evalJob, { force: true }), /refusing to delete/);
    assert.ok(fs.existsSync(path.join(repo.dir, '.git')) && fs.existsSync(path.join(repo.dir, 'README.md')), 'main checkout survives');
    f('job', 'set', evalJob, '--field', 'worktree=null');

    const { config } = loadConfig(repo.dir);
    const { id: iso } = f('job', 'new', '--title', 'Isolated paths');
    const isoDir = path.join(`${repo.dir}.wt`, iso);
    assert.throws(() => createWorktree(repo.dir, config, iso, { isolate: true, from: 'no-such-ref' }), /no-such-ref/);
    assert.equal(fs.existsSync(isoDir), false, 'an unresolvable base leaves no directory behind');
    fs.mkdirSync(isoDir);
    fs.writeFileSync(path.join(isoDir, 'keep.txt'), 'mine');
    assert.throws(() => createWorktree(repo.dir, config, iso, { isolate: true }), /already exists/);
    assert.equal(fs.readFileSync(path.join(isoDir, 'keep.txt'), 'utf8'), 'mine', 'a pre-existing directory is left untouched');
    fs.rmSync(isoDir, { recursive: true });
    assert.equal(createWorktree(repo.dir, config, iso, { isolate: true }).ok, true);
    assert.throws(() => removeWorktree(repo.dir, iso), /refusing to delete/, 'only eval jobs get directory deletion');
    setJob(repo.dir, iso, { fields: { eval: { run: 'r', task: 't' } } });
    removeWorktree(repo.dir, iso);
    assert.equal(fs.existsSync(isoDir), false, 'a clean eval clone is removed without --force');
    const runs = f('eval', 'runs');
    assert.equal(runs[0].status, 'done');
    assert.equal(runs[0].summary.checkPassRate, 1);
  } finally {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  }
});

test('verify integrity: warn and block', () => {
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
  const failing = (...args) => {
    try {
      f(...args);
    } catch (e) {
      return { status: e.status, out: e.stdout ? JSON.parse(e.stdout) : null, stderr: String(e.stderr) };
    }
    assert.fail(`forge ${args.join(' ')} should have failed`);
  };
  const answers = path.join(repo.dir, '..', `answers-int-${path.basename(repo.dir)}.json`);
  const answer = (obj) => {
    fs.writeFileSync(answers, JSON.stringify(obj));
    return answers;
  };
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(wtPath, rel)), { recursive: true });
    fs.writeFileSync(path.join(wtPath, rel), text);
  };
  let wtPath = '';
  try {
    fs.mkdirSync(path.join(repo.dir, 'test'));
    fs.writeFileSync(path.join(repo.dir, 'test', 'a.test.mjs'), "test('one', () => {});\ntest('two', () => {});\n");
    fs.writeFileSync(path.join(repo.dir, 'test', 'b.test.mjs'), "test('three', () => {});\n");
    fs.writeFileSync(path.join(repo.dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node --test' } }, null, 2));
    commitAll(repo.dir, 'tests');
    f('init', 'write', '--answers', answer({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));

    // AC8: the default, and only warn | block are accepted.
    const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
    const cfgText = fs.readFileSync(cfgFile, 'utf8');
    assert.match(cfgText, /^verifyIntegrity: warn$/m);
    fs.writeFileSync(cfgFile, cfgText.replace(/^verifyIntegrity: warn\n/m, ''));
    assert.equal(f('config', 'get', 'verifyIntegrity'), 'warn', 'a config that does not set it reads as warn');
    assert.match(failing('init', 'write', '--answers', answer({ verifyIntegrity: 'strict' })).stderr, /verifyIntegrity must be one of warn \| block/);
    fs.writeFileSync(cfgFile, cfgText.replace(/^verifyIntegrity: warn$/m, 'verifyIntegrity: strict'));
    assert.equal(failing('config', 'validate').out.ok, false);
    fs.writeFileSync(cfgFile, cfgText);

    const { id } = f('job', 'new', '--title', 'Integrity');
    wtPath = f('worktree', 'create', id).path;
    f('job', 'round', id);
    const roundMd = () => fs.readFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'verify', 'round-1.md'), 'utf8');

    // AC1: a new test file is no finding, in either mode.
    write('test/c.test.mjs', "test('four', () => {});\n");
    commitAll(wtPath, 'add c');
    let v = f('verify', id);
    assert.equal(v.ok, true);
    assert.equal(v.integrity.findings, 0);
    assert.equal(v.integrity.ok, true);
    assert.equal(v.integrity.base, 'main');
    assert.ok(v.integrity.testCount.delta > 0);
    assert.ok(!v.steps.some((s) => s.name === 'integrity'));
    assert.match(roundMd(), /^VERIFY: PASS\n/);
    assert.match(roundMd(), /^## integrity: ok$/m);
    assert.match(roundMd(), /test declarations 0 → 1 \(\+1\)/);
    f('init', 'write', '--answers', answer({ verifyIntegrity: 'block' }));
    assert.equal(f('verify', id).ok, true, 'AC1 under block');
    f('init', 'write', '--answers', answer({ verifyIntegrity: 'warn' }));

    // AC2: deleting a test and adding a skip only warns by default.
    fs.rmSync(path.join(wtPath, 'test', 'a.test.mjs'));
    write('test/b.test.mjs', "test.skip('three', () => {});\n");
    write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'true' } }, null, 2));
    write('.github/workflows/ci.yml', 'on: push\n');
    commitAll(wtPath, 'weaken');
    v = f('verify', id);
    assert.equal(v.ok, true);
    assert.equal(v.integrity.mode, 'warn');
    assert.deepEqual(v.integrity.deletedTests, ['test/a.test.mjs']);
    assert.deepEqual(v.integrity.skipMarkers, ['test/b.test.mjs:1']);
    assert.deepEqual(v.integrity.testCount, { before: 3, after: 2, delta: -1 });
    assert.equal(v.integrity.blocking, 2);
    let md = roundMd();
    assert.match(md, /^VERIFY: PASS\n/);
    assert.match(md, /^## integrity: WARN \(\d+ findings\)$/m);
    assert.match(md, /^- `test\/a\.test\.mjs`$/m);
    assert.match(md, /^test\/b\.test\.mjs:1: test\.skip\('three', \(\) => \{\}\);$/m);

    // AC3 + AC5: block fails on the deletion and the skip; the config edits are listed but never block.
    f('init', 'write', '--answers', answer({ verifyIntegrity: 'block' }));
    // The worktree's own .forge/config.yml is reported, never obeyed.
    write('.forge/config.yml', 'verifyIntegrity: warn\n');
    commitAll(wtPath, 'try to switch the mode off');
    const failed = failing('verify', id);
    assert.equal(failed.status, 1);
    v = failed.out;
    assert.equal(v.ok, false);
    assert.equal(v.failure.name, 'integrity');
    assert.equal(v.failure.exit, null);
    assert.match(v.failure.tail, /^deleted test\/a\.test\.mjs$/m);
    assert.match(v.failure.tail, /^skip marker test\/b\.test\.mjs:1$/m);
    assert.ok(v.integrity.blocking >= 2);
    assert.equal(v.integrity.mode, 'block', 'the mode comes from the main checkout');
    assert.deepEqual(v.integrity.configEdits.sort(), ['.forge/config.yml', '.github/workflows/ci.yml', 'package.json']);
    md = roundMd();
    assert.match(md, /^VERIFY: FAIL\n/);
    assert.match(md, /^## integrity: FAILED \(2 blocking\)$/m);
    assert.match(md, /^- `package\.json`: scripts changed: test$/m);
    assert.match(md, /^- `\.github\/workflows\/ci\.yml`: added$/m);
    assert.ok(!/^## integrity: FAILED[\s\S]*^## integrity/m.test(md), 'the integrity result is rendered once');
    assert.equal(f('job', 'get', id, 'verify.1'), 'FAIL');
    assert.equal(f('job', 'get', id, 'verifyRetries.1'), 1);

    // AC4: a deletion the spec's Approach names passes under block.
    write('test/b.test.mjs', "test('three', () => {});\n");
    commitAll(wtPath, 'drop the skip');
    fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'spec.md'), '# Spec\n\n## Approach\n- Delete `test/a.test.mjs`; it is superseded.\n\n## Tasks\n- [ ] `test/b.test.mjs`\n');
    v = f('verify', id);
    assert.equal(v.ok, true);
    assert.deepEqual(v.integrity.deletedTests, ['test/a.test.mjs (in spec)']);
    assert.equal(v.integrity.blocking, 0);
    assert.deepEqual(v.integrity.skipMarkers, []);
    assert.deepEqual(v.integrity.configEdits.sort(), ['.forge/config.yml', '.github/workflows/ci.yml', 'package.json'], 'config edits never block');
    md = roundMd();
    assert.match(md, /^VERIFY: PASS\n/);
    assert.match(md, /^## integrity: WARN \(\d+ findings\)$/m);
    assert.match(md, /^- `test\/a\.test\.mjs` \(named in spec\)$/m);
    assert.equal(f('job', 'get', id, 'verify.1'), 'PASS');

    // Files the runner sees must be the files the report saw: index flags that hide a change fail the gate.
    execFileSync('git', ['update-index', '--assume-unchanged', 'test/b.test.mjs'], { cwd: wtPath });
    write('test/b.test.mjs', "test.skip('three', () => {});\n");
    const hidden = failing('verify', id).out;
    assert.equal(hidden.failure.name, 'worktree-clean');
    assert.match(hidden.failure.tail, /^assume-unchanged: test\/b\.test\.mjs$/m);
    assert.equal(hidden.integrity, null);
    execFileSync('git', ['update-index', '--no-assume-unchanged', 'test/b.test.mjs'], { cwd: wtPath });
    execFileSync('git', ['checkout', '--', 'test/b.test.mjs'], { cwd: wtPath });

    // AC7 through verify: an unresolvable base fails block with the error as the tail, and passes warn.
    f('job', 'set', id, '--field', 'base=no-such-branch');
    const errored = failing('verify', id).out;
    assert.equal(errored.failure.name, 'integrity');
    assert.match(errored.failure.tail, /base no-such-branch not found/);
    assert.deepEqual(Object.keys(errored.integrity).sort(), ['error', 'mode', 'ok']);
    assert.match(roundMd(), /^## integrity: error$/m);
    f('init', 'write', '--answers', answer({ verifyIntegrity: 'warn' }));
    v = f('verify', id);
    assert.equal(v.ok, true);
    assert.match(v.integrity.error, /no-such-branch/);
  } finally {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    fs.rmSync(answers, { force: true });
  }
});

test('integrate --keep-conflicts leaves the merge or rebase for the integrator to finish', () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir, GIT_EDITOR: 'true' };
  const f = (...args) => {
    try {
      return { status: 0, out: JSON.parse(execFileSync(process.execPath, [BIN, ...args], { cwd: repo.dir, encoding: 'utf8', env, stdio: 'pipe' })) };
    } catch (e) {
      return { status: e.status, out: e.stdout ? JSON.parse(e.stdout) : null };
    }
  };
  const wtRoot = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
  const answers = path.join(repo.dir, '..', `answers-keep-${path.basename(repo.dir)}.json`);
  try {
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
    assert.equal(f('init', 'write', '--answers', answers).out.ok, true);
    commitAll(repo.dir, 'forge');
    f('tracker', 'create', '--title', 'Conflict');
    const id = f('next', '--claim', '--session', 's1').out.id;
    const wt = f('worktree', 'create', id).out.path;
    const git = (...args) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', env, stdio: 'pipe' }).trim();
    const inProgress = (ref) => fs.existsSync(path.resolve(wt, git('rev-parse', '--git-path', ref)));
    fs.writeFileSync(path.join(wt, 'README.md'), '# ours\n');
    commitAll(wt, 'ours');
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# theirs\n');
    commitAll(repo.dir, 'theirs');

    let r = f('integrate', id, '--strategy', 'merge');
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.conflicts, ['README.md']);
    assert.equal(r.out.inProgress, false);
    assert.equal(inProgress('MERGE_HEAD'), false, 'without the flag the merge is aborted');

    r = f('integrate', id, '--strategy', 'merge', '--keep-conflicts');
    assert.equal(r.status, 1);
    assert.deepEqual(r.out.conflicts, ['README.md']);
    assert.equal(r.out.inProgress, true);
    assert.equal(inProgress('MERGE_HEAD'), true, 'the integrator resolves and runs `git merge --continue`');
    git('merge', '--abort');

    r = f('integrate', id, '--strategy', 'rebase', '--keep-conflicts');
    assert.equal(r.out.inProgress, true);
    assert.equal(inProgress('rebase-merge'), true, 'the integrator never has to start `git rebase` itself');
    assert.equal(f('integrate', id, '--continue').out.conflicts[0], 'README.md', '--continue reports unstaged conflicts');
    fs.writeFileSync(path.join(wt, 'README.md'), '# both\n');
    git('add', 'README.md');
    // A todo line integrate never writes (an exec would run shell) stops --continue.
    const todo = path.resolve(wt, git('rev-parse', '--git-path', 'rebase-merge/git-rebase-todo'));
    const original = fs.readFileSync(todo, 'utf8');
    fs.writeFileSync(todo, original + 'exec touch pwned\n');
    r = f('integrate', id, '--continue');
    assert.notEqual(r.status, 0);
    assert.equal(inProgress('rebase-merge'), true);
    fs.writeFileSync(todo, original);
    r = f('integrate', id, '--continue');
    assert.equal(r.status, 0);
    assert.deepEqual(r.out, { ok: true, strategy: 'rebase', rewritten: true });
    assert.equal(inProgress('rebase-merge'), false);
    assert.equal(fs.existsSync(path.join(wt, 'pwned')), false);
    assert.equal(f('integrate', id).out.behind, 0);

    // Merge: --continue commits the staged resolution.
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# theirs again\n');
    commitAll(repo.dir, 'theirs 2');
    assert.equal(f('integrate', id, '--strategy', 'merge', '--keep-conflicts').out.inProgress, true);
    fs.writeFileSync(path.join(wt, 'README.md'), '# both again\n');
    git('add', 'README.md');
    r = f('integrate', id, '--continue');
    assert.deepEqual(r.out, { ok: true, strategy: 'merge', rewritten: false });
    assert.equal(inProgress('MERGE_HEAD'), false);
    assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a merge commit');
    assert.equal(f('integrate', id, '--continue').status, 1, 'nothing in progress');
  } finally {
    fs.rmSync(answers, { force: true });
    fs.rmSync(wtRoot, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('forge git: read-only history without --output or configured programs', () => {
  const repo = tempRepo();
  const env = { ...process.env, FORGE_ROOT: repo.dir };
  const f = (...args) => spawnSync(process.execPath, [BIN, 'git', ...args], { cwd: repo.dir, encoding: 'utf8', env });
  try {
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# changed\n');
    commitAll(repo.dir, 'second');
    let r = f('log', '--oneline', '-n', '1');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /second/);
    r = f('diff', '--stat', 'HEAD~1...HEAD', '--', 'README.md');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /README\.md/);
    assert.equal(f('show', '--stat', 'HEAD').status, 0);
    assert.equal(f('range-diff', 'HEAD~1', 'HEAD~1', 'HEAD').status, 0);
    for (const bad of [['log', '--format=format:x', '--output=.git/config'], ['diff', '--output', 'x'], ['show', '--ext-diff'], ['log', '-p', '--textconv'], ['diff', '--open-files-in-pager=sh']]) {
      r = f(...bad);
      assert.notEqual(r.status, 0, bad.join(' '));
      assert.match(r.stderr, /refuses/, bad.join(' '));
    }
    assert.doesNotMatch(fs.readFileSync(path.join(repo.dir, '.git', 'config'), 'utf8'), /^x$/m, '.git/config is untouched');
    assert.match(f('status').stderr, /runs only diff, log, show, range-diff/);
    // A textconv driver planted in config never runs through the wrapper.
    repo.git('config', 'diff.evil.textconv', `sh -c 'touch ${path.join(repo.dir, 'pwned')}; cat'`);
    fs.writeFileSync(path.join(repo.dir, '.gitattributes'), '*.md diff=evil\n');
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# third\n');
    assert.equal(f('diff').status, 0);
    assert.equal(f('log', '-p', '-n', '1').status, 0);
    assert.equal(fs.existsSync(path.join(repo.dir, 'pwned')), false);
    execFileSync('git', ['--no-pager', 'diff'], { cwd: repo.dir, stdio: 'pipe' });
    assert.equal(fs.existsSync(path.join(repo.dir, 'pwned')), true, 'control: plain git diff runs the driver');
    // Paths after -- stay paths, even when they look like refused options.
    assert.equal(f('log', '--oneline', '--', '--output=x').status, 0);
  } finally {
    repo.cleanup();
  }
});
