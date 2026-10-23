// Worktree seeds (`worktrees.seed`): a private, Forge-owned copy of a fresh base worktree's untracked
// dependency paths and caches, which new job worktrees clone copy-on-write while their key files match.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { seedPathProblem } from '#core/config/validate.ts';
import { tryLock } from '#core/os/lock.ts';
import { run } from '#core/os/process.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import type { Config } from '#core/types.ts';

/** Why a create did not use the seed. */
export type SeedMiss = 'no-key' | 'cache-unusable' | 'no-seed' | 'exists' | 'clone-failed' | 'check-failed';
/** Why a create that ran setup did not refresh the seed. */
export type SeedRefreshSkip = 'not-base' | 'no-key' | 'cache-unusable' | 'busy' | 'key-changed' | 'missing-path' | 'symlink-out' | 'exists' | 'failed';

export interface SeedCommandLog {
  cmd: string;
  ok: boolean;
  tail: string;
}

/** `forge worktree create`'s `seed`, present only when seeding applies (docs/CONFIG.md › Worktree seed). */
export interface WorktreeSeedResult {
  used: boolean;
  /** The seed key's first 16 hex characters; null when a key file is missing. */
  key: string | null;
  method?: 'clone' | 'copy';
  reason?: SeedMiss;
  /** `seed.setup`, run after a clone. */
  checks?: SeedCommandLog[];
  warm?: SeedCommandLog[];
  refreshed?: boolean;
  refreshSkipped?: SeedRefreshSkip;
  durationMs: number;
}

/** What cloneTree runs and copies with, so tests can fail either step. */
export interface SeedOps {
  platform: NodeJS.Platform;
  run(cmd: string, args: string[]): { ok: boolean };
  copy(src: string, dst: string): void;
}

export const SYSTEM_SEED_OPS: SeedOps = {
  platform: process.platform,
  run: (cmd, args) => ({ ok: run(cmd, args, { allowFail: true }).ok }),
  // Symlinks are copied as written, never resolved, so a clone never reaches outside its tree.
  copy: (src, dst) => fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false }),
};

const KEY_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SEED_JSON = 'seed.json';
const SEED_JSON_MAX = 64 * 1024;
/** Key dirs kept per repo: the newest two, so a base branch that flips between two lockfiles stays warm. */
const KEEP = 2;
/** A staging dir this old belongs to a refresh that died. */
const STALE_TMP_MS = 60 * 60 * 1000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

const sha256 = (v: string | Buffer): string => crypto.createHash('sha256').update(v).digest('hex');

/**
 * `<cache>/seeds/<repoId>/`, created when missing, or null when any level is not private. The seed
 * holds code later unsandboxed runs execute, so it gets the start-up cache's rules (bin/forge), and
 * the two levels below must also be real directories this user owns that nobody else can write.
 */
export function seedRoot(root: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const cache = cacheRoot(env);
  if (!cache) return null;
  try {
    const seeds = path.join(cache, 'seeds');
    const dir = path.join(seeds, sha256(fs.realpathSync(root)).slice(0, 16));
    return privateDir(seeds) && privateDir(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * bin/forge's cacheRoot(), copied rather than shared: bin/forge runs before the type stripper loads,
 * so it can't import lib/. Keep the two in step, the containment check on FORGE_CACHE_DIR included.
 */
function cacheRoot(env: NodeJS.ProcessEnv): string | null {
  try {
    let root = path.join(PLUGIN_ROOT, '.cache');
    if (env.FORGE_CACHE_DIR) {
      const wanted = path.resolve(env.FORGE_CACHE_DIR);
      root = path.join(fs.realpathSync(path.dirname(wanted)), path.basename(wanted));
      const rel = path.relative(fs.realpathSync(PLUGIN_ROOT), root);
      if (!rel || path.isAbsolute(rel) || rel.split(path.sep)[0] === '..') return null;
    }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const uid = process.getuid?.();
    if (uid !== undefined) {
      const self = fs.lstatSync(root);
      if (!self.isDirectory() || self.uid !== uid || self.mode & 0o022) return null;
      const parent = fs.statSync(path.dirname(root));
      if (parent.uid !== uid && parent.uid !== 0) return null;
      if (parent.mode & 0o022 && !(parent.mode & 0o1000)) return null;
    }
    try {
      fs.writeFileSync(path.join(root, '.gitignore'), '*\n', { flag: 'wx' });
    } catch {}
    return root;
  } catch {
    return null;
  }
}

/** Whether `p` is (or now is, made 0700) a real directory this user owns that group and others can't write. */
function privateDir(p: string): boolean {
  try {
    fs.mkdirSync(p, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  try {
    const st = fs.lstatSync(p);
    const uid = process.getuid?.();
    return st.isDirectory() && (uid === undefined || (st.uid === uid && !(st.mode & 0o022)));
  } catch {
    return false;
  }
}

/**
 * The seed key: sha256 over the key files' contents, `worktrees.setup`, the seed paths and the
 * platform, arch and Node ABI (native modules built for one never fit another). Null when a key
 * file is missing or not a regular file, or a configured path is unusable.
 */
export function seedKey(dir: string, config: Config): string | null {
  const seed = config.worktrees.seed;
  const usable = (l: unknown): l is string[] => Array.isArray(l) && l.every((p) => seedPathProblem(p, 'path') === null);
  if (!usable(seed?.paths) || !usable(seed?.key) || !seed.key.length) return null;
  const files: [string, string][] = [];
  for (const k of seed.key) {
    const body = readRegular(dir, k);
    if (body === null) return null;
    files.push([k, sha256(body)]);
  }
  const { platform, arch } = process;
  return sha256(JSON.stringify({ v: 1, files, setup: config.worktrees.setup ?? [], paths: seed.paths, platform, arch, modules: process.versions.modules }));
}

/** A regular file's bytes, read without following a link or blocking on a FIFO; null for anything else. */
function readRegular(dir: string, rel: string): Buffer | null {
  if (!linkFreeParents(dir, rel)) return null;
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(dir, rel), fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Whether any seed path is already in the worktree `dir`, or sits behind a link or a file. Called
 * before setup runs, so what it finds came with the checkout or from `worktrees.copy` (which a
 * sandboxed agent can steer through the main checkout), never from a build Forge ran.
 */
export function seedPathsPresent(dir: string, paths: readonly string[]): boolean {
  return paths.some((p) => !linkFreeParents(dir, p) || lexists(path.join(dir, p)));
}

/** Whether every existing ancestor of `rel` under `dir` is a real directory, so writing or deleting `rel` stays inside `dir`. */
function linkFreeParents(dir: string, rel: string): boolean {
  const segs = rel.split('/');
  for (let i = 1; i < segs.length; i++) {
    try {
      if (!fs.lstatSync(path.join(dir, ...segs.slice(0, i))).isDirectory()) return false;
    } catch {
      return true;
    }
  }
  return true;
}

function lexists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Copies `src` to the missing `dst`: copy-on-write first (`cp -c` on darwin, `--reflink=auto` on
 * linux, argv after `--` with no shell), then a plain recursive copy, then nothing. A failed try
 * leaves no `dst`. Never a hardlink or symlink, so writes to `dst` never reach `src`.
 */
export function cloneTree(src: string, dst: string, ops: SeedOps = SYSTEM_SEED_OPS): 'clone' | 'copy' | null {
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
  } catch {
    return null;
  }
  const args = ops.platform === 'darwin' ? ['-c', '-a', '--', src, dst] : ops.platform === 'linux' ? ['-a', '--reflink=auto', '--', src, dst] : null;
  if (args) {
    if (ops.run('cp', args).ok) return 'clone';
    fs.rmSync(dst, { recursive: true, force: true });
  }
  try {
    ops.copy(src, dst);
    return 'copy';
  } catch {
    fs.rmSync(dst, { recursive: true, force: true });
    return null;
  }
}

interface SeedMeta {
  v: 1;
  key: string;
  paths: string[];
  commit: string;
  createdAt: string;
}

/** A key dir's seed.json when it parses and names this dir's key, else null. */
function readSeedJson(keyDir: string): SeedMeta | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(keyDir, SEED_JSON), fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > SEED_JSON_MAX) return null;
    const m = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!m || m.v !== 1 || m.key !== path.basename(keyDir) || !Array.isArray(m.paths) || m.paths.some((p: unknown) => typeof p !== 'string')) return null;
    return typeof m.createdAt === 'string' && Number.isFinite(Date.parse(m.createdAt)) ? m : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Clones the seed for `key` into the worktree `dir`: `no-seed` without a complete one for these
 * paths, `exists` when any path is already there, `clone-failed` (with every path cloned so far
 * removed) when one could not be copied at all.
 */
export function applySeed(seedDir: string, key: string, dir: string, paths: readonly string[], ops: SeedOps = SYSTEM_SEED_OPS): { used: boolean; method?: 'clone' | 'copy'; reason?: 'no-seed' | 'exists' | 'clone-failed' } {
  const keyDir = path.join(seedDir, key);
  const meta = KEY_RE.test(key) && isRealDir(keyDir) ? readSeedJson(keyDir) : null;
  if (!meta || JSON.stringify(meta.paths) !== JSON.stringify(paths) || !paths.every((p) => lexists(path.join(keyDir, p)))) return { used: false, reason: 'no-seed' };
  if (seedPathsPresent(dir, paths)) return { used: false, reason: 'exists' };
  const done: string[] = [];
  let copied = false;
  for (const p of paths) {
    const how = cloneTree(path.join(keyDir, p), path.join(dir, p), ops);
    if (!how) {
      removeSeeded(dir, done);
      return { used: false, reason: 'clone-failed' };
    }
    done.push(p);
    if (how === 'copy') copied = true;
  }
  return { used: true, method: copied ? 'copy' : 'clone' };
}

/** Deletes the seed paths from the worktree `dir`, never through a link out of it. */
export function removeSeeded(dir: string, paths: readonly string[]): void {
  for (const p of paths) {
    if (seedPathProblem(p, 'path') || !linkFreeParents(dir, p)) continue;
    fs.rmSync(path.join(dir, p), { recursive: true, force: true });
  }
}

/** The seed lock for refreshes and deletes, or null while another process holds it. */
export function lockSeed(seedDir: string): { release: () => void } | null {
  const lock = tryLock(path.join(seedDir, '.lock'));
  return 'release' in lock ? lock : null;
}

/** Deletes the key dir under the seed lock, best effort: a busy lock leaves it. */
export function dropSeed(seedDir: string, key: string): boolean {
  if (!KEY_RE.test(key)) return false;
  const lock = lockSeed(seedDir);
  if (!lock) return false;
  try {
    fs.rmSync(path.join(seedDir, key), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  } finally {
    lock.release();
  }
}

/** Whether anything, valid or not, already sits at `key`'s dir: a refresh would end `exists`. */
export function seedTaken(seedDir: string, key: string): boolean {
  return lexists(path.join(seedDir, key));
}

/**
 * Writes the seed for `key` from the worktree `dir`, whose HEAD is `commit`. The caller holds the
 * seed lock. Paths are staged beside the seed, any symlink that is absolute, climbs after a descent
 * or leaves the staging dir refuses the refresh, and seed.json is written last before one rename
 * makes the seed visible.
 */
export function refreshSeed(seedDir: string, key: string, dir: string, paths: readonly string[], commit: string, ops: SeedOps = SYSTEM_SEED_OPS): { refreshed: boolean; reason?: SeedRefreshSkip } {
  if (!KEY_RE.test(key) || !COMMIT_RE.test(commit)) return { refreshed: false, reason: 'failed' };
  const target = path.join(seedDir, key);
  if (lexists(target)) return { refreshed: false, reason: 'exists' };
  const stage = path.join(seedDir, `.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.mkdirSync(stage, { mode: 0o700 });
    for (const p of paths) {
      if (seedPathProblem(p, 'path') || !linkFreeParents(dir, p) || !lexists(path.join(dir, p))) return { refreshed: false, reason: 'missing-path' };
      if (!cloneTree(path.join(dir, p), path.join(stage, p), ops)) return { refreshed: false, reason: 'failed' };
    }
    if (linkLeaves(stage)) return { refreshed: false, reason: 'symlink-out' };
    const meta: SeedMeta = { v: 1, key, paths: [...paths], commit, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(stage, SEED_JSON), `${JSON.stringify(meta)}\n`, { mode: 0o600, flag: 'wx' });
    if (lexists(target)) return { refreshed: false, reason: 'exists' };
    fs.renameSync(stage, target);
    prune(seedDir);
    return { refreshed: true };
  } catch {
    return { refreshed: false, reason: 'failed' };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Whether any symlink under `stage` is absolute, climbs with `..` after a descent, or resolves,
 * lexically, outside it. The first two matter because the kernel follows a link before the `..`
 * after it: `x -> y/../../outside` beside `y -> ..` looks like `<stage>/outside` to path.resolve but
 * physically leaves. With every `..` leading, each climbs a real directory this walk has seen
 * (it never enters a link), so the lexical check below is the physical one.
 */
function linkLeaves(stage: string): boolean {
  const dirs = [stage];
  while (dirs.length) {
    const d = dirs.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) {
        const target = fs.readlinkSync(p);
        if (path.isAbsolute(target) || climbsAfterDescent(target)) return true;
        const rel = path.relative(stage, path.resolve(d, target));
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return true;
      } else if (e.isDirectory()) dirs.push(p);
    }
  }
  return false;
}

/** Whether `target` has a `..` after a segment that is not `..`; empty and `.` segments climb nowhere. Both slashes split, so it only over-refuses. */
function climbsAfterDescent(target: string): boolean {
  let descended = false;
  for (const seg of target.split(/[\\/]/)) {
    if (seg === '' || seg === '.') continue;
    if (seg !== '..') descended = true;
    else if (descended) return true;
  }
  return false;
}

/** Keeps the newest KEEP key dirs by createdAt, and deletes invalid key dirs and staging dirs older than an hour. */
function prune(seedDir: string): void {
  const keep: { name: string; at: number }[] = [];
  for (const name of fs.readdirSync(seedDir)) {
    const p = path.join(seedDir, name);
    // The lock and its graves are lock.ts's to manage.
    if (name === '.lock' || name.startsWith('.lock.')) continue;
    try {
      if (name.startsWith('.tmp-')) {
        if (Date.now() - fs.lstatSync(p).mtimeMs > STALE_TMP_MS) fs.rmSync(p, { recursive: true, force: true });
        continue;
      }
      const meta = KEY_RE.test(name) && isRealDir(p) ? readSeedJson(p) : null;
      if (meta) keep.push({ name, at: Date.parse(meta.createdAt) });
      else fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
  keep.sort((a, b) => b.at - a.at || a.name.localeCompare(b.name));
  for (const k of keep.slice(KEEP)) fs.rmSync(path.join(seedDir, k.name), { recursive: true, force: true });
}
