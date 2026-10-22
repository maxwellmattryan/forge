import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { GIT_PINS, STATUS_ARGV, git, gitEnv, gitInvocation, gitSpawnSync } from '../lib/git.ts';
import { tempRepo } from './helpers.ts';

const PINS = ['-c', 'core.fsmonitor=false', '-c', 'core.quotepath=off', '-c', 'diff.interHunkContext=0', '-c', 'diff.suppressBlankEmpty=false', '-c', 'diff.relative=false'];
const LOCATION = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_NAMESPACE'];

/** Runs fn with `vars` set in process.env, restoring the previous values after. */
function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('every git call carries the pins and a clean env', () => {
  assert.equal(GIT_PINS.length, 5);
  const inherited = Object.fromEntries([...LOCATION.map((k) => [k, `/elsewhere/${k}`]), ['FORGE_TEST_KEPT', 'yes']]);
  const given = { PATH: '/bin', GIT_INDEX_FILE: '/tmp/preview-index', GIT_DIR: '/given/.git' };
  const rows: { name: string; args: string[]; opts?: Parameters<typeof gitInvocation>[1]; check: (env: NodeJS.ProcessEnv) => void }[] = [
    {
      name: 'a read without env',
      args: [...STATUS_ARGV],
      check: (env) => {
        for (const k of LOCATION) assert.equal(env[k], undefined, k);
        assert.equal(env.FORGE_TEST_KEPT, 'yes', 'everything else is inherited');
        assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
      },
    },
    {
      name: 'a write without env',
      args: ['commit', '-q', '-m', 'x', '--', 'a b.txt'],
      opts: { write: true },
      check: (env) => {
        for (const k of LOCATION) assert.equal(env[k], undefined, k);
        assert.equal(env.GIT_OPTIONAL_LOCKS, undefined);
      },
    },
    {
      name: "a read with the caller's env",
      args: ['-c', 'core.hooksPath=/dev/null', 'diff', '--no-ext-diff', '--no-textconv', '--', '-n.txt'],
      opts: { env: given },
      check: (env) => assert.deepEqual(env, { ...given, GIT_OPTIONAL_LOCKS: '0' }),
    },
    {
      name: "a write with the caller's env",
      args: ['read-tree', 'HEAD'],
      opts: { env: given, write: true },
      check: (env) => assert.deepEqual(env, given),
    },
  ];
  withEnv(inherited, () => {
    for (const row of rows) {
      const { argv, env } = gitInvocation(row.args, row.opts);
      assert.deepEqual(argv, [...PINS, ...row.args], row.name);
      row.check(env);
    }
  });
  assert.deepEqual(given, { PATH: '/bin', GIT_INDEX_FILE: '/tmp/preview-index', GIT_DIR: '/given/.git' }, "the caller's env is not changed");
  assert.equal(withEnv(inherited, () => gitEnv()).GIT_DIR, undefined);
});

test("a worktree's fsmonitor and an inherited GIT_DIR never reach a wrapper call", { skip: process.platform === 'win32' }, () => {
  const repo = tempRepo();
  const other = tempRepo();
  try {
    const marker = path.join(repo.dir, '..', `${path.basename(repo.dir)}-fsmonitor-ran`);
    const hook = path.join(repo.dir, '..', `${path.basename(repo.dir)}-fsmonitor-hook`);
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    repo.git('config', 'core.fsmonitor', hook);
    fs.writeFileSync(path.join(repo.dir, 'README.md'), '# changed\n');
    // Unpinned, git status runs it, so the assertions below are meaningful.
    repo.git('status', '--porcelain');
    assert.ok(fs.existsSync(marker), 'plain git status runs the fsmonitor hook');
    fs.rmSync(marker);
    assert.match(git(repo.dir, [...STATUS_ARGV]).stdout, /README\.md/);
    git(repo.dir, ['diff', '--no-ext-diff', '--', 'README.md']);
    git(repo.dir, ['add', '-A'], { write: true });
    assert.ok(!fs.existsSync(marker), 'no wrapper call ran the fsmonitor program');
    fs.rmSync(hook);

    const top = withEnv({ GIT_DIR: path.join(other.dir, '.git'), GIT_WORK_TREE: other.dir }, () => git(repo.dir, ['rev-parse', '--show-toplevel']).stdout.trim());
    assert.equal(top, repo.dir);

    // The spawnSync flavour takes the same pins and clean env, and returns Buffers when asked.
    fs.writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\n`, { mode: 0o755 });
    const viaSpawn = gitSpawnSync(repo.dir, [...STATUS_ARGV], { encoding: 'utf8' });
    assert.match(String(viaSpawn.stdout), /README\.md/);
    assert.ok(!fs.existsSync(marker), 'gitSpawnSync did not run the fsmonitor program');
    const spawnTop = withEnv({ GIT_DIR: path.join(other.dir, '.git'), GIT_WORK_TREE: other.dir }, () => gitSpawnSync(repo.dir, ['rev-parse', '--show-toplevel']));
    assert.ok(Buffer.isBuffer(spawnTop.stdout));
    assert.equal(spawnTop.stdout.toString().trim(), repo.dir);
  } finally {
    repo.cleanup();
    other.cleanup();
  }
});
