// The worktree seed's two guards that need no git: where a seed may live (only a private directory)
// and how a tree is cloned (copy-on-write, then a plain copy, then nothing).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cloneTree, refreshSeed, seedRoot, SYSTEM_SEED_OPS } from './seed.ts';
import type { SeedOps } from './seed.ts';

const repoId = (root: string) => crypto.createHash('sha256').update(fs.realpathSync(root)).digest('hex').slice(0, 16);

function scratch(): { tmp: string; root: string; cleanup: () => void } {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-seed-')));
  const root = path.join(tmp, 'repo');
  fs.mkdirSync(root);
  return { tmp, root, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** A directory holding what looks like a complete seed, to prove a refused root never reads or writes it. */
function plantedSeed(dir: string): string[] {
  const key = 'a'.repeat(64);
  fs.mkdirSync(path.join(dir, key, 'deps'), { recursive: true });
  fs.writeFileSync(path.join(dir, key, 'deps', 'lib.txt'), 'planted');
  fs.writeFileSync(path.join(dir, key, 'seed.json'), JSON.stringify({ v: 1, key, paths: ['deps'], commit: 'b'.repeat(40), createdAt: new Date().toISOString() }));
  return fs.readdirSync(dir, { recursive: true }) as string[];
}

test('the seed root must be a private directory', { skip: process.platform === 'win32' }, () => {
  const rows: { name: string; arrange: (s: ReturnType<typeof scratch>) => { cache: string; check?: () => void } }[] = [
    {
      name: 'FORGE_CACHE_DIR is a symlink',
      arrange: (s) => {
        const real = path.join(s.tmp, 'real');
        fs.mkdirSync(real, { mode: 0o700 });
        fs.symlinkSync(real, path.join(s.tmp, 'cache'));
        return { cache: path.join(s.tmp, 'cache'), check: () => assert.deepEqual(fs.readdirSync(real), [], 'nothing written through the link') };
      },
    },
    {
      name: 'the cache dir is group-writable',
      arrange: (s) => {
        const cache = path.join(s.tmp, 'cache');
        fs.mkdirSync(cache);
        fs.chmodSync(cache, 0o770);
        return { cache, check: () => assert.deepEqual(fs.readdirSync(cache), []) };
      },
    },
    {
      name: 'the cache dir is world-writable',
      arrange: (s) => {
        const cache = path.join(s.tmp, 'cache');
        fs.mkdirSync(cache);
        fs.chmodSync(cache, 0o707);
        return { cache };
      },
    },
    {
      name: 'seeds/<repoId> is group-writable',
      arrange: (s) => {
        const cache = path.join(s.tmp, 'cache');
        const dir = path.join(cache, 'seeds', repoId(s.root));
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.chmodSync(dir, 0o770);
        return { cache };
      },
    },
    {
      name: 'seeds/<repoId> is a symlink to a directory holding a valid seed',
      arrange: (s) => {
        const cache = path.join(s.tmp, 'cache');
        fs.mkdirSync(path.join(cache, 'seeds'), { recursive: true, mode: 0o700 });
        const elsewhere = path.join(s.tmp, 'elsewhere');
        fs.mkdirSync(elsewhere, { mode: 0o700 });
        const before = plantedSeed(elsewhere);
        fs.symlinkSync(elsewhere, path.join(cache, 'seeds', repoId(s.root)));
        return { cache, check: () => assert.deepEqual(fs.readdirSync(elsewhere, { recursive: true }), before, 'the linked seed is left as it was') };
      },
    },
  ];
  for (const row of rows) {
    const s = scratch();
    try {
      const { cache, check } = row.arrange(s);
      assert.equal(seedRoot(s.root, { FORGE_CACHE_DIR: cache }), null, row.name);
      check?.();
    } finally {
      s.cleanup();
    }
  }

  const s = scratch();
  try {
    const cache = path.join(s.tmp, 'fresh', 'cache');
    fs.mkdirSync(path.dirname(cache), { mode: 0o700 });
    const dir = seedRoot(s.root, { FORGE_CACHE_DIR: cache });
    assert.equal(dir, path.join(cache, 'seeds', repoId(s.root)), 'a fresh private cache dir is used');
    for (const level of [cache, path.join(cache, 'seeds'), dir!]) assert.equal(fs.lstatSync(level).mode & 0o777, 0o700, `${level} is created 0700`);
  } finally {
    s.cleanup();
  }
});

/** SeedOps on `platform` whose `cp` succeeds or fails (after leaving a partial dst behind), recording its calls. */
function ops(platform: NodeJS.Platform, cp: 'ok' | 'fail', copy: SeedOps['copy'] = SYSTEM_SEED_OPS.copy) {
  const calls: { cmd: string; args: string[] }[] = [];
  const o: SeedOps = {
    platform,
    run: (cmd, args) => {
      calls.push({ cmd, args });
      if (cp === 'ok') return { ok: true };
      fs.mkdirSync(args[args.length - 1], { recursive: true });
      return { ok: false };
    },
    copy,
  };
  return { o, calls };
}

test('cloneTree falls back from copy-on-write to a plain copy, then to nothing', () => {
  const s = scratch();
  try {
    const src = path.join(s.tmp, 'src');
    fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(src, 'a', 'b', 'f.txt'), 'content');
    fs.symlinkSync('b/f.txt', path.join(src, 'a', 'link'));
    let n = 0;
    const dst = () => path.join(s.tmp, `dst-${++n}`, 'nested', 'deps');
    const failingCopy: SeedOps['copy'] = (_src, to) => {
      fs.mkdirSync(to, { recursive: true });
      throw new Error('disk full');
    };
    const rows: { name: string; platform: NodeJS.Platform; cp: 'ok' | 'fail'; copy?: SeedOps['copy']; want: 'clone' | 'copy' | null; argv: (src: string, dst: string) => string[] | null }[] = [
      { name: 'darwin clones with cp -c', platform: 'darwin', cp: 'ok', want: 'clone', argv: (a, b) => ['-c', '-a', '--', a, b] },
      { name: 'linux clones with --reflink=auto', platform: 'linux', cp: 'ok', want: 'clone', argv: (a, b) => ['-a', '--reflink=auto', '--', a, b] },
      { name: 'win32 runs no cp', platform: 'win32', cp: 'ok', want: 'copy', argv: () => null },
      { name: 'a failing cp falls back to a plain copy', platform: 'darwin', cp: 'fail', want: 'copy', argv: (a, b) => ['-c', '-a', '--', a, b] },
      { name: 'a failing plain copy leaves nothing', platform: 'linux', cp: 'fail', copy: failingCopy, want: null, argv: (a, b) => ['-a', '--reflink=auto', '--', a, b] },
    ];
    for (const row of rows) {
      const to = dst();
      const { o, calls } = ops(row.platform, row.cp, row.copy);
      assert.equal(cloneTree(src, to, o), row.want, row.name);
      const argv = row.argv(src, to);
      assert.deepEqual(calls, argv ? [{ cmd: 'cp', args: argv }] : [], `${row.name}: cp argv`);
      if (row.want === 'copy') {
        assert.equal(fs.readFileSync(path.join(to, 'a', 'b', 'f.txt'), 'utf8'), 'content', `${row.name}: same content`);
        assert.equal(fs.readlinkSync(path.join(to, 'a', 'link')), 'b/f.txt', `${row.name}: symlinks kept verbatim`);
      }
      if (row.want === null || (row.want === 'clone' && row.cp === 'ok')) {
        // A fake cp writes nothing, so a clone row has no dst either; a failed one must not leave its partial dst.
        assert.equal(fs.existsSync(to), false, `${row.name}: no dst`);
      }
    }
  } finally {
    s.cleanup();
  }
});

// The refusals (absolute, out of the tree, a chain that climbs out) are rows of worktree.test.ts'
// "only a fresh worktree at the base tip refreshes the seed"; this pins what the link check lets through.
test('refreshSeed keeps the links that stay inside the seed, as written', { skip: process.platform === 'win32' }, () => {
  const s = scratch();
  try {
    const seedDir = path.join(s.tmp, 'seeds');
    fs.mkdirSync(seedDir, { mode: 0o700 });
    const dir = path.join(s.tmp, 'wt');
    fs.mkdirSync(path.join(dir, 'deps', 'pkg', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'deps', '.bin'));
    fs.writeFileSync(path.join(dir, 'deps', 'pkg', 'bin', 'x.js'), 'x');
    // npm's .bin links, a link to a sibling, and one up to the tree's root.
    const links = { 'deps/.bin/x': '../pkg/bin/x.js', 'deps/sibling': './pkg', 'deps/up': '..' };
    for (const [from, to] of Object.entries(links)) fs.symlinkSync(to, path.join(dir, from));
    const key = 'c'.repeat(64);
    assert.deepEqual(refreshSeed(seedDir, key, dir, ['deps'], 'd'.repeat(40)), { refreshed: true });
    for (const [from, to] of Object.entries(links)) assert.equal(fs.readlinkSync(path.join(seedDir, key, from)), to, `${from} is kept as written`);
    assert.equal(fs.readFileSync(path.join(seedDir, key, 'deps', 'pkg', 'bin', 'x.js'), 'utf8'), 'x');
  } finally {
    s.cleanup();
  }
});
