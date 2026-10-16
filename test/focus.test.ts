// Focus (issue #177): `forge focus` moves a pointer in the root repo's .forge/runtime/focus.json,
// starts and stops nothing, and lets go when the focused job finishes.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { TRUST_ENV, trustDigest } from '../lib/config.ts';
import { focusJob } from '../lib/focus-actions.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  // `sleep 30` stands in for a dev server: a live process group on the job's port, nothing more.
  const base = 20000 + Math.floor(Math.random() * 20000);
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, ports: { base, span: 10 }, commands: { dev: 'sleep 30' }, worktrees: { root: '../{repo}.wt' } }));
  const r = spawnSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: dir } });
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
  /** The CLI's --json error for a call that must fail. */
  const fail = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = await forgeAsync(repo.dir, ['--json', ...args], env);
    assert.notEqual(r.status, 0, `forge ${args.join(' ')} should fail: ${r.stdout}`);
    return { status: r.status, ...JSON.parse(r.stdout).error };
  };
  const job = async (title: string) => (await f('job', 'new', '--title', title, '--ref', title.toLowerCase().replace(/ /g, '-'))).id as string;
  const focusFile = path.join(repo.dir, '.forge', 'runtime', 'focus.json');
  const events = (id: string) =>
    fs
      .readFileSync(path.join(repo.dir, '.forge', 'jobs', id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const focusEvents = (id: string) => events(id).filter((e) => e.type === 'focus' || e.type === 'unfocus');
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${repo.dir}.wt`, { recursive: true, force: true });
  };
  return { root: repo.dir, f, fail, job, focusFile, events, focusEvents, cleanup };
}

describe('forge focus', { concurrency: 4 }, () => {
  test('focus is recorded in the root repo, also from a worktree', async () => {
    const s = scratch();
    try {
      const a = await s.job('Alpha');
      const b = await s.job('Beta');
      const wt = (await s.f('worktree', 'create', a)).path;
      const set = await s.f('focus', a);
      assert.equal(set.focus.id, a);
      assert.equal(set.focus.title, 'Alpha');
      assert.equal(set.previous, null);
      const rec = JSON.parse(fs.readFileSync(s.focusFile, 'utf8'));
      assert.equal(rec.v, 1);
      assert.equal(rec.job, a);
      assert.ok(!Number.isNaN(Date.parse(rec.since)));
      assert.deepEqual(await s.f('focus'), { focus: { id: a, title: 'Alpha', since: rec.since } });

      // From inside the worktree, with no FORGE_ROOT: mainRoot() finds the same file.
      const { FORGE_ROOT: _r, ...env } = process.env;
      const inWt = (...args: string[]) =>
        new Promise<any>((resolve, reject) =>
          execFile(process.execPath, [BIN, ...args], { cwd: wt, env, encoding: 'utf8' }, (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout)))),
        );
      assert.equal((await inWt('focus')).focus.id, a);
      const moved = await inWt('focus', b);
      assert.equal(moved.focus.id, b);
      assert.equal(moved.previous, a);
      assert.equal(JSON.parse(fs.readFileSync(s.focusFile, 'utf8')).job, b, 'the root repo record moved');
      assert.equal(fs.existsSync(path.join(wt, '.forge', 'runtime', 'focus.json')), false, 'nothing was written in the worktree');
    } finally {
      s.cleanup();
    }
  });

  test('clear and empty read', async () => {
    const s = scratch();
    try {
      assert.deepEqual(await s.f('focus'), { focus: null });
      assert.deepEqual(await s.f('focus', '--clear'), { focus: null, previous: null }, 'clearing nothing succeeds');
      const a = await s.job('Alpha');
      await s.f('focus', a);
      assert.deepEqual(await s.f('focus', '--clear'), { focus: null, previous: a });
      assert.equal(fs.existsSync(s.focusFile), false);
      assert.deepEqual(await s.f('focus'), { focus: null });
    } finally {
      s.cleanup();
    }
  });

  test('focus refusals', async () => {
    const s = scratch();
    try {
      const a = await s.job('Alpha');
      const done = await s.job('Finished');
      const gone = await s.job('Dropped');
      await s.f('job', 'set', done, '--state', 'done');
      await s.f('job', 'set', gone, '--state', 'cancelled');

      const unknown = await s.fail(['focus', 'no-such-job']);
      assert.equal(unknown.code, 'not_found');
      assert.equal(unknown.status, 1);
      for (const [id, state] of [
        [done, 'done'],
        [gone, 'cancelled'],
      ]) {
        const e = await s.fail(['focus', id]);
        assert.equal(e.code, 'usage');
        assert.equal(e.message, `job ${id} is ${state}; only an active job can be focused`);
      }
      for (const bad of ['../x', '-rf', 'a b']) assert.equal((await s.fail(['focus', '--', bad])).code, 'usage', bad);
      assert.equal((await s.fail(['focus', a, '--clear'])).code, 'usage', 'an id and --clear');
      assert.equal((await s.fail(['focus', '--clear', a])).code, 'usage', '--clear before the id');
      assert.equal(fs.existsSync(s.focusFile), false, 'no refusal wrote a record');

      await s.f('focus', a);
      const daemon = { FORGE_DAEMON: '1', [TRUST_ENV]: trustDigest(s.root) };
      const other = await s.job('Other');
      for (const args of [['focus', other], ['focus', '--clear']]) {
        const e = await s.fail(args, daemon);
        assert.match(e.message, /daemon session may not/, args.join(' '));
      }
      const read = await forgeAsync(s.root, ['focus'], daemon);
      assert.equal(read.status, 0, read.stderr);
      assert.equal(JSON.parse(read.stdout).focus.id, a, 'a daemon session may read focus, and it did not move');
    } finally {
      s.cleanup();
    }
  });

  test('finishing or cancelling the focused job clears focus', async () => {
    const s = scratch();
    try {
      for (const state of ['done', 'cancelled']) {
        const id = await s.job(`Ends ${state}`);
        await s.f('focus', id);
        await s.f('job', 'set', id, '--state', state);
        assert.deepEqual(await s.f('focus'), { focus: null }, state);
        assert.equal(fs.existsSync(s.focusFile), false, state);
        const last = s.events(id).at(-1);
        assert.equal(last.type, 'unfocus');
        assert.equal(last.reason, 'finished');
        assert.equal(last.actor, undefined, 'finishing is not a human focus action');
      }
      const kept = await s.job('Kept');
      const other = await s.job('Other');
      await s.f('focus', kept);
      await s.f('job', 'set', other, '--state', 'done');
      assert.equal((await s.f('focus')).focus.id, kept, "another job finishing leaves this job's focus alone");
      assert.equal(s.focusEvents(other).length, 0);
      await s.f('job', 'set', kept, '--state', 'waiting', '--waiting-on', 'human');
      assert.equal((await s.f('focus')).focus.id, kept, 'a non-terminal change keeps focus');
    } finally {
      s.cleanup();
    }
  });

  test('a planted or stale focus record reads as none', { timeout: 30_000 }, async () => {
    const s = scratch();
    try {
      const a = await s.job('Alpha');
      const archived = await s.job('Archived');
      await s.f('job', 'set', archived, '--state', 'done');
      await s.f('job', 'archive', archived);
      assert.equal(fs.existsSync(path.join(s.root, '.forge', 'jobs', archived)), false);
      const runtime = path.dirname(s.focusFile);
      const locks = path.join(s.root, '.forge', 'locks');
      fs.mkdirSync(runtime, { recursive: true });
      const good = JSON.stringify({ v: 1, job: a, since: '2026-01-01T00:00:00.000Z' });
      const target = path.join(s.root, 'elsewhere.json');
      fs.writeFileSync(target, good);
      // Windows has no FIFOs, and planting a symlink there needs a privilege CI runners lack.
      const posixOnly: [string, () => void][] = [
        ['a symlink', () => fs.symlinkSync(target, s.focusFile)],
        ['a FIFO', () => assert.equal(spawnSync('mkfifo', [s.focusFile]).status, 0)],
      ];
      const plants: [string, () => void][] = [
        ...(process.platform === 'win32' ? [] : posixOnly),
        ['a file over 64 KiB', () => fs.writeFileSync(s.focusFile, JSON.stringify({ v: 1, job: a, since: 'x', pad: 'x'.repeat(65 * 1024) }))],
        ['invalid JSON', () => fs.writeFileSync(s.focusFile, '{"job": ')],
        ['an invalid id', () => fs.writeFileSync(s.focusFile, JSON.stringify({ v: 1, job: '../../etc', since: 'x' }))],
        ['a missing job', () => fs.writeFileSync(s.focusFile, JSON.stringify({ v: 1, job: 'never-was', since: 'x' }))],
        ['an archived job', () => fs.writeFileSync(s.focusFile, JSON.stringify({ v: 1, job: archived, since: 'x' }))],
      ];
      for (const [what, plant] of plants) {
        fs.rmSync(s.focusFile, { force: true });
        plant();
        const stat = () => (fs.existsSync(s.focusFile) ? fs.lstatSync(s.focusFile) : null);
        const before = stat();
        const runtimeBefore = fs.readdirSync(runtime).sort();
        const locksBefore = fs.existsSync(locks) ? fs.readdirSync(locks).sort() : [];
        const r = await forgeAsync(s.root, ['focus']);
        assert.equal(r.status, 0, `${what}: ${r.stderr}`);
        assert.deepEqual(JSON.parse(r.stdout), { focus: null }, what);
        const after = stat();
        assert.equal(after?.mtimeMs, before?.mtimeMs, `${what}: the read wrote nothing`);
        assert.equal(after?.ino, before?.ino, what);
        assert.deepEqual(fs.readdirSync(runtime).sort(), runtimeBefore, `${what}: nothing written beside it`);
        assert.deepEqual(fs.existsSync(locks) ? fs.readdirSync(locks).sort() : [], locksBefore, `${what}: no lock taken`);
      }
      assert.equal(fs.readFileSync(target, 'utf8'), good, 'the link target is untouched');
    } finally {
      s.cleanup();
    }
  });

  test('focus events and audit rows', async () => {
    const s = scratch();
    try {
      const a = await s.job('Alpha');
      const b = await s.job('Beta');
      await s.f('focus', a);
      await s.f('focus', b);
      const again = await s.f('focus', b);
      assert.equal(again.previous, b, 're-focusing reports itself as previous');
      await s.f('focus', '--clear');

      const pick = (e: any) => ({ type: e.type, from: e.from, reason: e.reason, actor: e.actor?.source ?? null });
      assert.deepEqual(s.focusEvents(a).map(pick), [
        { type: 'focus', from: 'cli', reason: undefined, actor: 'env' },
        { type: 'unfocus', from: undefined, reason: 'switched', actor: null },
      ]);
      assert.deepEqual(s.focusEvents(b).map(pick), [
        { type: 'focus', from: 'cli', reason: undefined, actor: 'env' },
        { type: 'unfocus', from: undefined, reason: 'cleared', actor: 'env' },
      ], 're-focusing the focused job logged nothing');
      assert.equal(s.focusEvents(b)[0].actor.login, 'forge-test');

      const audit = await s.f('job', 'audit', b);
      assert.deepEqual(
        audit.rows.filter((r: any) => r.action === 'focus' || r.action === 'unfocus').map((r: any) => [r.action, r.detail, r.actor.source]),
        [
          ['focus', 'cli', 'env'],
          ['unfocus', 'cleared', 'env'],
        ],
      );
      assert.equal((await s.f('job', 'audit', a)).rows.filter((r: any) => r.action === 'unfocus').length, 0, 'a switch away is not a human row');
    } finally {
      s.cleanup();
    }
  });
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
      focusJob(s.root, id, 'cli', { login: 'forge-test', source: 'env' });
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
