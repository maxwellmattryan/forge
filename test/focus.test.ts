// Focus (issue #177) in-process: lib/focus.ts reads the pointer in .forge/runtime/focus.json without
// following, blocking or writing, and focusJob starts and stops nothing. `forge focus` itself is
// test/integration/cli/focus.test.ts, and the dashboard's focus routes test/integration/server/focus.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgeAsync, forgeSync, repoTemplate } from './helpers.ts';
import { loadConfig } from '#core/config/load.ts';
import { focusFile, readFocusRecord, readSmallJson, resolveFocus } from '#core/job/focus.ts';
import { currentFocus, focusJob } from '#engine/workspace/focus-actions.ts';
import { createJob, setJob } from '#core/job/store.ts';
import { archiveJob } from '#engine/ops/retention.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  // `sleep 30` stands in for a dev server: a live process group on the job's port, nothing more.
  const base = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, ports: { base, span: 10 }, commands: { dev: 'sleep 30' }, worktrees: { root: '../{repo}.wt' } }));
  const r = forgeSync(dir, ['init', 'write', '--answers', answers]);
  if (r.status !== 0) throw new Error(r.stderr);
  fs.rmSync(answers);
});

function scratch() {
  const repo = template();
  const f = async (...args: string[]) => {
    const r = await forgeAsync(repo.dir, args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const job = async (title: string) => (await f('job', 'new', '--title', title, '--ref', title.toLowerCase().replace(/ /g, '-'))).id as string;
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  };
  return { root: repo.dir, f, job, cleanup };
}

test('a planted or stale focus record reads as none, in-process', () => {
  const repo = template();
  try {
    const root = repo.dir;
    const config = loadConfig(root).config;
    const a = createJob(root, config, { title: 'Alpha' }).id;
    const archived = createJob(root, config, { title: 'Archived' }).id;
    setJob(root, archived, { state: 'done' });
    archiveJob(root, archived, 'cli', { config });
    assert.equal(fs.existsSync(path.join(root, '.forge', 'jobs', archived)), false);

    const file = focusFile(root);
    const runtime = path.dirname(file);
    const locks = path.join(root, '.forge', 'locks');
    fs.mkdirSync(runtime, { recursive: true });
    const good = JSON.stringify({ v: 1, job: a, since: '2026-01-01T00:00:00.000Z' });
    const target = path.join(root, 'elsewhere.json');
    fs.writeFileSync(target, good);
    // Windows has no FIFOs, and planting a symlink there needs a privilege CI runners lack.
    const posixOnly: [string, () => void][] = [
      ['a symlink', () => fs.symlinkSync(target, file)],
      ['a FIFO', () => assert.equal(spawnSync('mkfifo', [file]).status, 0)],
    ];
    // Each plant and the read that refuses it: readSmallJson for what is not a small JSON object,
    // readFocusRecord for a bad id, resolveFocus (through currentFocus's job lookup) for a job that is gone.
    const plants: [string, () => void, 'json' | 'record' | 'resolve'][] = [
      ...(process.platform === 'win32' ? [] : posixOnly.map(([what, plant]) => [what, plant, 'json'] as [string, () => void, 'json'])),
      ['a file over 64 KiB', () => fs.writeFileSync(file, JSON.stringify({ v: 1, job: a, since: 'x', pad: 'x'.repeat(65 * 1024) })), 'json'],
      ['invalid JSON', () => fs.writeFileSync(file, '{"job": '), 'json'],
      ['an invalid id', () => fs.writeFileSync(file, JSON.stringify({ v: 1, job: '../../etc', since: 'x' })), 'record'],
      ['a missing job', () => fs.writeFileSync(file, JSON.stringify({ v: 1, job: 'never-was', since: 'x' })), 'resolve'],
      ['an archived job', () => fs.writeFileSync(file, JSON.stringify({ v: 1, job: archived, since: 'x' })), 'resolve'],
    ];
    for (const [what, plant, refusedBy] of plants) {
      fs.rmSync(file, { force: true });
      plant();
      const stat = () => (fs.existsSync(file) ? fs.lstatSync(file) : null);
      const before = stat();
      const runtimeBefore = fs.readdirSync(runtime).sort();
      const locksBefore = fs.existsSync(locks) ? fs.readdirSync(locks).sort() : [];
      if (refusedBy === 'json') assert.equal(readSmallJson(file), null, what);
      else assert.notEqual(readSmallJson(file), null, what);
      if (refusedBy !== 'resolve') assert.equal(readFocusRecord(root), null, what);
      else assert.notEqual(readFocusRecord(root), null, what);
      assert.equal(currentFocus(root), null, what);
      const after = stat();
      assert.equal(after?.mtimeMs, before?.mtimeMs, `${what}: the read wrote nothing`);
      assert.equal(after?.ino, before?.ino, what);
      assert.deepEqual(fs.readdirSync(runtime).sort(), runtimeBefore, `${what}: nothing written beside it`);
      assert.deepEqual(fs.existsSync(locks) ? fs.readdirSync(locks).sort() : [], locksBefore, `${what}: no lock taken`);
    }
    assert.equal(fs.readFileSync(target, 'utf8'), good, 'the link target is untouched');
    assert.equal(resolveFocus(null, () => assert.fail('no lookup without a record')), null);
  } finally {
    repo.cleanup();
  }
});

// The stub dev server is `sleep 30` through sh, and the liveness check signals a process group: both POSIX.
test('switching focus starts and stops nothing', { timeout: 60_000, skip: process.platform === 'win32' && 'POSIX shell dev server and process groups' }, async () => {
  const s = scratch();
  const pids: number[] = [];
  const alive = (pid: number) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  try {
    const a = await s.job('Alpha');
    const b = await s.job('Beta');
    const ports = [(await s.f('worktree', 'create', a)).port, (await s.f('worktree', 'create', b)).port];
    assert.notEqual(ports[0], ports[1], 'each job has its own port');
    for (const id of [a, b]) pids.push((await s.f('run', id, 'dev', '--background')).pid);
    const runtime = (id: string) => fs.readFileSync(path.join(s.root, '.forge', 'jobs', id, 'runtime.json'));
    const before = [runtime(a), runtime(b)];
    for (const id of [a, b, a]) {
      const r = await s.f('focus', id);
      assert.equal(r.focus.id, id);
      assert.ok(pids.every(alive), `both dev servers live after focusing ${id}`);
    }
    // The work itself, timed in-process: the CLI's own start-up time under a loaded suite says nothing about focus.
    for (const id of [b, a, b]) {
      const t = performance.now();
      await focusJob(s.root, id, 'cli', { login: 'forge-test', source: 'env' });
      assert.ok(performance.now() - t < 1000, `focusing ${id} took under 1 s`);
    }
    assert.ok(pids.every(alive), 'both dev servers still live');
    assert.deepEqual([runtime(a), runtime(b)], before, 'runtime.json files are byte-identical');
  } finally {
    for (const pid of pids) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {}
    }
    s.cleanup();
  }
});
