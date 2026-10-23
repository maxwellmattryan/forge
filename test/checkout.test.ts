// Checkout steps (issue #187): `forge focus` links fixed paths to the focused job's build and runs
// configured commands, undoes them on the next change, and keeps the previous focus on a failure.
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { forgeAsync, repoTemplate } from './helpers.ts';
import { focusJob } from '#engine/workspace/focus-actions.ts';
import { checkoutFile, readCheckoutRecord } from '#engine/workspace/checkout.ts';
import { loadConfig } from '#core/config/load.ts';
import * as yaml from '#core/format/yaml.ts';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'forge');
const POSIX = process.platform === 'win32' && 'POSIX symlinks and shell commands';

const template = repoTemplate((dir) => {
  const answers = path.join(dir, '.answers.json');
  const base = 20000 + Math.floor(Math.random() * 20000);
  // Each marker command appends "<word> <job>" to a file in the root repo, by absolute path.
  const mark = (word: string) => `echo "${word} $FORGE_JOB" >> {root}/.marker`;
  const commands = { on: mark('on'), off: mark('off'), evil: mark('evil'), gate: 'test "$FORGE_JOB" != beta' };
  fs.writeFileSync(answers, JSON.stringify({ tracker: { kind: 'local' }, pr: { enabled: false }, ports: { base, span: 10 }, commands, worktrees: { root: '../{repo}.wt' } }));
  const r = spawnSync(process.execPath, [BIN, 'init', 'write', '--answers', answers], { cwd: dir, encoding: 'utf8', env: { ...process.env, FORGE_ROOT: dir } });
  if (r.status !== 0) throw new Error(r.stderr);
  fs.rmSync(answers);
});

function scratch() {
  const repo = template();
  const root = repo.dir;
  const fixed = `${root}.fixed`;
  fs.mkdirSync(fixed);
  const target = path.join(fixed, 'plugin');
  const aside = `${target}.forge-aside`;
  const cfgFile = path.join(root, '.forge', 'config.yml');
  const f = async (...args: string[]) => {
    const r = await forgeAsync(root, args);
    if (r.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${r.status}: ${r.stderr}${r.stdout}`);
    return JSON.parse(r.stdout);
  };
  const fail = async (...args: string[]) => {
    const r = await forgeAsync(root, ['--json', ...args]);
    assert.equal(r.status, 1, `forge ${args.join(' ')} should exit 1: ${r.stdout}${r.stderr}`);
    return JSON.parse(r.stdout).error.message as string;
  };
  const configure = (patch: Record<string, unknown>) => fs.writeFileSync(cfgFile, yaml.stringify({ ...yaml.parse(fs.readFileSync(cfgFile, 'utf8')), ...patch }));
  const linkStep = () => configure({ checkout: [{ link: 'out/plugin', to: target }] });
  /** A job with a worktree whose out/plugin holds `content` (no build when content is null). */
  const job = async (ref: string, content: string | null = `${ref} build`) => {
    const id = (await f('job', 'new', '--title', ref, '--ref', ref)).id as string;
    const wt = (await f('worktree', 'create', id)).path as string;
    if (content !== null) {
      fs.mkdirSync(path.join(wt, 'out'), { recursive: true });
      fs.writeFileSync(path.join(wt, 'out', 'plugin'), content);
    }
    return { id, wt, source: path.join(fs.realpathSync(wt), 'out', 'plugin') };
  };
  const events = (id: string) =>
    fs
      .readFileSync(path.join(root, '.forge', 'jobs', id, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  const marker = () => (fs.existsSync(path.join(root, '.marker')) ? fs.readFileSync(path.join(root, '.marker'), 'utf8').trim().split('\n') : []);
  const readlink = () => (fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : null);
  const cleanup = () => {
    repo.cleanup();
    fs.rmSync(`${root}.wt`, { recursive: true, force: true });
    fs.rmSync(fixed, { recursive: true, force: true });
  };
  return { root, fixed, target, aside, f, fail, configure, linkStep, job, events, marker, readlink, record: checkoutFile(root), cleanup };
}

describe('checkout steps', { concurrency: 4 }, () => {
  test('focus A then B then clear moves the fixed path and restores the original', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const b = await s.job('beta');
      s.linkStep();
      fs.writeFileSync(s.target, 'original bytes\n');
      const r1 = await s.f('focus', a.id);
      assert.equal(r1.focus.id, a.id);
      assert.deepEqual(r1.checkout, { undone: [], applied: [{ step: 0, kind: 'link', ok: true, to: s.target }] });
      assert.equal(s.readlink(), a.source);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'alpha build');
      assert.equal(fs.readFileSync(s.aside, 'utf8'), 'original bytes\n');
      const rec = JSON.parse(fs.readFileSync(s.record, 'utf8'));
      assert.deepEqual(rec, { v: 1, job: a.id, entries: [{ step: 0, kind: 'link', to: s.target, source: a.source, aside: true, state: 'applied' }] });

      // Re-focusing the checked-out job is a no-op.
      const again = await s.f('focus', a.id);
      assert.equal(again.checkout, undefined);

      const r2 = await s.f('focus', b.id);
      assert.equal(r2.checkout.job, a.id);
      assert.equal(r2.checkout.undone[0].ok, true);
      assert.equal(s.readlink(), b.source);
      assert.equal(fs.readFileSync(s.aside, 'utf8'), 'original bytes\n');

      const r3 = await s.f('focus', '--clear');
      assert.equal(r3.focus, null);
      assert.equal(r3.checkout.job, b.id);
      assert.equal(s.readlink(), null);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'original bytes\n');
      assert.equal(fs.existsSync(s.aside), false);
      assert.equal(fs.existsSync(s.record), false);
      const ev = s.events(a.id).filter((e) => e.type === 'checkout');
      assert.deepEqual(
        ev.map((e) => [e.phase, e.step, e.kind, e.ok]),
        [
          ['apply', 0, 'link', true],
          ['undo', 0, 'link', true],
        ],
      );
      assert.equal('to' in ev[0], false, 'paths stay out of events');
    } finally {
      s.cleanup();
    }
  });

  test('run steps and their undo log like forge run', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const b = await s.job('beta');
      s.configure({ checkout: [{ run: 'on', undo: 'off' }] });
      const r1 = await s.f('focus', a.id);
      assert.equal(r1.checkout.applied[0].command, 'on');
      assert.match(r1.checkout.applied[0].log, /^logs\/checkout-on-.*\.log$/);
      await s.f('focus', b.id);
      assert.deepEqual(s.marker(), ['on alpha', 'off alpha', 'on beta']);
      const logs = (id: string) => fs.readdirSync(path.join(s.root, '.forge', 'jobs', id, 'logs')).filter((l) => l.startsWith('checkout')).sort();
      assert.deepEqual(logs(a.id).map((l) => l.replace(/-\d{4}-.*$/, '')), ['checkout-on', 'checkout-undo-off']);
      assert.deepEqual(logs(b.id).map((l) => l.replace(/-\d{4}-.*$/, '')), ['checkout-on']);
      const commands = (id: string) => s.events(id).filter((e) => e.type === 'command').map((e) => e.name);
      assert.deepEqual(commands(a.id), ['on', 'off']);
      assert.deepEqual(commands(b.id), ['on']);
    } finally {
      s.cleanup();
    }
  });

  test('a failing step rolls back and keeps the previous focus', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const b = await s.job('beta');
      fs.writeFileSync(s.target, 'original');
      s.configure({ checkout: [{ link: 'out/plugin', to: s.target }, { run: 'gate' }] });
      await s.f('focus', a.id);
      assert.equal(s.readlink(), a.source);
      const message = await s.fail('focus', b.id);
      assert.match(message, /^checkout\[1\] run gate failed \(exit 1\); log: logs\/checkout-gate-.*\.log; focus stays on alpha$/);
      assert.equal((await s.f('focus')).focus.id, a.id);
      assert.equal(s.readlink(), a.source, "A's build is linked again");
      assert.equal(fs.readFileSync(s.aside, 'utf8'), 'original');
      assert.equal(readCheckoutRecord(s.root)?.job, a.id);
      const bev = s.events(b.id).filter((e) => e.type === 'checkout').map((e) => [e.phase, e.step, e.ok]);
      assert.deepEqual(bev, [
        ['apply', 0, true],
        ['apply', 1, false],
        ['rollback', 0, true],
      ]);
      assert.equal(s.events(b.id).some((e) => e.type === 'focus'), false);
    } finally {
      s.cleanup();
    }
  });

  test('a missing or escaping link source is refused', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const missing = await s.job('alpha', null);
      const escaping = await s.job('beta', null);
      const outside = path.join(s.fixed, 'outside');
      fs.writeFileSync(outside, 'secret');
      fs.mkdirSync(path.join(escaping.wt, 'out'));
      fs.symlinkSync(outside, path.join(escaping.wt, 'out', 'plugin'));
      s.linkStep();
      fs.writeFileSync(s.target, 'original');
      assert.match(await s.fail('focus', missing.id), /checkout\[0\] link .* failed: source out\/plugin does not exist/);
      assert.match(await s.fail('focus', escaping.id), /checkout\[0\] link .* failed: source out\/plugin resolves outside the job's worktree/);
      assert.equal(s.readlink(), null);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'original');
      assert.equal(fs.existsSync(s.aside), false);
      assert.equal(fs.existsSync(s.record), false);
      assert.deepEqual(await s.f('focus'), { focus: null });
    } finally {
      s.cleanup();
    }
  });

  test('a forged job worktree is refused', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const other = path.join(s.fixed, 'elsewhere');
      fs.mkdirSync(path.join(other, 'out'), { recursive: true });
      fs.writeFileSync(path.join(other, 'out', 'plugin'), 'forged');
      const file = path.join(s.root, '.forge', 'jobs', a.id, 'job.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), worktree: other }));
      s.linkStep();
      fs.writeFileSync(s.target, 'original');
      assert.match(await s.fail('focus', a.id), /checkout\[0\] link .* failed: the job has no worktree of its own/);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'original');
      assert.equal(fs.existsSync(s.aside), false);
    } finally {
      s.cleanup();
    }
  });

  test('a forged job worktree runs no command on apply or undo', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const other = path.join(s.fixed, 'elsewhere');
      fs.mkdirSync(other);
      const file = path.join(s.root, '.forge', 'jobs', a.id, 'job.json');
      fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), worktree: other }));
      s.configure({ checkout: [{ run: 'on', undo: 'off' }] });
      assert.match(await s.fail('focus', a.id), /checkout\[0\] run on failed \(the job has no worktree of its own under the worktrees root; nothing run\)/);
      assert.deepEqual(s.marker(), [], 'apply ran nothing');
      assert.equal(fs.existsSync(s.record), false);

      // A planted record naming a configured pair for that job runs no undo either.
      fs.mkdirSync(path.dirname(s.record), { recursive: true });
      fs.writeFileSync(s.record, JSON.stringify({ v: 1, job: a.id, entries: [{ step: 0, kind: 'run', run: 'on', undo: 'off', state: 'applied' }] }));
      const r = await s.f('focus', '--clear');
      assert.deepEqual(r.checkout.undone.map((u: any) => [u.step, u.ok]), [[0, false]]);
      assert.match(r.checkout.undone[0].error, /no worktree of its own/);
      assert.deepEqual(s.marker(), [], 'undo ran nothing');
      assert.equal(fs.existsSync(s.record), false);
    } finally {
      s.cleanup();
    }
  });

  test('a link source whose first segment starts with .. is accepted', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha', null);
      fs.mkdirSync(path.join(a.wt, '..build'));
      fs.writeFileSync(path.join(a.wt, '..build', 'plugin'), 'dotted');
      s.configure({ checkout: [{ link: '..build/plugin', to: s.target }] });
      await s.f('focus', a.id);
      assert.equal(s.readlink(), path.join(fs.realpathSync(a.wt), '..build', 'plugin'));
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'dotted');
    } finally {
      s.cleanup();
    }
  });

  test('a planted checkout record is ignored',{ timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      s.linkStep();
      // Not a configured target: a link Forge could have made and an aside it could restore.
      const victim = path.join(s.fixed, 'victim');
      fs.symlinkSync(a.source, victim);
      fs.writeFileSync(`${victim}.forge-aside`, 'crafted');
      const planted = {
        v: 1,
        job: a.id,
        entries: [
          { step: 0, kind: 'link', to: victim, source: a.source, aside: true, state: 'applied' },
          { step: 1, kind: 'run', run: 'on', undo: 'evil', state: 'applied' },
        ],
      };
      fs.mkdirSync(path.dirname(s.record), { recursive: true });
      fs.writeFileSync(s.record, JSON.stringify(planted));
      const r = await s.f('focus', '--clear');
      assert.deepEqual(
        r.checkout.undone.map((u: any) => [u.step, u.ok]),
        [
          [1, false],
          [0, false],
        ],
      );
      assert.equal(fs.readlinkSync(victim), a.source, 'the link is left alone');
      assert.equal(fs.readFileSync(`${victim}.forge-aside`, 'utf8'), 'crafted');
      assert.deepEqual(s.marker(), [], 'the unconfigured undo ran nothing');
      assert.equal(fs.existsSync(s.record), false);

      // A configured target with a source outside the job's path is not ours either.
      fs.writeFileSync(s.target, 'user');
      fs.writeFileSync(s.record, JSON.stringify({ v: 1, job: a.id, entries: [{ step: 0, kind: 'link', to: s.target, source: '/etc/hosts', aside: true, state: 'applied' }] }));
      await s.f('focus', '--clear');
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'user');

      // A symlinked, oversized or malformed record reads as none.
      const real = path.join(s.fixed, 'real.json');
      fs.writeFileSync(real, JSON.stringify(planted));
      fs.rmSync(s.record, { force: true });
      fs.symlinkSync(real, s.record);
      assert.equal(readCheckoutRecord(s.root), null);
      fs.rmSync(s.record);
      fs.writeFileSync(s.record, JSON.stringify({ ...planted, pad: 'x'.repeat(70 * 1024) }));
      assert.equal(readCheckoutRecord(s.root), null);
      fs.writeFileSync(s.record, JSON.stringify({ ...planted, job: '../x' }));
      assert.equal(readCheckoutRecord(s.root), null);
      fs.writeFileSync(s.record, JSON.stringify({ ...planted, entries: [{ step: 0, kind: 'link', to: 'relative', source: a.source, aside: true, state: 'applied' }] }));
      assert.equal(readCheckoutRecord(s.root), null);
    } finally {
      s.cleanup();
    }
  });

  test('existing aside and user-changed targets are left alone', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      s.linkStep();
      fs.writeFileSync(s.target, 'mine');
      fs.writeFileSync(s.aside, 'also mine');
      assert.match(await s.fail('focus', a.id), /forge-aside already exists/);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'mine');
      assert.equal(fs.readFileSync(s.aside, 'utf8'), 'also mine');

      fs.rmSync(s.aside);
      await s.f('focus', a.id);
      fs.rmSync(s.target);
      fs.writeFileSync(s.target, 'replaced by the user');
      const r = await s.f('focus', '--clear');
      assert.equal(r.checkout.undone[0].ok, false);
      assert.match(r.checkout.undone[0].error, /changed since focus; left in place/);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'replaced by the user');
      assert.equal(fs.readFileSync(s.aside, 'utf8'), 'mine', 'the original stays aside, never deleted');
    } finally {
      s.cleanup();
    }
  });

  test('a pending entry from a crash is undone', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      s.linkStep();
      // The crash came after the rename aside and before the symlink.
      fs.writeFileSync(s.aside, 'original');
      fs.mkdirSync(path.dirname(s.record), { recursive: true });
      fs.writeFileSync(s.record, JSON.stringify({ v: 1, job: a.id, entries: [{ step: 0, kind: 'link', to: s.target, source: a.source, aside: true, state: 'pending' }] }));
      const r = await s.f('focus', '--clear');
      assert.equal(r.checkout.undone[0].ok, true);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'original');
      assert.equal(fs.existsSync(s.aside), false);
      assert.equal(fs.existsSync(s.record), false);
    } finally {
      s.cleanup();
    }
  });

  test('worktree removal and clear undo a finished job\'s checkout', { timeout: 60_000, skip: POSIX }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const b = await s.job('beta');
      s.linkStep();
      fs.writeFileSync(s.target, 'original');
      await s.f('focus', a.id);
      await s.f('job', 'set', a.id, '--state', 'done');
      assert.deepEqual(await s.f('focus'), { focus: null });
      assert.equal(s.readlink(), a.source, 'finishing does not undo the checkout');
      await s.f('worktree', 'remove', a.id, '--force');
      assert.equal(fs.existsSync(a.wt), false);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'original');
      assert.equal(fs.existsSync(s.aside), false);
      assert.equal(fs.existsSync(s.record), false);

      await s.f('focus', b.id);
      await s.f('job', 'set', b.id, '--state', 'done');
      const r = await s.f('focus', '--clear');
      assert.equal(r.checkout.job, b.id);
      assert.equal(fs.readFileSync(s.target, 'utf8'), 'original');
      assert.equal(fs.existsSync(s.record), false);
    } finally {
      s.cleanup();
    }
  });

  test('no steps writes no record', { timeout: 60_000 }, async () => {
    const s = scratch();
    try {
      const a = await s.job('alpha');
      const r = await s.f('focus', a.id);
      assert.equal('checkout' in r, false);
      const inProcess = await focusJob(s.root, null, 'cli', { login: 'forge-test', source: 'env' }, { config: loadConfig(s.root).config });
      assert.equal('checkout' in inProcess, false);
      assert.equal(fs.existsSync(s.record), false);
    } finally {
      s.cleanup();
    }
  });
});
