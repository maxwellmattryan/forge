// The GitHub tracker's ref guard: a ref verb sends gh only an issue number in its own -R repo,
// after `--`. The table is pure; the verb tests run the adapter against fakeGh on this process's PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fakeGh, type GhReply } from '../../../test/helpers.ts';
import { defaults } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { createJob } from '#core/job/store.ts';
import { paths } from '#core/paths.ts';
import github, { issueNumber } from './tracker.ts';
import type { Config, LoadedJob, TrackerCtx } from '#core/types.ts';

const POSIX = { skip: process.platform === 'win32' };
const isUsage = (e: unknown) => e instanceof ForgeError && e.code === 'usage' && e.exitCode === 2 && e.hint === 'forge help tracker';

const ACCEPTED: [unknown, number][] = [
  ['12', 0],
  ['#12', 0],
  [' 12 ', 0],
  ['o/r#12', 1],
  ['O/R#12', 1],
];

const REFUSED: unknown[] = [
  'https://github.com/other/victim/issues/5',
  'https://github.com/o/r/issues/5',
  'other/victim#5',
  'o/r/x#5',
  '--web',
  '-5',
  '--repo=other/victim',
  '0',
  '012',
  '12345678901',
  '12 --web',
  '12\n',
  '..',
  'abc',
  '',
  'x'.repeat(300),
  null,
  undefined,
  12,
  {},
];

test('issueNumber takes only an issue number in this repo', () => {
  for (const [ref, slugReads] of ACCEPTED) {
    let reads = 0;
    assert.equal(issueNumber(ref, () => (reads++, 'o/r')), '12', JSON.stringify(ref));
    assert.equal(reads, slugReads, `${JSON.stringify(ref)} reads the slug ${slugReads} time(s)`);
  }
  for (const ref of REFUSED) {
    let reads = 0;
    assert.throws(() => issueNumber(ref, () => (reads++, 'o/r')), (e: unknown) => {
      assert.ok(isUsage(e), `${String(ref)}: ${(e as Error).message}`);
      const msg = (e as Error).message;
      assert.match(msg, /takes an issue number in this repo/);
      assert.ok(msg.includes(JSON.stringify(String(ref).slice(0, 100))), msg);
      assert.doesNotMatch(msg, /[\x00-\x1f\x7f]/);
      assert.ok(!msg.includes('x'.repeat(101)), 'the echoed ref is cut to 100 characters');
      return true;
    });
    const qualified = typeof ref === 'string' && /^[^#]+#5$/.test(ref) && !ref.includes(':');
    assert.equal(reads, qualified ? 1 : 0, `${String(ref)}: slug reads`);
  }
});

const ISSUE = JSON.stringify({ number: 12, title: 'T', body: '', url: 'https://github.com/o/r/issues/12', labels: [], assignees: [], comments: [], state: 'OPEN', author: { login: 'a' } });
const ROUTES: Record<string, GhReply> = { 'issue view': ISSUE, 'issue edit': '', 'issue comment': '', 'issue close': '', 'label create': '', 'api user': 'me' };
const JOB = { id: 'j1', state: 'running', stage: 'build', issues: [] } as unknown as LoadedJob;

function config(): Config {
  const c = defaults();
  c.tracker.kind = 'github';
  c.tracker.github.repo = 'o/r';
  c.tracker.github.statusSync = 'labels';
  return c;
}

/** Each ref verb of the adapter, called the way Forge calls it. */
const VERBS: [string, (ctx: TrackerCtx, ref: string) => unknown][] = [
  ['get', (ctx, ref) => github.get(ctx, ref)],
  ['claim', (ctx, ref) => github.claim(ctx, ref, JOB)],
  ['update', (ctx, ref) => github.update(ctx, ref, JOB)],
  ['comment', (ctx, ref) => github.comment(ctx, ref, 'hello')],
  ['setNeedsInfo', (ctx, ref) => github.setNeedsInfo(ctx, ref, 'needs a repro')],
  ['setNeedsInfo (clear)', (ctx, ref) => github.setNeedsInfo(ctx, ref, null)],
  ['close', (ctx, ref) => github.close(ctx, ref)],
];

/** A scratch root and fakeGh first on this process's PATH (the adapter's gh calls pass no env). */
function scratch(fn: (ctx: TrackerCtx, fake: ReturnType<typeof fakeGh>) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-gh-tracker-'));
  const fake = fakeGh(ROUTES);
  const saved = process.env.PATH;
  process.env.PATH = fake.env.PATH;
  try {
    fn({ root, config: config() }, fake);
  } finally {
    process.env.PATH = saved;
    fs.rmSync(fake.dir, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const githubLocks = (root: string): string[] => {
  const dir = paths(root).locks;
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith('github-')) : [];
};

test('every ref verb refuses a ref outside this repo before gh runs', POSIX, () => {
  scratch((ctx, fake) => {
    for (const ref of ['https://github.com/other/victim/issues/5', '--web', 'other/victim#5']) {
      for (const [verb, call] of VERBS) {
        assert.throws(() => call(ctx, ref), isUsage, `${verb} ${ref}`);
        assert.deepEqual(fake.calls(), [], `${verb} ${ref}: gh ran`);
        assert.deepEqual(githubLocks(ctx.root), [], `${verb} ${ref}: a lock was made`);
      }
    }
  });
});

test('ref verbs pass the issue number after --', POSIX, () => {
  scratch((ctx, fake) => {
    // A shim in front of the fake records the lock dir's entries during each gh call, so the
    // claim's lock name shows while it is held.
    const locks = paths(ctx.root).locks;
    const seen = path.join(fake.dir, 'locks.log');
    fs.renameSync(fake.bin, `${fake.bin}-real`);
    fs.writeFileSync(fake.bin, `#!/bin/sh\nls '${locks}' >> '${seen}' 2>/dev/null\nexec '${fake.bin}-real' "$@"\n`, { mode: 0o755 });
    for (const [verb, call] of VERBS) {
      const before = fake.calls().length;
      call(ctx, 'O/R#12');
      const calls = fake.calls().slice(before).map((c) => c.args);
      assert.ok(calls.some((a) => a[0] === 'issue'), `${verb}: no issue call`);
      for (const args of calls) {
        assert.ok(!args.includes('O/R#12'), `${verb}: ${args.join(' ')}`);
        if (args[0] !== 'issue') continue;
        assert.deepEqual(args.slice(-2), ['--', '12'], `${verb}: ${args.join(' ')}`);
        assert.equal(args.indexOf('--'), args.length - 2, `${verb}: ${args.join(' ')}`);
      }
      if (verb === 'close') assert.deepEqual(calls, [['issue', 'close', '-R', 'o/r', '--reason', 'completed', '--', '12']]);
      if (verb === 'claim') {
        const held = fs.readFileSync(seen, 'utf8').split('\n').filter((l) => l.startsWith('github-'));
        assert.ok(held.length > 0 && held.every((l) => l === 'github-12'), held.join(','));
      }
    }
    // The claim compares against 12: an active local job on o/r#12 already holds it.
    const other = createJob(ctx.root, ctx.config, { title: 'Holder', issues: [{ tracker: 'github', ref: 'o/r#12' }] as LoadedJob['issues'] });
    assert.deepEqual(github.claim(ctx, 'O/R#12', JOB), { ok: false, reason: `already claimed by local job ${other.id}` });
  });
});
