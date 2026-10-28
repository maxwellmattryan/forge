// The mkdir lock across concurrent Forge sessions on one machine, broken only when its holder is
// provably dead.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeError } from '../errors.ts';
import { processStartMs, sleepSync, START_SLACK_MS } from './process.ts';
import { writeJsonAtomic } from './fs.ts';

/**
 * Whether `pid` is provably gone: its group and the pid both answer ESRCH. Stricter than pidAlive,
 * for breaking locks: EPERM means a process exists that this one may not signal (another uid, or
 * one outside this sandbox), so it is never proof of death.
 */
function pidGone(pid: number): boolean {
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 0);
      return false;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return false;
    }
  }
  return true;
}

/** This process's start, taken once at load so a test that fakes Date.now later can't move it. */
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

/** What a lock's holder writes into `<lockDir>/holder.json` straight after its mkdir. */
export interface LockHolder {
  v: 1;
  pid: number;
  startedAt: string;
  host: string;
  token: string;
}

/** A lock dir with no parseable holder.json (an older Forge's, or one caught between mkdir and write) is broken only past this mtime age. */
const LEGACY_LOCK_MS = 60_000;
/** A waiter asks ps about one holder token at most this often. */
const PROBE_EVERY_MS = 1000;
const HOLDER_MAX_BYTES = 4096;
const NOFOLLOW_FLAG = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK_FLAG = fs.constants.O_NONBLOCK ?? 0;

/**
 * The holder a lock dir names, or null for anything else: missing, oversized, not a regular file,
 * or not the v1 shape. The dir is writable by whoever can write its parent (a job dir's agents,
 * say), so a planted file is read without following links or blocking, and garbage only ever gets
 * the slow legacy rule.
 */
export function readLockHolder(lockDir: string): LockHolder | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(path.join(lockDir, 'holder.json'), fs.constants.O_RDONLY | NOFOLLOW_FLAG | NONBLOCK_FLAG);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > HOLDER_MAX_BYTES) return null;
    const h = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!h || typeof h !== 'object' || h.v !== 1) return null;
    if (!Number.isInteger(h.pid) || h.pid <= 0 || typeof h.host !== 'string' || typeof h.token !== 'string' || !h.token || h.token.length > 100) return null;
    if (typeof h.startedAt !== 'string' || !Number.isFinite(Date.parse(h.startedAt))) return null;
    return { v: 1, pid: h.pid, startedAt: h.startedAt, host: h.host, token: h.token };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** One waiter's memory across its polls: when it last asked ps about each holder token, and the answer. */
interface LockWait {
  probes: Map<string, { at: number; dead: boolean }>;
  holder: LockHolder | null;
}

const newWait = (): LockWait => ({ probes: new Map(), holder: null });

/**
 * Whether a parseable holder is provably gone: on this host, and its pid is gone (pidGone) or (ps
 * permitting) belongs to a process that started at another time, so the pid was reused. Another
 * host, a matching start time, or a ps that fails all count as alive: age never does.
 */
function holderDead(h: LockHolder, w: LockWait): boolean {
  if (h.host !== os.hostname()) return false;
  if (pidGone(h.pid)) return true;
  if (process.platform === 'win32') return false;
  const seen = w.probes.get(h.token);
  if (seen && Math.abs(Date.now() - seen.at) < PROBE_EVERY_MS) return seen.dead;
  const started = processStartMs(h.pid);
  const dead = started !== null && Math.abs(started - Date.parse(h.startedAt)) > START_SLACK_MS;
  w.probes.set(h.token, { at: Date.now(), dead });
  return dead;
}

/** Renames a lock dir to a fresh grave beside it and removes that, so no waiter ever sees a half-removed lock. */
function bury(lockDir: string): boolean {
  const grave = `${lockDir}.dead-${crypto.randomUUID().slice(0, 8)}`;
  try {
    fs.renameSync(lockDir, grave);
  } catch {
    return false;
  }
  fs.rmSync(grave, { recursive: true, force: true });
  return true;
}

/**
 * Breaks a lock judged dead (holder `token`, or null for a legacy holder-less dir whose stat was
 * `judged`), one breaker at a time: the `breaking` marker excludes the others, and the re-read
 * proves the dir is still the one judged. A breaker that dies before the rename leaves the marker,
 * which wedges the lock rather than ever admitting a second holder. Returns whether the lock is gone.
 */
function breakLock(lockDir: string, token: string | null, judged?: fs.Stats): boolean {
  const marker = path.join(lockDir, 'breaking');
  try {
    fs.mkdirSync(marker);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT';
  }
  const now = readLockHolder(lockDir);
  // A legacy dir must be the very dir judged (a new holder's, made since, has another inode or birth
  // time even before it writes anything) and hold nothing but the marker and an unreadable holder.json.
  const same = token === null ? now === null && sameDir(lockDir, judged) && onlyMarker(lockDir) : now?.token === token;
  if (!same) {
    try {
      fs.rmdirSync(marker);
    } catch {}
    return false;
  }
  return bury(lockDir);
}

function sameDir(lockDir: string, judged: fs.Stats | undefined): boolean {
  if (!judged) return false;
  try {
    const st = fs.lstatSync(lockDir);
    return st.isDirectory() && st.dev === judged.dev && st.ino === judged.ino && st.birthtimeMs === judged.birthtimeMs;
  } catch {
    return false;
  }
}

function onlyMarker(lockDir: string): boolean {
  try {
    return fs.readdirSync(lockDir).every((n) => n === 'breaking' || n === 'holder.json');
  } catch {
    return false;
  }
}

/**
 * One try at the lock: mkdir, and on EEXIST at most one death-proof break followed by one more
 * mkdir. Returns the new holder's token, or null while someone else holds it.
 */
function attemptLock(lockDir: string, w: LockWait): string | null {
  for (let tries = 0; tries < 2; tries++) {
    try {
      fs.mkdirSync(lockDir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (tries > 0) return null;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(lockDir);
      } catch {
        continue;
      }
      // Not a directory (a planted symlink, say): wedged, never broken through into its target.
      if (!st.isDirectory()) return null;
      const holder = readLockHolder(lockDir);
      w.holder = holder;
      if (holder) {
        if (!holderDead(holder, w) || !breakLock(lockDir, holder.token)) return null;
      } else if (Date.now() - st.mtimeMs <= LEGACY_LOCK_MS || !breakLock(lockDir, null, st)) {
        // The only place a lock's age counts.
        return null;
      }
      continue;
    }
    const token = crypto.randomUUID();
    try {
      writeJsonAtomic(path.join(lockDir, 'holder.json'), { v: 1, pid: process.pid, startedAt: PROCESS_STARTED_AT, host: os.hostname(), token } satisfies LockHolder);
    } catch (e) {
      fs.rmSync(lockDir, { recursive: true, force: true });
      throw e;
    }
    return token;
  }
  return null;
}

/** Removes the lock only while it is still this holder's: a dir another holder now owns is left alone. */
function releaseLock(lockDir: string, token: string): void {
  if (readLockHolder(lockDir)?.token === token) bury(lockDir);
}

function lockTimeout(lockDir: string, w: LockWait): ForgeError {
  return new ForgeError(`timed out waiting for lock ${lockDir} (${w.holder ? `held by pid ${w.holder.pid}` : 'holder unknown'})`);
}

/**
 * mkdir is atomic on every filesystem we care about, which makes it a portable lock primitive
 * across concurrent Forge sessions on one machine. A lock is never broken for its age, only when
 * its holder is provably dead (holderDead), so a long section keeps it and needs no refresh.
 */
export function withLock<T>(lockDir: string, fn: () => T, opts: { timeoutMs?: number } = {}): T {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const start = Date.now();
  const w = newWait();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let token: string | null;
  while ((token = attemptLock(lockDir, w)) === null) {
    if (Date.now() - start > timeoutMs) throw lockTimeout(lockDir, w);
    sleepSync(50);
  }
  try {
    return fn();
  } finally {
    releaseLock(lockDir, token);
  }
}

/**
 * withLock for async work: the same mkdir lock, waiting without blocking the event loop. An aborted `signal`
 * stops the wait (a ForgeError, nothing held); once the lock is held it is `fn`'s to watch.
 */
export async function withLockAsync<T>(lockDir: string, fn: () => Promise<T>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const start = Date.now();
  const w = newWait();
  const stopped = () => new ForgeError(`stopped waiting for lock ${lockDir}`);
  if (opts.signal?.aborted) throw stopped();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  let token: string | null;
  while ((token = attemptLock(lockDir, w)) === null) {
    if (Date.now() - start > timeoutMs) throw lockTimeout(lockDir, w);
    await new Promise((r) => setTimeout(r, 50));
    if (opts.signal?.aborted) throw stopped();
  }
  try {
    return await fn();
  } finally {
    releaseLock(lockDir, token);
  }
}

/**
 * Whether a live holder has the lock, judged without touching it: a probe that must not hold the
 * lock even for an instant (another start would then be refused). A holder-less dir counts as held
 * while it is young, and a lock path that is not a directory as held, as attemptLock treats them.
 */
export function lockHeld(lockDir: string): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(lockDir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return true;
  const holder = readLockHolder(lockDir);
  if (holder) return !holderDead(holder, newWait());
  return Date.now() - st.mtimeMs <= LEGACY_LOCK_MS;
}

/**
 * One attempt at a lock to hold for a long time (`forge dash`'s daemon lock), with the death-proof
 * break applied once. The holder is null-valued when the dir names none (a legacy or mid-write lock).
 */
export function tryLock(lockDir: string): { release: () => void } | { holder: { pid: number | null; host: string | null } } {
  const w = newWait();
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const token = attemptLock(lockDir, w);
  if (token === null) {
    // A holder that won the mkdir a moment ago may not have written holder.json yet: give it a beat, so the refusal can name it.
    for (let i = 0; i < 20 && !w.holder; i++) {
      sleepSync(10);
      w.holder = readLockHolder(lockDir);
    }
    return { holder: { pid: w.holder?.pid ?? null, host: w.holder?.host ?? null } };
  }
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseLock(lockDir, token);
    },
  };
}
