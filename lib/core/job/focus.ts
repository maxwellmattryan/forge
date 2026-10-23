// Focus: which job the human at the keyboard is QA-ing. A pointer in the root repo's
// .forge/runtime/focus.json, never a checkout and never a process change. jobs.ts imports this
// module (setJob clears a finished job's focus), so it must never import jobs.ts; the write path
// that loads jobs and logs events is lib/engine/workspace/focus-actions.ts.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../paths.ts';
import { validJobId } from './requests.ts';
import type { FocusFact, Job } from '../types.ts';
import { writeJsonAtomic } from '../os/fs.ts';
import { withLock } from '../os/lock.ts';
import { now } from '../utils.ts';

const MAX_RECORD = 64 * 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export interface FocusRecord {
  job: string;
  since: string;
}

export const focusFile = (root: string): string => path.join(paths(root).runtime, 'focus.json');
const focusLock = (root: string): string => path.join(paths(root).locks, 'focus');

/**
 * A small JSON object read through one descriptor that follows no symlink and never blocks on a
 * FIFO, after fstat confirms a regular file under the cap: the runtime dir and job dirs are
 * agent-writable, and the dashboard reads these on every poll. Null on any failure.
 */
export function readSmallJson(file: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    // Windows has no O_NOFOLLOW, so lstat refuses a link or FIFO before the open, and the
    // descriptor must still be that same file (no swap in between).
    const link = fs.lstatSync(file);
    if (!link.isFile()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD || st.dev !== link.dev || st.ino !== link.ino) return null;
    const v = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** The stored record, or null when there is none or it is unreadable or names no valid job id. */
export function readFocusRecord(root: string): FocusRecord | null {
  const v = readSmallJson(focusFile(root));
  if (!v || !validJobId(v.job)) return null;
  return { job: v.job, since: typeof v.since === 'string' ? v.since : '' };
}

// The two terminal states, inline because importing isActive from jobs.ts would make a cycle.
const active = (job: Pick<Job, 'state'>): boolean => job.state !== 'done' && job.state !== 'cancelled';

/** What `forge focus` and /api/state report: null when the job is missing or no longer active. */
export function resolveFocus(record: FocusRecord | null, lookup: (id: string) => Pick<Job, 'id' | 'title' | 'state'> | null): FocusFact | null {
  if (!record) return null;
  const job = lookup(record.job);
  if (!job || !active(job)) return null;
  return { id: job.id, title: job.title, since: record.since };
}

/**
 * The locked read-modify-write: `id` focuses that job, null removes the record. `previous` is the
 * job the record named before, even a stale one, so the caller can log its unfocus.
 */
export function setFocus(root: string, id: string | null): { previous: string | null; changed: boolean } {
  return withLock(focusLock(root), () => {
    const previous = readFocusRecord(root)?.job ?? null;
    if (previous === id) return { previous, changed: false };
    if (id === null) fs.rmSync(focusFile(root), { force: true });
    else writeJsonAtomic(focusFile(root), { v: 1, job: id, since: now() });
    return { previous, changed: true };
  });
}

/** Removes the record only when it names `id`: a finished job lets go of focus, never another's. */
export function clearFocusIf(root: string, id: string): boolean {
  // No lock dir is created for a repo that has never focused anything.
  if (!fs.existsSync(focusFile(root))) return false;
  return withLock(focusLock(root), () => {
    if (readFocusRecord(root)?.job !== id) return false;
    fs.rmSync(focusFile(root), { force: true });
    return true;
  });
}
