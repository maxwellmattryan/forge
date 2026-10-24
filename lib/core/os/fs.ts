// Small file helpers: JSON and text reads with fallbacks, atomic and owner-only writes, confined
// writes that reach a directory only through real directories (never a planted link), and the check
// that a path stays inside the checkout.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ForgeError } from '../errors.ts';

export function readJson(file: string, fallback?: any): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && (e as any).code === 'ENOENT') return fallback;
    throw new ForgeError(`cannot read ${file}: ${(e as Error).message}`);
  }
}

// O_NOFOLLOW is missing on Windows, where `?? 0` leaves O_EXCL alone to refuse a planted entry.
const TEMP_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
const randomSuffix = (): string => crypto.randomBytes(8).toString('hex');

/**
 * Write-then-rename so readers (the dashboard, other sessions) never see a half-written file. The
 * attacker is an agent that can write the target's directory and plants a file or link where Forge
 * will write: the temp name `${file}.<16 hex>.tmp` is random and opened exclusive and no-follow, so
 * an entry at a guessed name fails the open instead of redirecting the write (one retry with a fresh
 * name, then the error), and the rename replaces a link at `file` itself instead of following it.
 * With `mode` the file gets exactly that mode, set on the open descriptor so the umask never
 * applies; without it, the mode a plain writeFileSync gives. Never creates the parent directory, and
 * removes the temp file when anything after its creation fails.
 */
export function writeAtomic(file: string, data: string | Uint8Array, opts: { mode?: number; rand?: () => string } = {}): void {
  const rand = opts.rand ?? randomSuffix;
  let tmp = `${file}.${rand()}.tmp`;
  let fd: number;
  try {
    fd = fs.openSync(tmp, TEMP_FLAGS, opts.mode ?? 0o666);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    tmp = `${file}.${rand()}.tmp`;
    fd = fs.openSync(tmp, TEMP_FLAGS, opts.mode ?? 0o666);
  }
  try {
    try {
      fs.writeFileSync(fd, data);
      if (opts.mode !== undefined) fs.fchmodSync(fd, opts.mode);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The real path of `dir` once every component from `root` down to it is a real directory; missing
 * ones are created a level at a time. The attacker can write inside `root` (a job folder) and swaps
 * a component for a link, a junction or a file so that a later write lands where it chooses: each
 * component is lstat'd right after its mkdir, so nothing is ever created through a link (Node reports
 * a junction as one). `root` itself is trusted and resolved, so a checkout under a symlinked tmp still
 * works. A swap between this check and the open is the residual: Node has no openat.
 */
export function confinedDir(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new ForgeError(`${dir} is outside ${root}`);
  let cur: string;
  try {
    cur = fs.realpathSync.native(root);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ForgeError(`${root} does not exist`);
    throw e;
  }
  const segs = rel.split(path.sep).filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    try {
      fs.mkdirSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (!fs.lstatSync(cur).isDirectory())
      throw new ForgeError(`${segs.slice(0, i + 1).join('/')} in ${root} is not a real directory (a link or a file); remove it and run the command again`);
  }
  return cur;
}

/** Where to write `file`: after `mkdir -p` of its parent, or with `root` in its confined real parent. */
function writeTarget(file: string, root: string | undefined): string {
  if (root !== undefined) return path.join(confinedDir(root, path.dirname(file)), path.basename(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

/** With `root`, the parent is reached only through real directories below it (confinedDir). */
export function writeJsonAtomic(file: string, data: any, opts: { root?: string } = {}): void {
  writeAtomic(writeTarget(file, opts.root), JSON.stringify(data, null, 2) + '\n');
}

/** writeJsonAtomic for a file only its owner may read (mode 0600 from creation, never wider): credentials. */
export function writeJsonPrivate(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/** With `root`, the parent is reached only through real directories below it (confinedDir). */
export function writeTextAtomic(file: string, text: string, opts: { root?: string } = {}): void {
  writeAtomic(writeTarget(file, opts.root), text);
}

export function readText(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/**
 * A component's path becomes the cwd of its shell commands (path.join(worktree, path)), so it must
 * stay inside the checkout: no absolute path, drive letter or `..` segment on either separator.
 * Here rather than in components.ts so config-sinks.ts can use it without a cycle.
 */
export function isInsidePath(p: unknown): p is string {
  if (typeof p !== 'string' || !p.trim()) return false;
  if (path.isAbsolute(p) || /^[/\\]/.test(p) || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[/\\]/).includes('..');
}
