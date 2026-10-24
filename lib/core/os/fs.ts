// Small file helpers: JSON and text reads with fallbacks, atomic and owner-only writes, and the check
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

export function writeJsonAtomic(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n');
}

/** writeJsonAtomic for a file only its owner may read (mode 0600 from creation, never wider): credentials. */
export function writeJsonPrivate(file: string, data: any): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export function writeTextAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, text);
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
