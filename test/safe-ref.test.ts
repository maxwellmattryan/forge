import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tempRepo } from './helpers.ts';
import { defaults, worktreeRoot } from '../lib/config.ts';
import { createJob, loadJob, readEvents, setJob } from '../lib/jobs.ts';
import { ForgeError, SAFE_REF, assertSafeRef } from '../lib/util.ts';
import { createWorktree } from '../lib/worktree.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

/** The CLI against `dir`, with stdout and stderr kept apart. */
function cli(dir: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: dir } });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

/** A scratch repo with `forge init write` run on `answers`; worktrees go to a `<repo>.wt` sibling. */
function initRepo(answers: Record<string, unknown>) {
  const repo = tempRepo();
  const file = path.join(fs.realpathSync(os.tmpdir()), `forge-safe-ref-${path.basename(repo.dir)}.json`);
  fs.writeFileSync(file, JSON.stringify({ worktrees: { root: `../${path.basename(repo.dir)}.wt` }, ...answers }));
  const r = cli(repo.dir, 'init', 'write', '--answers', file);
  fs.rmSync(file, { force: true });
  assert.equal(r.status, 0, r.stderr);
  return {
    ...repo,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
    },
  };
}

test('assertSafeRef accepts plain branch names and refuses shell metacharacters', () => {
  for (const ok of ['forge/66-drafting-restyle-4-5-job', 'release/1.2', 'main', 'v1.0_rc-2']) assert.equal(assertSafeRef(ok, 'job.branch'), ok);
  for (const bad of ['a;b', 'a$(b)', 'a|b', 'a`b`', 'a{b}', '-x', 'a b', 'a\nb', '', 'a'.repeat(201), true, null]) {
    assert.throws(
      () => assertSafeRef(bad, 'job.branch'),
      (e: any) => e instanceof ForgeError && e.message.startsWith('job.branch ') && /is not a safe branch name/.test(e.message) && !e.message.includes('\n'),
      JSON.stringify(bad),
    );
  }
  assert.throws(() => assertSafeRef(undefined, 'job.base'), /^Error: job\.base undefined is not a safe branch name/);
  const long = (() => {
    try {
      assertSafeRef(`${'x'.repeat(300)};`, 'f');
    } catch (e) {
      return (e as Error).message;
    }
  })();
  assert.ok(long?.startsWith(`f "${'x'.repeat(79)} is not`), 'the shown value is cut to 80 characters');
  assert.equal(SAFE_REF.test('a'.repeat(200)), true);
});

test('forge run never fills a template with an unsafe branch', { skip: process.platform === 'win32' }, async () => {
  const repo = initRepo({ commands: { test: 'echo {branch} > out.txt' } });
  try {
    assert.equal(cli(repo.dir, 'tracker', 'create', '--title', 'Pwn').status, 0);
    const { id } = JSON.parse(cli(repo.dir, 'next', '--claim', '--session', 's1').stdout);
    const wt = cli(repo.dir, 'worktree', 'create', id);
    assert.equal(wt.status, 0, wt.stderr);
    const dir = loadJob(repo.dir, id).worktree!;
    setJob(repo.dir, id, { fields: { branch: 'a;touch pwned' } });
    const gone = () => {
      for (const d of [dir, repo.dir]) for (const f of ['pwned', 'out.txt']) assert.equal(fs.existsSync(path.join(d, f)), false, path.join(d, f));
    };

    const fg = cli(repo.dir, 'run', id, 'test');
    assert.notEqual(fg.status, 0);
    assert.equal(fg.stderr.split('\n').length, 1, fg.stderr);
    assert.match(fg.stderr, /^forge: job\.branch "a;touch pwned" is not a safe branch name/);
    gone();

    const bg = cli(repo.dir, 'run', id, 'test', '--background');
    assert.notEqual(bg.status, 0);
    assert.equal(bg.stderr.split('\n').length, 1, bg.stderr);
    assert.match(bg.stderr, /job\.branch/);
    // A detached child would need a moment to write anything.
    await new Promise((r) => setTimeout(r, 300));
    gone();
    assert.ok(!readEvents(repo.dir, id).some((e) => e.type === 'background-start'));
  } finally {
    repo.cleanup();
  }
});

test('createWorktree refuses unsafe refs before touching git', () => {
  const repo = tempRepo();
  const config = defaults();
  const wtRoot = worktreeRoot(repo.dir, config);
  try {
    for (const [field, value] of [['base', 'main;id'], ['branch', '-x']] as const) {
      const job = createJob(repo.dir, config, { title: `refuse ${field}` });
      setJob(repo.dir, job.id, { fields: { [field]: value } });
      assert.throws(() => createWorktree(repo.dir, config, job.id), (e: any) => e instanceof ForgeError && e.message.startsWith(`job.${field} `));
      assert.equal(fs.existsSync(wtRoot), false, 'nothing is created under the worktrees root');
      const after = loadJob(repo.dir, job.id);
      assert.equal(after.worktree, null);
      assert.equal(after.port, null);
      assert.ok(!readEvents(repo.dir, job.id).some((e) => e.type === 'worktree'));
    }
  } finally {
    repo.cleanup();
    fs.rmSync(wtRoot, { recursive: true, force: true });
  }
});

test('forge job new refuses an unsafe --branch', () => {
  const repo = initRepo({});
  const jobs = path.join(repo.dir, '.forge', 'jobs');
  const list = () => (fs.existsSync(jobs) ? fs.readdirSync(jobs).sort() : []);
  try {
    const before = list();
    for (const args of [['--branch', 'a;b'], ['--branch']]) {
      const r = cli(repo.dir, 'job', 'new', '--title', 'T', ...args);
      assert.equal(r.status, 1, r.stdout);
      assert.equal(r.stderr.split('\n').length, 1, r.stderr);
      assert.match(r.stderr, /^forge: --branch .* is not a safe branch name/);
      assert.deepEqual(list(), before, 'no job directory is created');
    }
    const ok = cli(repo.dir, 'job', 'new', '--title', 'T', '--branch', 'release/1.2');
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).branch, 'release/1.2');
  } finally {
    repo.cleanup();
  }
});
