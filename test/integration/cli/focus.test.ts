// `forge focus` (issue #177): it moves a pointer in the root repo's .forge/runtime/focus.json and lets
// go when the focused job finishes. How lib/focus.ts reads a planted record is test/focus.test.ts.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forgeAsync, forgeSync, repoTemplate } from '../../helpers.ts';
import { TRUST_ENV, trustDigest } from '../../../lib/core/config/load.ts';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
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
      const inWt = (...args: string[]) => {
        const r = forgeSync(wt, args, { FORGE_ROOT: undefined }, { cwd: wt });
        assert.equal(r.status, 0, r.stderr);
        return JSON.parse(r.stdout);
      };
      assert.equal(inWt('focus').focus.id, a);
      const moved = inWt('focus', b);
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

  // Every other plant (a FIFO, an oversized file, bad JSON, a bad id, a gone job) is test/focus.test.ts, in-process.
  test('a planted focus symlink reads as none through the CLI', { skip: process.platform === 'win32' && 'planting a symlink needs a privilege CI runners lack' }, async () => {
    const s = scratch();
    try {
      const a = await s.job('Alpha');
      fs.mkdirSync(path.dirname(s.focusFile), { recursive: true });
      const good = JSON.stringify({ v: 1, job: a, since: '2026-01-01T00:00:00.000Z' });
      const target = path.join(s.root, 'elsewhere.json');
      fs.writeFileSync(target, good);
      fs.symlinkSync(target, s.focusFile);
      const before = fs.lstatSync(s.focusFile);
      const r = await forgeAsync(s.root, ['focus']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { focus: null });
      const after = fs.lstatSync(s.focusFile);
      assert.equal(after.ino, before.ino, 'the read replaced nothing');
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
