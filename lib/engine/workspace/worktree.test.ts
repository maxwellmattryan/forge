// createWorktree with a worktree seed (docs/CONFIG.md › Worktree seed): a hit clones the seed instead
// of running setup, every miss falls back to setup, and only a fresh worktree at the base tip refreshes
// the seed. In-process on scratch repos; each test points FORGE_CACHE_DIR at its own private dir, so
// the tests in this file run one at a time.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoTemplate } from '../../../test/helpers.ts';
import { createWorktree } from './worktree.ts';
import { seedKey, seedRoot } from './seed.ts';
import { defaults } from '#core/config/load.ts';
import { createJob, readEvents, setJob } from '#core/job/store.ts';
import type { Config } from '#core/types.ts';

const repo = repoTemplate((dir) => {
  fs.writeFileSync(path.join(dir, '.gitignore'), 'deps/\n');
  fs.writeFileSync(path.join(dir, 'deps.lock'), 'v1\n');
  execGit(dir, 'add', '-A');
  execGit(dir, 'commit', '-qm', 'deps');
});

function execGit(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, stdio: 'pipe' }).toString();
}

// Setup refuses to build over a warm seed path, so a run that succeeds proves a failed check removed
// the clone first. It counts its runs in the main checkout's .git, outside every worktree.
const SETUP = 'test ! -e deps/warm.txt && mkdir -p deps && echo built > deps/lib.txt && echo ran >> "{root}/.git/setup.log"';

function seedConfig(seed: Partial<Config['worktrees']['seed']> = {}, setup = [SETUP]): Config {
  const c = defaults();
  c.worktrees.root = '../{repo}.wt';
  c.worktrees.setup = setup;
  c.worktrees.seed = { paths: ['deps'], key: ['deps.lock'], setup: ['test -f deps/lib.txt'], warm: ['echo warm > deps/warm.txt'], ...seed };
  return c;
}

let cache = '';
let cacheTmp = '';
const savedCache = process.env.FORGE_CACHE_DIR;
const scratch: string[] = [];

beforeEach(() => {
  cacheTmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-seed-cache-')));
  cache = path.join(cacheTmp, 'cache');
  process.env.FORGE_CACHE_DIR = cache;
});

afterEach(() => {
  if (savedCache === undefined) delete process.env.FORGE_CACHE_DIR;
  else process.env.FORGE_CACHE_DIR = savedCache;
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(cacheTmp, { recursive: true, force: true });
});

function newRepo(): string {
  const r = repo();
  scratch.push(r.dir, `${r.dir}.wt`);
  return r.dir;
}

const setupRuns = (root: string) => (fs.existsSync(path.join(root, '.git', 'setup.log')) ? fs.readFileSync(path.join(root, '.git', 'setup.log'), 'utf8').split('\n').filter(Boolean).length : 0);

/** Every key dir under the seed root that holds a seed.json, by key. */
function keyDirs(): string[] {
  const seeds = path.join(cache, 'seeds');
  if (!fs.existsSync(seeds)) return [];
  return fs.readdirSync(seeds).flatMap((repoId) => fs.readdirSync(path.join(seeds, repoId)).filter((k) => /^[0-9a-f]{64}$/.test(k) && fs.existsSync(path.join(seeds, repoId, k, 'seed.json'))));
}

function create(root: string, config: Config, title: string, opts: Parameters<typeof createWorktree>[3] = {}) {
  const id = createJob(root, config, { title }).id;
  const res = createWorktree(root, config, id, opts);
  assert.equal(res.created, true);
  if (!res.created) throw new Error('not created');
  return { id, res, seedEvents: () => readEvents(root, id).filter((e) => e.type === 'worktree-seed') };
}

function commitLock(root: string, body: string): void {
  fs.writeFileSync(path.join(root, 'deps.lock'), body);
  execGit(root, 'commit', '-qam', `lock ${body.trim()}`);
}

test('a matching key clones the seed instead of running setup', () => {
  const root = newRepo();
  const config = seedConfig();
  const a = create(root, config, 'job a');
  assert.equal(a.res.ok, true);
  assert.equal(setupRuns(root), 1);
  assert.deepEqual({ used: a.res.seed?.used, reason: a.res.seed?.reason, refreshed: a.res.seed?.refreshed }, { used: false, reason: 'no-seed', refreshed: true });
  assert.deepEqual(a.res.seed?.warm?.map((w) => w.ok), [true]);
  const key = seedKey(a.res.path, config)!;
  assert.equal(a.res.seed?.key, key.slice(0, 16));
  const keyDir = path.join(seedRoot(root)!, key);
  assert.equal(fs.readFileSync(path.join(keyDir, 'deps', 'lib.txt'), 'utf8'), 'built\n');
  assert.equal(fs.readFileSync(path.join(keyDir, 'deps', 'warm.txt'), 'utf8'), 'warm\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(keyDir, 'seed.json'), 'utf8')).key, key);

  const b = create(root, config, 'job b');
  assert.equal(b.res.ok, true);
  assert.equal(b.res.seed?.used, true);
  assert.ok(b.res.seed?.method === 'clone' || b.res.seed?.method === 'copy');
  assert.equal(b.res.seed?.refreshed, undefined);
  assert.equal(setupRuns(root), 1, 'worktrees.setup did not run');
  assert.deepEqual(b.res.setup, []);
  assert.deepEqual(b.res.seed?.checks?.map((c) => [c.cmd, c.ok]), [['test -f deps/lib.txt', true]]);
  assert.equal(fs.readFileSync(path.join(b.res.path, 'deps', 'lib.txt'), 'utf8'), 'built\n');
  assert.equal(fs.readFileSync(path.join(b.res.path, 'deps', 'warm.txt'), 'utf8'), 'warm\n');
  assert.equal(a.seedEvents().length, 1);
  assert.equal(b.seedEvents().length, 1);
  assert.equal(b.seedEvents()[0].used, true);
  assert.equal(b.seedEvents()[0].checks, undefined, 'events carry no command tails');

  // AC4: one-way. Writing B's copy leaves the seed's as it was, and nothing links back into the seed.
  fs.writeFileSync(path.join(b.res.path, 'deps', 'lib.txt'), 'changed\n');
  assert.equal(fs.readFileSync(path.join(keyDir, 'deps', 'lib.txt'), 'utf8'), 'built\n');
  if (process.platform !== 'win32') {
    for (const f of ['lib.txt', 'warm.txt']) {
      const mine = fs.lstatSync(path.join(b.res.path, 'deps', f));
      assert.equal(mine.isSymbolicLink(), false, `${f} is not a symlink`);
      assert.notEqual(mine.ino, fs.lstatSync(path.join(keyDir, 'deps', f)).ino, `${f} shares no inode with the seed`);
    }
    assert.equal(fs.lstatSync(path.join(b.res.path, 'deps')).isSymbolicLink(), false);
  }
});

test('a changed key file runs setup and refreshes a new seed', () => {
  const root = newRepo();
  const config = seedConfig();
  create(root, config, 'job a');
  const first = keyDirs();
  assert.equal(first.length, 1);
  commitLock(root, 'v2\n');
  const b = create(root, config, 'job b');
  assert.deepEqual({ used: b.res.seed?.used, reason: b.res.seed?.reason, refreshed: b.res.seed?.refreshed }, { used: false, reason: 'no-seed', refreshed: true });
  assert.equal(setupRuns(root), 2);
  const second = keyDirs();
  assert.equal(second.length, 2, 'the new key dir sits beside the old one');
  commitLock(root, 'v3\n');
  const c = create(root, config, 'job c');
  assert.equal(c.res.seed?.refreshed, true);
  const third = keyDirs();
  assert.equal(third.length, 2, 'only the newest two key dirs remain');
  assert.ok(!third.includes(first[0]), 'the oldest key dir is pruned');
  assert.ok(third.includes(seedKey(c.res.path, config)!));
});

test('seed misses fall back to worktrees.setup', () => {
  const rows: { name: string; reason: string; refreshSkipped?: string; arrange?: (root: string, config: Config) => Config; check?: (root: string, res: any, before: string[]) => void }[] = [
    { name: 'a missing key file', reason: 'no-key', refreshSkipped: 'no-key', arrange: () => seedConfig({ key: ['missing.lock'] }) },
    {
      name: 'an unsafe seed root',
      reason: 'cache-unusable',
      refreshSkipped: 'cache-unusable',
      arrange: (_root, config) => {
        fs.mkdirSync(cache, { mode: 0o700 });
        fs.chmodSync(cache, 0o777);
        return config;
      },
      check: () => assert.equal(fs.existsSync(path.join(cache, 'seeds')), false, 'nothing is written under an unsafe root'),
    },
    {
      name: 'a key dir without a valid seed.json',
      reason: 'no-seed',
      refreshSkipped: 'exists',
      arrange: (root, config) => {
        const dir = path.join(seedRoot(root)!, seedKey(root, config)!);
        fs.mkdirSync(path.join(dir, 'deps'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'seed.json'), '{ not json');
        return config;
      },
      check: (root, _res, before) => {
        assert.deepEqual(keyDirs(), before);
        assert.equal(fs.readFileSync(path.join(seedRoot(root)!, before[0], 'seed.json'), 'utf8'), '{ not json', 'the broken seed is not rewritten');
      },
    },
    {
      name: 'a seed path already in the worktree',
      reason: 'exists',
      arrange: (root, config) => {
        create(root, config, 'seeder');
        // worktrees.copy brings the main checkout's untracked deps/ into every new worktree.
        fs.mkdirSync(path.join(root, 'deps'));
        fs.writeFileSync(path.join(root, 'deps', 'local.txt'), 'local\n');
        return { ...config, worktrees: { ...config.worktrees, copy: ['deps'] } };
      },
      check: (root, res, before) => {
        assert.deepEqual(keyDirs(), before);
        assert.equal(fs.readFileSync(path.join(res.path, 'deps', 'local.txt'), 'utf8'), 'local\n', 'the copied path is kept');
        assert.equal(fs.existsSync(path.join(seedRoot(root)!, before[0], 'deps', 'local.txt')), false, 'nothing reaches the seed');
      },
    },
    {
      name: 'a failing seed.setup',
      reason: 'check-failed',
      arrange: (root, config) => {
        create(root, config, 'seeder');
        return { ...config, worktrees: { ...config.worktrees, seed: { ...config.worktrees.seed, setup: ['test -f deps/nope'] } } };
      },
      check: (_root, res) => {
        assert.deepEqual(res.seed.checks.map((c: any) => c.ok), [false]);
        // SETUP refuses a worktree that still holds the clone's deps/warm.txt, so ok proves it was removed first.
        assert.equal(fs.existsSync(path.join(res.path, 'deps', 'warm.txt')), false);
        assert.deepEqual(keyDirs(), [], 'the seed that failed its check is deleted and not rewritten');
      },
    },
  ];
  for (const row of rows) {
    const root = newRepo();
    let config = seedConfig();
    config = row.arrange?.(root, config) ?? config;
    const before = keyDirs();
    const runs = setupRuns(root);
    const { res, seedEvents } = create(root, config, `job ${row.name}`);
    assert.equal(res.ok, true, row.name);
    assert.equal(setupRuns(root), runs + 1, `${row.name}: setup ran`);
    assert.equal(res.seed?.used, false, row.name);
    assert.equal(res.seed?.reason, row.reason, row.name);
    assert.equal(res.seed?.refreshed, undefined, `${row.name}: no seed written`);
    assert.equal(res.seed?.refreshSkipped, row.refreshSkipped, `${row.name}: refreshSkipped`);
    if (!row.check) assert.deepEqual(keyDirs(), before, `${row.name}: no key dir written`);
    row.check?.(root, res, before);
    assert.equal(seedEvents().length, 1, `${row.name}: one worktree-seed event`);
    if (fs.existsSync(cache)) fs.chmodSync(cache, 0o700);
    fs.rmSync(cache, { recursive: true, force: true });
  }
});

test('only a fresh worktree at the base tip refreshes the seed', () => {
  const rows: { name: string; skip: string; arrange?: (root: string, config: Config, id: string) => Config | void; opts?: (root: string) => Parameters<typeof createWorktree>[3] }[] = [
    {
      name: 'a local branch with its own commit',
      skip: 'not-base',
      arrange: (root, _config, id) => {
        execGit(root, 'checkout', '-q', '-b', `forge/${id}`);
        fs.writeFileSync(path.join(root, 'job.txt'), 'mine\n');
        execGit(root, 'add', 'job.txt');
        execGit(root, 'commit', '-qm', 'job commit');
        execGit(root, 'checkout', '-q', 'main');
      },
    },
    {
      name: 'job.base moved to another branch',
      skip: 'not-base',
      arrange: (root, _config, id) => {
        execGit(root, 'branch', 'other');
        setJob(root, id, { owned: { base: 'other' } });
      },
    },
    {
      name: 'created --from (or stacked on) another branch',
      skip: 'not-base',
      arrange: (root) => void execGit(root, 'branch', 'other'),
      opts: () => ({ from: 'other' }),
    },
    { name: 'an absolute symlink in a seed path', skip: 'symlink-out', arrange: () => seedConfig({}, [SETUP, `ln -s ${JSON.stringify(os.tmpdir())} deps/out`]) },
    { name: 'a relative symlink out of a seed path', skip: 'symlink-out', arrange: () => seedConfig({}, [SETUP, 'ln -s ../../elsewhere deps/out']) },
  ];
  for (const row of rows) {
    const root = newRepo();
    let config = seedConfig();
    const id = createJob(root, config, { title: `job ${row.name}` }).id;
    config = row.arrange?.(root, config, id) || config;
    const res = createWorktree(root, config, id, row.opts?.(root) ?? {});
    if (!res.created) throw new Error(`${row.name}: not created`);
    assert.equal(res.ok, true, row.name);
    assert.equal(setupRuns(root), 1, `${row.name}: setup ran`);
    assert.equal(res.seed?.reason, 'no-seed', row.name);
    assert.equal(res.seed?.refreshSkipped, row.skip, row.name);
    assert.equal(res.seed?.refreshed, undefined, row.name);
    assert.deepEqual(keyDirs(), [], `${row.name}: no key dir`);
    fs.rmSync(cache, { recursive: true, force: true });
  }

  // An eval clone is never seeded: no seed key, nothing under the seed root.
  const root = newRepo();
  const config = seedConfig();
  const { res } = create(root, config, 'eval clone', { isolate: true });
  assert.equal(res.ok, true);
  assert.equal('seed' in res, false);
  assert.equal(fs.existsSync(path.join(cache, 'seeds')), false);
});
