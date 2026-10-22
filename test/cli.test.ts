import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { forgeAsync, scratchGitConfig, tempRepo } from './helpers.ts';
import { createWorktree, removeWorktree, verifiedHead } from '../lib/engine/workspace/worktree.ts';
import { TRUST_ENV, loadConfig, trustDigest } from '../lib/core/config/load.ts';
import { setJob } from '../lib/core/job/store.ts';
import { jobCmd } from '../lib/cli/commands/job.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const commitAll = (cwd, msg) => {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['-c', 'user.email=t@e.st', '-c', 'user.name=T', 'commit', '-qm', msg], { cwd });
};

/**
 * The CLI as execFileSync ran it, without blocking: resolves with its stdout, or rejects on a
 * non-zero exit with an error carrying `status`, `stdout` and `stderr`.
 */
async function cliOut(root: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<string> {
  const r = await forgeAsync(root, args, env);
  if (r.status === 0) return r.stdout;
  throw Object.assign(new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}`), r);
}

// Every test builds its own scratch repos, so they run side by side.
describe('the CLI end to end', { concurrency: 4 }, () => {
  test('end-to-end: init, intake, worktree, verify, eval isolation', async () => {
    const repo = tempRepo();
    const f = async (...args) => {
      const out = await cliOut(repo.dir, args);
      try {
        return JSON.parse(out);
      } catch {
        return out.trim();
      }
    };
    try {
      const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
      fs.writeFileSync(answers, JSON.stringify({ commands: { build: 'echo build', test: 'test -f feature.txt', lint: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
      assert.equal((await f('init', 'write', '--answers', answers)).ok, true);
      assert.equal((await f('config', 'validate')).ok, true);
      assert.ok(fs.existsSync(path.join(repo.dir, '.forge', '.gitignore')));

      await f('tracker', 'create', '--title', 'Ship feature');
      const job = await f('next', '--claim', '--session', 's1');
      assert.equal(job.id, 'ship-feature');
      const wt = await f('worktree', 'create', job.id);
      assert.equal(wt.ok, true);
      assert.equal(wt.port, 4100);
      assert.ok(fs.statSync(path.join(wt.path, '.git')).isFile(), 'non-eval jobs still get a git worktree');

      await f('job', 'round', job.id);
      const failingVerify = async () => {
        try {
          await f('verify', job.id);
          assert.fail('verify should have failed');
        } catch (e) {
          return JSON.parse(e.stdout);
        }
      };
      let verify = await failingVerify();
      assert.equal(verify.ok, false, 'test command fails before the feature exists');
      assert.equal(verify.attempt, 1);
      fs.writeFileSync(path.join(wt.path, 'feature.txt'), 'x');
      verify = await failingVerify();
      assert.equal(verify.failure.name, 'worktree-clean', 'uncommitted changes fail the gate before any command runs');
      assert.match(verify.failure.tail, /feature\.txt/);
      commitAll(wt.path, 'feature');
      const passed = await f('verify', job.id);
      assert.equal(passed.ok, true);
      assert.equal(passed.attempt, 3);
      assert.equal(await f('job', 'get', job.id, 'verify.1'), 'PASS');
      const attempts = await f('job', 'get', job.id, 'verifyRuns');
      assert.equal(attempts.length, 3, 'every attempt is kept');
      assert.equal(attempts[2].sha.length, 40);
      const verifyDir = path.join(repo.dir, '.forge', 'jobs', job.id, 'verify');
      assert.ok(fs.existsSync(path.join(verifyDir, 'round-1-attempt-1.md')) && fs.existsSync(path.join(verifyDir, 'round-1-attempt-2.md')), 'earlier attempts are archived');
      assert.match(fs.readFileSync(path.join(verifyDir, 'round-1.md'), 'utf8'), /^VERIFY: PASS/);
      assert.equal((await f('stats', '--json')).quality.verifyFirstPassRate, 0, 'retries within a round do not count as a first pass');
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
      const run = await f('eval', 'start', '--label', 'test');
      const evalJob = run.tasks[0].job;
      const ewt = await f('job', 'get', evalJob, 'worktree');
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
      const graded = await f('eval', 'grade', evalJob);
      assert.equal(graded.check.pass, true);
      assert.equal('replaced' in graded.check, false, 'a check.files-only task replaces nothing');
      fs.writeFileSync(path.join(ewt, 'scratch.txt'), 'x');
      assert.throws(() => execFileSync(process.execPath, [BIN, 'worktree', 'remove', evalJob], { cwd: repo.dir, stdio: 'pipe', env: { ...process.env, FORGE_ROOT: repo.dir } }));
      assert.ok(fs.existsSync(ewt), 'a dirty eval checkout is kept without --force');
      await f('worktree', 'remove', evalJob, '--force');
      assert.equal(fs.existsSync(ewt), false);
      assert.ok(!await f('job', 'get', evalJob, 'worktree'), 'job.worktree is cleared');

      // job.worktree is writable state: a bad value must never turn removal into rm -rf of the main checkout.
      setJob(repo.dir, evalJob, { owned: { worktree: repo.dir } });
      await assert.rejects(() => removeWorktree(repo.dir, evalJob, { force: true }), /refusing to delete/);
      assert.ok(fs.existsSync(path.join(repo.dir, '.git')) && fs.existsSync(path.join(repo.dir, 'README.md')), 'main checkout survives');
      setJob(repo.dir, evalJob, { owned: { worktree: null } });

      const { config } = loadConfig(repo.dir);
      const { id: iso } = await f('job', 'new', '--title', 'Isolated paths');
      const isoDir = path.join(`${repo.dir}.wt`, iso);
      assert.throws(() => createWorktree(repo.dir, config, iso, { isolate: true, from: 'no-such-ref' }), /no-such-ref/);
      assert.equal(fs.existsSync(isoDir), false, 'an unresolvable base leaves no directory behind');
      fs.mkdirSync(isoDir);
      fs.writeFileSync(path.join(isoDir, 'keep.txt'), 'mine');
      assert.throws(() => createWorktree(repo.dir, config, iso, { isolate: true }), /already exists/);
      assert.equal(fs.readFileSync(path.join(isoDir, 'keep.txt'), 'utf8'), 'mine', 'a pre-existing directory is left untouched');
      fs.rmSync(isoDir, { recursive: true });
      assert.equal(createWorktree(repo.dir, config, iso, { isolate: true }).ok, true);
      await assert.rejects(() => removeWorktree(repo.dir, iso), /refusing to delete/, 'only eval jobs get directory deletion');
      setJob(repo.dir, iso, { owned: { eval: { run: 'r', task: 't' } } });
      await removeWorktree(repo.dir, iso);
      assert.equal(fs.existsSync(isoDir), false, 'a clean eval clone is removed without --force');
      const runs = await f('eval', 'runs');
      assert.equal(runs[0].status, 'done');
      assert.equal(runs[0].summary.checkPassRate, 1);
    } finally {
      repo.cleanup();
      fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    }
  });

  test('verify integrity: warn and block', async () => {
    const repo = tempRepo();
    const f = async (...args) => {
      const out = await cliOut(repo.dir, args);
      try {
        return JSON.parse(out);
      } catch {
        return out.trim();
      }
    };
    const failing = async (...args) => {
      try {
        await f(...args);
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
      // The branch commits .forge/config.yml to show integrity reports it; the protected-paths policy
      // would refuse that first, so it is off here.
      await f('init', 'write', '--answers', answer({ commands: { test: 'true' }, verify: ['test'], worktrees: { root: `../${path.basename(repo.dir)}.wt` }, policy: { protectedPaths: [] } }));

      // AC8: the default, and only warn | block are accepted.
      const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
      const cfgText = fs.readFileSync(cfgFile, 'utf8');
      assert.match(cfgText, /^verifyIntegrity: warn$/m);
      fs.writeFileSync(cfgFile, cfgText.replace(/^verifyIntegrity: warn\n/m, ''));
      assert.equal(await f('config', 'get', 'verifyIntegrity'), 'warn', 'a config that does not set it reads as warn');
      assert.match((await failing('init', 'write', '--answers', answer({ verifyIntegrity: 'strict' }))).stderr, /verifyIntegrity must be one of warn \| block/);
      fs.writeFileSync(cfgFile, cfgText.replace(/^verifyIntegrity: warn$/m, 'verifyIntegrity: strict'));
      assert.equal((await failing('config', 'validate')).out.ok, false);
      fs.writeFileSync(cfgFile, cfgText);

      const { id } = await f('job', 'new', '--title', 'Integrity');
      wtPath = (await f('worktree', 'create', id)).path;
      await f('job', 'round', id);
      const roundMd = () => fs.readFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'verify', 'round-1.md'), 'utf8');

      // AC1: a new test file is no finding, in either mode.
      write('test/c.test.mjs', "test('four', () => {});\n");
      commitAll(wtPath, 'add c');
      let v = await f('verify', id);
      assert.equal(v.ok, true);
      assert.equal(v.integrity.findings, 0);
      assert.equal(v.integrity.ok, true);
      assert.equal(v.integrity.base, 'main');
      assert.ok(v.integrity.testCount.delta > 0);
      assert.ok(!v.steps.some((s) => s.name === 'integrity'));
      assert.match(roundMd(), /^VERIFY: PASS\n/);
      assert.match(roundMd(), /^## integrity: ok$/m);
      assert.match(roundMd(), /test declarations 0 → 1 \(\+1\)/);
      await f('init', 'write', '--answers', answer({ verifyIntegrity: 'block' }));
      assert.equal((await f('verify', id)).ok, true, 'AC1 under block');
      await f('init', 'write', '--answers', answer({ verifyIntegrity: 'warn' }));

      // AC2: deleting a test and adding a skip only warns by default.
      fs.rmSync(path.join(wtPath, 'test', 'a.test.mjs'));
      write('test/b.test.mjs', "test.skip('three', () => {});\n");
      write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'true' } }, null, 2));
      write('.github/workflows/ci.yml', 'on: push\n');
      commitAll(wtPath, 'weaken');
      v = await f('verify', id);
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
      await f('init', 'write', '--answers', answer({ verifyIntegrity: 'block' }));
      // The worktree's own .forge/config.yml is reported, never obeyed.
      write('.forge/config.yml', 'verifyIntegrity: warn\n');
      commitAll(wtPath, 'try to switch the mode off');
      const failed = await failing('verify', id);
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
      assert.equal(await f('job', 'get', id, 'verify.1'), 'FAIL');
      assert.equal(await f('job', 'get', id, 'verifyRetries.1'), 1);

      // AC4: a deletion the spec's Approach names passes under block.
      write('test/b.test.mjs', "test('three', () => {});\n");
      commitAll(wtPath, 'drop the skip');
      fs.writeFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'spec.md'), '# Spec\n\n## Approach\n- Delete `test/a.test.mjs`; it is superseded.\n\n## Tasks\n- [ ] `test/b.test.mjs`\n');
      v = await f('verify', id);
      assert.equal(v.ok, true);
      assert.deepEqual(v.integrity.deletedTests, ['test/a.test.mjs (in spec)']);
      assert.equal(v.integrity.blocking, 0);
      assert.deepEqual(v.integrity.skipMarkers, []);
      assert.deepEqual(v.integrity.configEdits.sort(), ['.forge/config.yml', '.github/workflows/ci.yml', 'package.json'], 'config edits never block');
      md = roundMd();
      assert.match(md, /^VERIFY: PASS\n/);
      assert.match(md, /^## integrity: WARN \(\d+ findings\)$/m);
      assert.match(md, /^- `test\/a\.test\.mjs` \(named in spec\)$/m);
      assert.equal(await f('job', 'get', id, 'verify.1'), 'PASS');

      // Files the runner sees must be the files the report saw: index flags that hide a change fail the gate.
      execFileSync('git', ['update-index', '--assume-unchanged', 'test/b.test.mjs'], { cwd: wtPath });
      write('test/b.test.mjs', "test.skip('three', () => {});\n");
      const hidden = (await failing('verify', id)).out;
      assert.equal(hidden.failure.name, 'worktree-clean');
      assert.match(hidden.failure.tail, /^assume-unchanged: test\/b\.test\.mjs$/m);
      assert.equal(hidden.integrity, null);
      execFileSync('git', ['update-index', '--no-assume-unchanged', 'test/b.test.mjs'], { cwd: wtPath });
      execFileSync('git', ['checkout', '--', 'test/b.test.mjs'], { cwd: wtPath });

      // AC7 through verify: an unresolvable base fails block with the error as the tail, and passes warn.
      // The secret scan reads the same base and would fail first under its own `block`, so it warns here.
      await f('init', 'write', '--answers', answer({ verifySecrets: 'warn' }));
      setJob(repo.dir, id, { owned: { base: 'no-such-branch' } });
      const errored = (await failing('verify', id)).out;
      assert.equal(errored.failure.name, 'integrity');
      assert.match(errored.failure.tail, /base no-such-branch not found/);
      assert.deepEqual(Object.keys(errored.integrity).sort(), ['error', 'mode', 'ok']);
      assert.match(roundMd(), /^## integrity: error$/m);
      await f('init', 'write', '--answers', answer({ verifyIntegrity: 'warn' }));
      v = await f('verify', id);
      assert.equal(v.ok, true);
      assert.match(v.integrity.error, /no-such-branch/);
    } finally {
      repo.cleanup();
      fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
      fs.rmSync(answers, { force: true });
    }
  });

  test('in a daemon session, forge refuses to run once .forge/config.yml or .forge/trackers/ changed', async () => {
    const repo = tempRepo();
    const other = tempRepo();
    /** @param {NodeJS.ProcessEnv} env @param {string[]} args */
    const cli = async (env, ...args) => {
      try {
        const out = await cliOut(repo.dir, args, env);
        return { ok: true, out: out.trim() };
      } catch (e) {
        return { ok: false, out: `${e.stdout}${e.stderr}` };
      }
    };
    const human = async (...args) => JSON.parse((await cli({}, ...args)).out);
    try {
      const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
      fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'touch ran.txt' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
      await human('init', 'write', '--answers', answers);
      fs.rmSync(answers);
      await human('tracker', 'create', '--title', 'Trust');
      const job = await human('next', '--claim', '--session', 's1');
      const wt = await human('worktree', 'create', job.id);
      const cfgFile = path.join(repo.dir, '.forge', 'config.yml');
      const original = fs.readFileSync(cfgFile, 'utf8');
      const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(repo.dir) };

      assert.equal((await cli(daemon, 'run', job.id, 'test')).ok, true, 'an unchanged config runs');
      assert.ok(fs.existsSync(path.join(wt.path, 'ran.txt')));
      fs.rmSync(path.join(wt.path, 'ran.txt'));

      fs.writeFileSync(cfgFile, original.replace('touch ran.txt', 'touch evil.txt'));
      for (const args of [['run', job.id, 'test'], ['verify', job.id], ['status']]) {
        const r = await cli(daemon, ...args);
        assert.equal(r.ok, false, `forge ${args[0]} is refused`);
        assert.match(r.out, /changed since a human started the daemon/);
      }
      assert.equal(fs.existsSync(path.join(wt.path, 'evil.txt')), false, 'the changed command never ran');
      assert.equal((await cli({}, 'run', job.id, 'test')).ok, true, 'outside the daemon the human decides');
      assert.ok(fs.existsSync(path.join(wt.path, 'evil.txt')));

      fs.writeFileSync(cfgFile, original);
      assert.equal((await cli(daemon, 'status')).ok, true, 'restoring the file restores trust');
      fs.mkdirSync(path.join(repo.dir, '.forge', 'trackers'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, '.forge', 'trackers', 'local.mjs'), 'export default {};\n');
      assert.match((await cli(daemon, 'status')).out, /changed since a human started the daemon/, 'tracker modules are pinned too');
      fs.rmSync(path.join(repo.dir, '.forge', 'trackers'), { recursive: true });
      // A symlinked directory's target can change without changing the digest, so any symlink is refused.
      fs.mkdirSync(path.join(repo.dir, '.forge', 'trackers'), { recursive: true });
      fs.symlinkSync(other.dir, path.join(repo.dir, '.forge', 'trackers', 'lib'));
      const linked = { ...daemon, [TRUST_ENV]: trustDigest(repo.dir) };
      assert.match((await cli(linked, 'status')).out, /contains symlinks \(lib\)/);
      fs.rmSync(path.join(repo.dir, '.forge', 'trackers'), { recursive: true });

      assert.match((await cli({ FORGE_DAEMON: '1' }, 'status')).out, /FORGE_DAEMON_TRUST is missing/, 'fails closed without a snapshot');
      assert.match((await cli({ ...daemon, [TRUST_ENV]: 'x' }, 'status')).out, /FORGE_DAEMON_TRUST is missing/);
      // Same config bytes in another checkout: the digest pins the checkout too.
      fs.mkdirSync(path.join(other.dir, '.forge'), { recursive: true });
      fs.writeFileSync(path.join(other.dir, '.forge', 'config.yml'), original);
      assert.match((await cli({ ...daemon, FORGE_ROOT: other.dir }, 'status')).out, /changed since a human started the daemon/);

      for (const args of [['init', 'write', '--answers', '/dev/null'], ['migrate']]) {
        const r = await cli(daemon, ...args);
        assert.equal(r.ok, false);
        assert.match(r.out, /a daemon session may not do/);
      }
      assert.equal(fs.readFileSync(cfgFile, 'utf8'), original);
    } finally {
      repo.cleanup();
      other.cleanup();
      fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    }
  });

  test('integrate --keep-conflicts leaves the merge or rebase for the integrator to finish', async () => {
    const repo = tempRepo();
    const env = { ...process.env, FORGE_ROOT: repo.dir, GIT_EDITOR: 'true' };
    const f = async (...args) => {
      try {
        return { status: 0, out: JSON.parse(await cliOut(repo.dir, args, { GIT_EDITOR: 'true' })) };
      } catch (e) {
        return { status: e.status, out: e.stdout ? JSON.parse(e.stdout) : null };
      }
    };
    const wtRoot = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
    const answers = path.join(repo.dir, '..', `answers-keep-${path.basename(repo.dir)}.json`);
    try {
      fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
      assert.equal((await f('init', 'write', '--answers', answers)).out.ok, true);
      commitAll(repo.dir, 'forge');
      await f('tracker', 'create', '--title', 'Conflict');
      const id = (await f('next', '--claim', '--session', 's1')).out.id;
      const wt = (await f('worktree', 'create', id)).out.path;
      const git = (...args) => execFileSync('git', args, { cwd: wt, encoding: 'utf8', env, stdio: 'pipe' }).trim();
      const inProgress = (ref) => fs.existsSync(path.resolve(wt, git('rev-parse', '--git-path', ref)));
      fs.writeFileSync(path.join(wt, 'README.md'), '# ours\n');
      commitAll(wt, 'ours');
      fs.writeFileSync(path.join(repo.dir, 'README.md'), '# theirs\n');
      commitAll(repo.dir, 'theirs');

      let r = await f('integrate', id, '--strategy', 'merge');
      assert.equal(r.status, 1);
      assert.deepEqual(r.out.conflicts, ['README.md']);
      assert.equal(r.out.inProgress, false);
      assert.equal(inProgress('MERGE_HEAD'), false, 'without the flag the merge is aborted');

      r = await f('integrate', id, '--strategy', 'merge', '--keep-conflicts');
      assert.equal(r.status, 1);
      assert.deepEqual(r.out.conflicts, ['README.md']);
      assert.equal(r.out.inProgress, true);
      assert.equal(inProgress('MERGE_HEAD'), true, 'the integrator resolves and runs `git merge --continue`');
      git('merge', '--abort');

      r = await f('integrate', id, '--strategy', 'rebase', '--keep-conflicts');
      assert.equal(r.out.inProgress, true);
      assert.equal(inProgress('rebase-merge'), true, 'the integrator never has to start `git rebase` itself');
      assert.equal((await f('integrate', id, '--continue')).out.conflicts[0], 'README.md', '--continue reports unstaged conflicts');
      fs.writeFileSync(path.join(wt, 'README.md'), '# both\n');
      git('add', 'README.md');
      // A todo line integrate never writes (an exec would run shell) stops --continue.
      const todo = path.resolve(wt, git('rev-parse', '--git-path', 'rebase-merge/git-rebase-todo'));
      const original = fs.readFileSync(todo, 'utf8');
      fs.writeFileSync(todo, original + 'exec touch pwned\n');
      r = await f('integrate', id, '--continue');
      assert.notEqual(r.status, 0);
      assert.equal(inProgress('rebase-merge'), true);
      fs.writeFileSync(todo, original);
      r = await f('integrate', id, '--continue');
      assert.equal(r.status, 0);
      assert.deepEqual(r.out, { ok: true, strategy: 'rebase', rewritten: true });
      assert.equal(inProgress('rebase-merge'), false);
      assert.equal(fs.existsSync(path.join(wt, 'pwned')), false);
      assert.equal((await f('integrate', id)).out.behind, 0);

      // Merge: --continue commits the staged resolution.
      fs.writeFileSync(path.join(repo.dir, 'README.md'), '# theirs again\n');
      commitAll(repo.dir, 'theirs 2');
      assert.equal((await f('integrate', id, '--strategy', 'merge', '--keep-conflicts')).out.inProgress, true);
      fs.writeFileSync(path.join(wt, 'README.md'), '# both again\n');
      git('add', 'README.md');
      r = await f('integrate', id, '--continue');
      assert.deepEqual(r.out, { ok: true, strategy: 'merge', rewritten: false });
      assert.equal(inProgress('MERGE_HEAD'), false);
      assert.equal(git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3, 'a merge commit');
      assert.equal((await f('integrate', id, '--continue')).status, 1, 'nothing in progress');
    } finally {
      fs.rmSync(answers, { force: true });
      fs.rmSync(wtRoot, { recursive: true, force: true });
      repo.cleanup();
    }
  });

  /** A job with no PR whose branch and base both moved, integrated with the configured default. */
  async function integrateDefault(answersExtra, probe = async (_run, _id, _wt) => {}) {
    const repo = tempRepo();
    const f = async (...args) => JSON.parse(await cliOut(repo.dir, args, { GIT_EDITOR: 'true' }));
    const wtRoot = path.join(repo.dir, '..', `${path.basename(repo.dir)}.wt`);
    const answers = path.join(repo.dir, '..', `answers-default-${path.basename(repo.dir)}.json`);
    try {
      fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` }, ...answersExtra }));
      assert.equal((await f('init', 'write', '--answers', answers)).ok, true);
      commitAll(repo.dir, 'forge');
      await f('tracker', 'create', '--title', 'Behind');
      const id = (await f('next', '--claim', '--session', 's1')).id;
      const wt = (await f('worktree', 'create', id)).path;
      fs.writeFileSync(path.join(wt, 'ours.txt'), 'ours\n');
      commitAll(wt, 'ours');
      fs.writeFileSync(path.join(repo.dir, 'theirs.txt'), 'theirs\n');
      commitAll(repo.dir, 'theirs');
      await probe(async (...args) => {
        try {
          return { status: 0, out: await cliOut(repo.dir, args, { GIT_EDITOR: 'true' }) };
        } catch (e) {
          return { status: e.status, out: String(e.stdout ?? '') + String(e.stderr ?? '') };
        }
      }, id, wt);
      const out = await f('integrate', id);
      const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: wt, encoding: 'utf8' }).trim().split(' ').length - 1;
      return { out, parents };
    } finally {
      fs.rmSync(answers, { force: true });
      fs.rmSync(wtRoot, { recursive: true, force: true });
      repo.cleanup();
    }
  }

  test('integrate merges by default before a PR exists', async () => {
    const { out, parents } = await integrateDefault({}, async (run, id, wt) => {
      // --strategy names the git subcommand integrate aborts with, so anything else is refused up front.
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' });
      for (const bad of ['stash', '-c', 'foo']) {
        const r = await run('integrate', id, '--strategy', bad);
        assert.equal(r.status, 2, `${bad}: ${r.out}`);
        assert.match(r.out, /--strategy must be merge or rebase/);
      }
      assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }), head, 'nothing was merged');
    });
    assert.deepEqual([out.ok, out.behind, out.strategy, out.rewritten], [true, 1, 'merge', false]);
    assert.equal(parents, 2, 'HEAD is a merge commit');
  });

  test('integrate rebases under pr.updateStrategy: rebase', async () => {
    const { out, parents } = await integrateDefault({ pr: { updateStrategy: 'rebase' } });
    assert.deepEqual([out.ok, out.behind, out.strategy, out.rewritten], [true, 1, 'rebase', true]);
    assert.equal(parents, 1, 'the job commit was replayed onto base');
  });

  test('forge git: read-only history without --output or configured programs', async () => {
    const repo = tempRepo();
    const f = (...args) => forgeAsync(repo.dir, ['git', ...args]);
    try {
      fs.writeFileSync(path.join(repo.dir, 'README.md'), '# changed\n');
      commitAll(repo.dir, 'second');
      let r = await f('log', '--oneline', '-n', '1');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /second/);
      r = await f('diff', '--stat', 'HEAD~1...HEAD', '--', 'README.md');
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /README\.md/);
      assert.equal((await f('show', '--stat', 'HEAD')).status, 0);
      assert.equal((await f('range-diff', 'HEAD~1', 'HEAD~1', 'HEAD')).status, 0);
      for (const bad of [['log', '--format=format:x', '--output=.git/config'], ['diff', '--output', 'x'], ['show', '--ext-diff'], ['log', '-p', '--textconv'], ['diff', '--open-files-in-pager=sh']]) {
        r = await f(...bad);
        assert.notEqual(r.status, 0, bad.join(' '));
        assert.match(r.stderr, /refuses/, bad.join(' '));
      }
      assert.doesNotMatch(fs.readFileSync(path.join(repo.dir, '.git', 'config'), 'utf8'), /^x$/m, '.git/config is untouched');
      assert.match((await f('status')).stderr, /runs only diff, log, show, range-diff/);
      // A textconv driver planted in config never runs through the wrapper.
      repo.git('config', 'diff.evil.textconv', `sh -c 'touch ${path.join(repo.dir, 'pwned')}; cat'`);
      fs.writeFileSync(path.join(repo.dir, '.gitattributes'), '*.md diff=evil\n');
      fs.writeFileSync(path.join(repo.dir, 'README.md'), '# third\n');
      assert.equal((await f('diff')).status, 0);
      assert.equal((await f('log', '-p', '-n', '1')).status, 0);
      assert.equal(fs.existsSync(path.join(repo.dir, 'pwned')), false);
      execFileSync('git', ['--no-pager', 'diff'], { cwd: repo.dir, stdio: 'pipe' });
      assert.equal(fs.existsSync(path.join(repo.dir, 'pwned')), true, 'control: plain git diff runs the driver');
      // Paths after -- stay paths, even when they look like refused options.
      assert.equal((await f('log', '--oneline', '--', '--output=x')).status, 0);
    } finally {
      repo.cleanup();
    }
  });

  /** An initialised scratch repo with one job `j`, and a CLI runner that captures status and stderr. */
  async function guardRepo() {
    const repo = tempRepo();
    const answers = path.join(repo.dir, '..', `answers-${path.basename(repo.dir)}.json`);
    fs.writeFileSync(answers, JSON.stringify({ commands: { test: 'true' }, worktrees: { root: `../${path.basename(repo.dir)}.wt` } }));
    const cli = (...args) => forgeAsync(repo.dir, args);
    assert.equal((await cli('init', 'write', '--answers', answers)).status, 0);
    fs.rmSync(answers);
    const created = await cli('job', 'new', '--title', 'J');
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).id;
    const jobDir = path.join(repo.dir, '.forge', 'jobs', id);
    const snapshot = () => ['job.json', 'events.jsonl'].map((f) => (fs.existsSync(path.join(jobDir, f)) ? fs.readFileSync(path.join(jobDir, f), 'utf8') : null));
    /** Runs a command that must fail with exit `exit` and one `forge:` line matching `pattern`, and write nothing. */
    const refuses = async (args, pattern, exit = 1) => {
      const before = snapshot();
      const r = await cli(...args);
      assert.equal(r.status, exit, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.equal(r.stdout, '', args.join(' '));
      assert.match(r.stderr, /^forge: [^\n]*\n$/, `${args.join(' ')}: one stderr line`);
      assert.match(r.stderr, pattern, args.join(' '));
      assert.deepEqual(snapshot(), before, `${args.join(' ')}: job.json and events.jsonl unchanged`);
      return r;
    };
    const job = () => JSON.parse(fs.readFileSync(path.join(jobDir, 'job.json'), 'utf8'));
    return { repo, cli, id, refuses, job };
  }

  test('job set --field rejects malformed JSON and non-array list fields without writing', async () => {
    const { repo, cli, id, refuses, job } = await guardRepo();
    try {
      const r = await refuses(['job', 'set', id, '--field', 'reviewers=[code,tests]'], /reviewers/, 2);
      assert.ok(r.stderr.includes(`--field 'reviewers=["code","tests"]'`), r.stderr);
      for (const kv of ['reviewers="code"', 'reviewers=code', 'services=5', 'children=null', 'dependsOn={}', 'reviewers=[1]'])
        await refuses(['job', 'set', id, '--field', kv], /must be a JSON array of strings, e.g. --field '\w+=\[/);
      // Another valid field in the same call is not written either.
      await refuses(['job', 'set', id, '--field', 'kind=bug', '--field', 'services=api'], /--field services must be a JSON array/);
      assert.notEqual(job().kind, 'bug');

      let ok = await cli('job', 'set', id, '--field', 'reviewers=[]');
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(job().reviewers, []);
      ok = await cli('job', 'set', id, '--field', 'reviewers=["code"]', '--field', 'round=2', '--field', 'kind=bug');
      assert.equal(ok.status, 0, ok.stderr);
      assert.deepEqual(job().reviewers, ['code']);
      assert.equal(job().round, 2);
      assert.equal(job().kind, 'bug');
    } finally {
      repo.cleanup();
    }
  });

  test('job set refuses identity fields and leaves job.json untouched', async () => {
    const { repo, cli, id, refuses, job } = await guardRepo();
    try {
      const cases = [
        ['branch=main', 'branch', 'forge job new --branch'],
        ['worktree=/tmp/x', 'worktree', 'forge worktree create|remove'],
        ['id=other', 'id', 'forge job new'],
        ['owner={}', 'owner', 'forge job claim|release'],
        ['owner.session=x', 'owner', 'forge job claim|release'],
        ['pr.number=1', 'pr', 'forge pr find|open|sync'],
        ['base=main', 'base', 'forge worktree create or forge sync'],
        ['schemaVersion=1', 'schemaVersion', 'forge migrate'],
        ['createdAt=x', 'createdAt', 'forge job new'],
        ['port=1', 'port', 'forge worktree create|remove'],
        ['runs=[]', 'runs', 'forge job claim|release'],
        ['source=null', 'source', 'forge job link'],
        ['usage={}', 'usage', 'forge job agent'],
        ['eval={}', 'eval', 'forge eval start'],
        ['eval.overlay.verify=["test"]', 'eval', 'forge eval start'],
      ];
      for (const [kv, key, hint] of cases) {
        const r = await refuses(['job', 'set', id, '--field', kv], new RegExp(`^forge: --field ${key} is not settable; use `));
        assert.ok(r.stderr.includes(`use ${hint}\n`), r.stderr);
      }
      // A locked key in the same call stops the valid one too.
      await refuses(['job', 'set', id, '--field', 'kind=bug', '--field', 'branch=main'], /--field branch is not settable/);

      for (const kv of ['__proto__.polluted=1', 'meta.constructor.x=1', 'meta.prototype=1', '__proto__={"polluted":1}'])
        await refuses(['job', 'set', id, '--field', kv], /: __proto__, constructor and prototype are not field names$/m);
      // In-process too, where a write through setPath would reach this test's Object.prototype.
      const { config } = loadConfig(repo.dir);
      for (const field of ['__proto__.polluted=1', 'constructor.prototype.polluted=1'])
        await assert.rejects(jobCmd(repo.dir, config, 'set', [id], { field }), /are not field names/);
      assert.equal(({} as any).polluted, undefined);

      const ok = await cli('job', 'set', id, '--field', 'round=2', '--field', 'reviewers=["code"]', '--field', 'kind=bug', '--field', 'meta.note=x', '--field', 'toString=1');
      assert.equal(ok.status, 0, ok.stderr);
      const j = job();
      assert.equal(j.round, 2);
      assert.deepEqual(j.reviewers, ['code']);
      assert.equal(j.kind, 'bug');
      assert.equal(j.meta.note, 'x');
    } finally {
      repo.cleanup();
    }
  });

  test('commands on an unknown job id fail and leave no job directory', async () => {
    const { repo, cli } = await guardRepo();
    try {
      const ghost = path.join(repo.dir, '.forge', 'jobs', 'nope');
      const cmds = [
        ['job', 'note', 'nope', 'hi'],
        ['job', 'human', 'nope', 'approve'],
        ['job', 'decision', 'nope'],
        ['job', 'progress', 'nope'],
        ['job', 'set', 'nope', '--state', 'running'],
        ['job', 'release', 'nope'],
        ['job', 'claim', 'nope', '--session', 's'],
        ['job', 'agent', 'nope', 'start', '--role', 'builder'],
        ['job', 'agent', 'nope', 'end', '--role', 'builder'],
        ['retro', 'prepare', 'nope'],
      ];
      for (const args of cmds) {
        const r = await cli(...args);
        assert.equal(r.status, 1, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr, /no job "nope"/, args.join(' '));
        assert.equal(fs.existsSync(ghost), false, `${args.join(' ')} left no .forge/jobs/nope`);
      }
    } finally {
      repo.cleanup();
    }
  });

  test('bare string flags and bad numbers fail before anything is written', async () => {
    const { repo, cli, id, refuses, job } = await guardRepo();
    try {
      const requests = path.join(repo.dir, '.forge', 'runtime', 'requests');
      const listRequests = () => (fs.existsSync(requests) ? fs.readdirSync(requests).sort() : []);
      const queued = listRequests();
      await refuses(['requests', 'add', 'resume', '--job'], /missing value for --job \(write --job=<value> if the value starts with --\)/, 2);
      await refuses(['requests', 'add', 'resume', '--job='], /missing value for --job/, 2);
      await refuses(['requests', 'add', 'resume', '--job', id, '--job', id], /--job given more than once/, 2);
      await refuses(['requests', 'add', 'resume', '--job', id, '--session'], /missing value for --session/, 2);
      assert.deepEqual(listRequests(), queued, 'no request file was written');

      await refuses(['job', 'agent', id, 'end', '--role', 'builder', '--summary'], /missing value for --summary/, 2);
      await refuses(['job', 'agent', id, 'end', '--role', 'builder', '--tokens', 'abc'], /--tokens must be a non-negative number \(got "abc"\)/, 2);
      await refuses(['job', 'agent', id, 'end', '--role', 'builder', '--tokens', '-5'], /--tokens must be a non-negative number/, 2);
      await refuses(['job', 'agent', id, 'end', '--role', 'builder', '--tool-uses', 'x'], /--tool-uses must be a non-negative number/, 2);
      await refuses(['job', 'agent', id, 'end', '--role', 'builder', '--duration-ms'], /missing value for --duration-ms/, 2);
      const ok = await cli('job', 'agent', id, 'end', '--role', 'builder', '--tokens', '100', '--tool-uses', '1', '--duration-ms', '1000');
      assert.equal(ok.status, 0, ok.stderr);
      assert.equal(JSON.parse(ok.stdout).usage.tokens, 100);
      assert.equal(job().usage.totalTokens, 100);
      const zero = await cli('job', 'agent', id, 'end', '--role', 'reviewer:code', '--tokens', '0');
      assert.equal(zero.status, 0, zero.stderr);
      assert.equal(JSON.parse(zero.stdout).usage.tokens, 0, '--tokens 0 still records usage');

      await refuses(['job', 'human', id, 'approve', '--note'], /missing value for --note/, 2);
      await refuses(['job', 'set', id, '--note'], /missing value for --note/, 2);
      await refuses(['job', 'claim', id, '--session'], /missing value for --session/, 2);
      await refuses(['job', 'claim', id, '--session='], /missing value for --session/, 2);
      await refuses(['job', 'step', id, '--session'], /missing value for --session/, 2);

      await refuses(['tracker', 'list', '--limit', 'abc'], /--limit must be a non-negative integer \(got "abc"\)/, 2);
      await refuses(['run', id, 'test', '--tail', 'x'], /--tail must be a non-negative integer \(got "x"\)/, 2);
      // The queued, unowned job would be the first thing `next --claim` resumes.
      assert.equal(job().owner ?? null, null);
      await refuses(['next', '--claim', '--session', 's', '--limit', '-1'], /--limit must be a non-negative integer \(got "-1"\)/, 2);
      await refuses(['next', '--claim', '--session', 's', '--limit', '1.5'], /--limit must be a non-negative integer/, 2);
      assert.equal(job().owner ?? null, null, 'next claimed nothing');
    } finally {
      repo.cleanup();
    }
  });

  test('job human accepts only known actions, and stats still counts them', async () => {
    const { repo, cli, id, refuses } = await guardRepo();
    try {
      const r = await refuses(['job', 'human', id, 'bogus'], /unknown action "bogus"/, 2);
      for (const a of ['approve-spec', 'revise-spec', 'approve-split', 'revise-split', 'approve', 'rework', 'answer', 'approve-repos', 'reject-repos', 'approve-release']) assert.ok(r.stderr.includes(a), a);
      await refuses(['job', 'human', id, 'reject'], /unknown action "reject"/, 2);
      await refuses(['job', 'human', id], /missing action \(approve-spec\|revise-spec\|approve-split\|revise-split\|approve\|rework\|answer\|approve-repos\|reject-repos\|approve-release\)/, 2);
      for (const a of ['revise-spec', 'approve-spec', 'rework']) {
        const ok = await cli('job', 'human', id, a, '--note', `n ${a}`);
        assert.equal(ok.status, 0, ok.stderr);
      }
      const events = fs.readFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'human');
      assert.deepEqual(events.map((e) => [e.action, e.note]), [['revise-spec', 'n revise-spec'], ['approve-spec', 'n approve-spec'], ['rework', 'n rework']]);
      const stats = await cli('stats', '--json');
      assert.equal(stats.status, 0, stats.stderr);
      const q = JSON.parse(stats.stdout).quality;
      assert.equal(q.humanReworks, 1);
      assert.notEqual(q.specFirstApprovalRate, null);
    } finally {
      repo.cleanup();
    }
  });
});
