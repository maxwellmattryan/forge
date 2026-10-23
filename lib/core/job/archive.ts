// The read side of retention: archive records in `.forge/archive/<id>.json`, which keep a
// finished job's job.json, events and a summary after its directory is deleted. Stats, audit,
// retro and the dependency check read them here. Imports only jobs/schema/paths/util, because
// lib/engine/pipeline/moves/deps.ts imports this module and its header forbids anything that could form a cycle.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir } from './store.ts';
import { paths } from '../paths.ts';
import { ARCHIVE_SCHEMA_VERSION, normalizeEvent, normalizeJob } from './schema.ts';
import type { ArchivedJob, JobEvent, RetentionTrigger } from '../types.ts';

/** A record larger than this is not one Forge wrote; it is skipped rather than read. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const TRIGGERS: readonly RetentionTrigger[] = ['cli', 'prune', 'policy'];
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

export function archiveDir(root: string): string {
  return paths(root).archive;
}

/** The archive dir when it is a real directory; a symlink planted there is never followed. */
function realArchiveDir(root: string): string | null {
  const dir = archiveDir(root);
  try {
    return fs.lstatSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** Whether `id` has a live job.json: the live job wins over its archive record. */
export function hasLiveJob(root: string, id: string): boolean {
  try {
    return fs.existsSync(path.join(jobDir(root, id), 'job.json'));
  } catch {
    return false;
  }
}

/**
 * One archive record, or null for a bad id, a missing, oversized, non-regular or unparsable file,
 * a record from a newer Forge, or one whose job is. Read through one descriptor opened without
 * following links or blocking on a FIFO.
 */
export function readArchived(root: string, id: string): ArchivedJob | null {
  try {
    jobDir(root, id);
  } catch {
    return null;
  }
  const dir = realArchiveDir(root);
  if (!dir) return null;
  let fd: number | undefined;
  let raw: any;
  try {
    fd = fs.openSync(path.join(dir, `${id}.json`), fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_ARCHIVE_BYTES) return null;
    raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!Number.isInteger(raw.archiveVersion) || raw.archiveVersion < 1 || raw.archiveVersion > ARCHIVE_SCHEMA_VERSION) return null;
  if (raw.id !== id || !raw.job || typeof raw.job !== 'object' || raw.job.id !== id) return null;
  const job = normalizeJob(raw.job);
  if (job._unsupported) return null;
  const events = (Array.isArray(raw.events) ? raw.events : []).map((e: unknown) => normalizeEvent(e)).filter((e: JobEvent | null): e is JobEvent => e !== null);
  const summary = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  return {
    id,
    archivedAt: typeof raw.archivedAt === 'string' ? raw.archivedAt : '',
    trigger: TRIGGERS.includes(raw.trigger) ? raw.trigger : 'cli',
    job,
    events,
    summary: { ...summary, findings: summary.findings ?? emptyFindings() },
  };
}

/** The findings of a record whose summary lost them: nothing raised. */
function emptyFindings(): ArchivedJob['summary']['findings'] {
  return { rounds: [], byLens: {}, totals: { raised: 0, fixed: 0, disputed: 0, recurring: 0 }, recurring: [], disputed: [] };
}

/** Every readable archive record whose id has no live job, sorted by id. */
export function listArchived(root: string): ArchivedJob[] {
  const dir = realArchiveDir(root);
  if (!dir) return [];
  let names: fs.Dirent[];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ArchivedJob[] = [];
  for (const e of names) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const id = e.name.slice(0, -5);
    if (hasLiveJob(root, id)) continue;
    const rec = readArchived(root, id);
    if (rec) out.push(rec);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
