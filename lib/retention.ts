// Retention: archive finished jobs into compact records, delete stale daemon session logs, and
// apply the human's `retention` policy. Everything here deletes files, so every path is built from
// a validated id or scope, checked with lstat, and never followed through a symlink. The read side
// (archive records) lives in lib/archive.ts so stats, audit, retro and deps need not import this.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { currentActor } from './actor.ts';
import { archiveDir, hasLiveJob } from './archive.ts';
import { RETENTION_DAYS } from './config.ts';
import { daemonsDir, openAppend, readInfo, sessionFiles } from './daemon.ts';
import { jobFindings } from './findings.ts';
import { isActive, jobDir, listJobs, logEvent, ownerStatus, readEvents } from './jobs.ts';
import { paths } from './paths.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, validScope } from './requests.ts';
import { ARCHIVE_SCHEMA_VERSION, normalizeJob } from './schema.ts';
import type { ArchiveRecord, ArchiveResult, Config, EventActor, Job, LoadedJob, PruneResult, RetentionTrigger } from './types.ts';
import { ForgeError, now, withLock } from './util.ts';
import { pidAlive } from './worktree.ts';

export const DAY_MS = 86_400_000;

const NOT_READABLE = 'not a readable job';

/** A refusal: the message names the job, `reason` is the fixed reason string. */
class Refusal extends ForgeError {
  declare reason: string;
  constructor(id: string, reason: string) {
    super(`cannot archive ${id}: ${reason}`, 1);
    this.reason = reason;
  }
}

const lstat = (p: string): fs.Stats | null => {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
};

/**
 * Bytes under `p`, measured with lstat and never through a symlink: the sum of every file's and
 * link's own size. A missing path is 0.
 */
export function dirBytes(p: string): number {
  const st = lstat(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[];
  try {
    names = fs.readdirSync(p);
  } catch {
    return 0;
  }
  for (const n of names) total += dirBytes(path.join(p, n));
  return total;
}

/**
 * The job as stored, or the reason it can't be read: a bad id, a symlinked or non-directory job
 * dir, a missing or unparsable job.json, or one from a newer Forge.
 */
export function readableJob(root: string, id: string): { job: LoadedJob; raw: Job } | string {
  let dir: string;
  try {
    dir = jobDir(root, id);
  } catch {
    return NOT_READABLE;
  }
  const st = lstat(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return NOT_READABLE;
  const fileSt = lstat(path.join(dir, 'job.json'));
  if (!fileSt?.isFile()) return NOT_READABLE;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
    const job = normalizeJob(raw);
    if (job._unsupported || job.id !== id) return NOT_READABLE;
    return { job, raw };
  } catch {
    return NOT_READABLE;
  }
}

/** Whether the daemon session record of scope `id` names a live child or server. */
export function daemonRunning(root: string, id: string): boolean {
  if (!validScope(id)) return false;
  const info = readInfo(sessionFiles(root, id).info);
  return pidAlive(info.pid) || pidAlive(info.serverPid);
}

/** Why `job` can't be archived, or null. `live` is every live job, for the needed-by check. */
export function eligibility(root: string, job: Job, live: Job[]): string | null {
  if (job.state !== 'done' && job.state !== 'cancelled') return `active (${job.stage}/${job.state})`;
  if (job.kind === 'eval') return 'eval jobs stay with their run';
  const owner = ownerStatus(job);
  if (owner.status === 'live') return `owned by live session ${owner.session}`;
  if (daemonRunning(root, job.id)) return 'daemon session running';
  if (job.pr?.state === 'OPEN') return `PR #${job.pr.number} still open`;
  if (job.worktree && lstat(job.worktree)) return `worktree still at ${job.worktree}; run forge worktree remove ${job.id}`;
  for (const other of live) {
    if (other.id === job.id || !isActive(other)) continue;
    const deps = Array.isArray(other.dependsOn) ? other.dependsOn : [];
    const kids = Array.isArray(other.children) ? other.children : [];
    if (deps.includes(job.id) || kids.includes(job.id)) return `needed by ${other.id} (${other.stage}/${other.state})`;
  }
  return null;
}

/**
 * Creates `.forge/archive/` (0700) with a `.gitignore` of `*`, so records are never committed even
 * in a repo whose `.forge/.gitignore` predates retention. A symlink or non-directory there is refused.
 */
export function ensureArchiveDir(root: string): string {
  const dir = archiveDir(root);
  const st = lstat(dir);
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new ForgeError(`${path.relative(root, dir)} is not a directory (a symlink?); refusing to write archives there`, 1);
  if (!st) fs.mkdirSync(dir, { mode: 0o700 });
  try {
    // wx: O_CREAT|O_EXCL, so an existing file or a planted symlink is left alone and never followed.
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx', mode: 0o644 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return dir;
}

/** Write-then-rename through a fresh, exclusively created temp file: a planted link at the target is replaced, never followed. */
function writeExclusiveAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fs.writeSync(fd, text);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/** Appends one line to `.forge/runtime/retention.log`, without following a link or blocking on a FIFO. */
export function appendRetentionLog(root: string, line: Record<string, unknown>): void {
  const file = path.join(paths(root).runtime, 'retention.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = openAppend(file);
  try {
    fs.writeSync(fd, JSON.stringify({ ts: now(), ...line }) + '\n');
  } finally {
    fs.closeSync(fd);
  }
}

export interface ArchiveOpts {
  actor?: EventActor;
  /** Every live job, for the needed-by check; read inside the lock when absent. */
  live?: Job[];
}

/**
 * Archives one finished job: inside the job's lock, re-checks eligibility, logs the `archived`
 * event (so it is inside the record), writes `.forge/archive/<id>.json`, then deletes the job dir.
 * The record lands before the delete, so a crash leaves both copies and readers prefer the live one.
 * Throws a refusal (exit 1) with nothing written when the job is not eligible.
 */
export function archiveJob(root: string, id: string, trigger: RetentionTrigger, opts: ArchiveOpts = {}): ArchiveResult['archived'][number] {
  // Checked before the lock: withLock would create the lock inside a symlinked or missing job dir.
  const pre = readableJob(root, id);
  if (typeof pre === 'string') throw new Refusal(id, pre);
  const dir = jobDir(root, id);
  return withLock(path.join(dir, '.lock'), () => {
    const cur = readableJob(root, id);
    if (typeof cur === 'string') throw new Refusal(id, cur);
    const reason = eligibility(root, cur.job, opts.live ?? listJobs(root));
    if (reason) throw new Refusal(id, reason);
    const adir = ensureArchiveDir(root);
    const bytes = dirBytes(dir);
    // Read before anything is deleted: the review files and build.md go with the job dir.
    const findings = jobFindings(root, id);
    logEvent(root, id, 'archived', { trigger, actor: opts.actor ?? currentActor(root) });
    const job = cur.job;
    const record: ArchiveRecord = {
      archiveVersion: ARCHIVE_SCHEMA_VERSION,
      id,
      archivedAt: now(),
      trigger,
      job: cur.raw,
      events: readEvents(root, id),
      summary: {
        title: job.title,
        kind: job.kind,
        state: job.state,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        rounds: job.round,
        pr: job.pr ? { number: job.pr.number ?? null, state: job.pr.state ?? null, url: job.pr.url ?? null } : null,
        verdicts: job.verdicts,
        usage: { totalTokens: job.usage?.totalTokens ?? 0, estCostUsd: job.usage?.estCostUsd ?? 0 },
        findings,
        bytesFreed: bytes,
      },
    };
    const file = path.join(adir, `${id}.json`);
    writeExclusiveAtomic(file, JSON.stringify(record, null, 2) + '\n');
    fs.rmSync(dir, { recursive: true, force: true });
    appendRetentionLog(root, { type: 'pruned', kind: 'job', id, trigger, bytes });
    return { id, file: path.relative(root, file), bytes };
  });
}

/** A finished job's age in ms (now minus finishedAt, else updatedAt), or null when it has no time. */
function ageMs(job: Job, at: number): number | null {
  const t = Date.parse(String(job.finishedAt ?? job.updatedAt ?? ''));
  return Number.isFinite(t) ? at - t : null;
}

/**
 * Archives every finished job at least `days` old. `refused` lists each finished, old-enough job
 * that was not archived, with its reason. A dry run checks the same rules without the lock and
 * writes nothing.
 */
export function archiveOlder(root: string, days: number, trigger: RetentionTrigger, opts: { dryRun?: boolean; actor?: EventActor; at?: number } = {}): ArchiveResult {
  const at = opts.at ?? Date.now();
  const live = listJobs(root);
  const out: ArchiveResult = { archived: [], refused: [] };
  for (const job of live) {
    if (job.state !== 'done' && job.state !== 'cancelled') continue;
    const age = ageMs(job, at);
    if (age === null || age < days * DAY_MS) continue;
    if (opts.dryRun) {
      const cur = readableJob(root, job.id);
      const reason = typeof cur === 'string' ? cur : eligibility(root, cur.job, live);
      if (reason) out.refused.push({ id: job.id, reason });
      else out.archived.push({ id: job.id, file: path.relative(root, path.join(archiveDir(root), `${job.id}.json`)), bytes: dirBytes(jobDir(root, job.id)) });
      continue;
    }
    try {
      out.archived.push(archiveJob(root, job.id, trigger, { actor: opts.actor, live }));
    } catch (e) {
      out.refused.push({ id: job.id, reason: e instanceof Refusal ? e.reason : (e as Error).message.slice(0, 300) });
    }
  }
  return out;
}

/** One stale log file: its scope, path relative to the repo root, and size. */
export interface StaleLog {
  scope: string;
  file: string;
  bytes: number;
}

const LOG_NAME = /^(.+)\.log(\.1)?$/;

/**
 * The session logs under `.forge/runtime/daemons/` that prune may delete: regular files named
 * exactly `<scope>.log` or `<scope>.log.1` for a valid scope, whose newest mtime is at least `days`
 * old, whose record names no live child or server, and whose scope is not an active live job.
 * Pure listing: nothing is written.
 */
export function staleLogs(root: string, days: number, at = Date.now()): StaleLog[] {
  const dir = daemonsDir(root);
  const st = lstat(dir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const scopes = new Set<string>();
  for (const n of names) {
    const m = LOG_NAME.exec(n);
    if (m && validScope(m[1])) scopes.add(m[1]);
  }
  const active = new Map(listJobs(root).map((j) => [j.id, isActive(j)]));
  const out: StaleLog[] = [];
  for (const scope of [...scopes].sort()) {
    const files = [`${scope}.log`, `${scope}.log.1`]
      .map((name) => ({ name, st: lstat(path.join(dir, name)) }))
      .filter((f): f is { name: string; st: fs.Stats } => Boolean(f.st?.isFile()));
    if (!files.length) continue;
    const newest = Math.max(...files.map((f) => f.st.mtimeMs));
    if (at - newest < days * DAY_MS) continue;
    if (daemonRunning(root, scope)) continue;
    if (scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE && active.get(scope) === true) continue;
    for (const f of files) out.push({ scope, file: path.relative(root, path.join(dir, f.name)), bytes: f.st.size });
  }
  return out;
}

/**
 * Deletes the stale logs, re-checking each is still a regular file, and the session record of a
 * job scope that has no live job dir any more. One retention.log line per deleted log.
 */
function deleteLogs(root: string, logs: StaleLog[], trigger: RetentionTrigger): StaleLog[] {
  const deleted: StaleLog[] = [];
  const scopes = new Set<string>();
  for (const l of logs) {
    const abs = path.join(root, l.file);
    if (!lstat(abs)?.isFile()) continue;
    try {
      fs.unlinkSync(abs);
    } catch {
      continue;
    }
    deleted.push(l);
    scopes.add(l.scope);
    appendRetentionLog(root, { type: 'pruned', kind: 'log', scope: l.scope, file: l.file, bytes: l.bytes, trigger });
  }
  for (const scope of scopes) {
    if (scope === INBOX_SCOPE || scope === OFFICE_SCOPE || hasLiveJob(root, scope)) continue;
    const rec = sessionFiles(root, scope).info;
    if (lstat(rec)?.isFile()) fs.rmSync(rec, { force: true });
  }
  return deleted;
}

/** `forge job prune`: archive old finished jobs, then delete stale session logs. */
export function prune(root: string, days: number, opts: { dryRun?: boolean; trigger?: RetentionTrigger; actor?: EventActor; at?: number } = {}): PruneResult {
  const at = opts.at ?? Date.now();
  const dryRun = Boolean(opts.dryRun);
  const trigger = opts.trigger ?? 'prune';
  const a = archiveOlder(root, days, trigger, { dryRun, actor: opts.actor, at });
  const stale = staleLogs(root, days, at);
  const logs = dryRun ? stale : deleteLogs(root, stale, trigger);
  const jobs = a.archived.map((j) => ({ id: j.id, bytes: j.bytes }));
  const freedBytes = jobs.reduce((n, j) => n + j.bytes, 0) + logs.reduce((n, l) => n + l.bytes, 0);
  return { dryRun, jobs, refused: a.refused, logs, freedBytes };
}

/** A retention.*Days value the policy acts on: an integer in range, else null (validateConfig reports it). */
const days = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= RETENTION_DAYS.min && (v as number) <= RETENTION_DAYS.max ? (v as number) : null);

/**
 * The human's retention policy, applied by `forge sync` and `forge dash` startup. With both day
 * keys null it does nothing and writes nothing (and returns null).
 */
export function applyRetention(root: string, config: Config, trigger: RetentionTrigger = 'policy', opts: { actor?: EventActor; at?: number } = {}): { archived: string[]; logs: string[] } | null {
  const r = config.retention;
  if (!r || (r.jobsDays === null && r.logsDays === null && r.logMaxBytes === null)) return null;
  const out = { archived: [] as string[], logs: [] as string[] };
  const jobsDays = days(r.jobsDays);
  const logsDays = days(r.logsDays);
  if (jobsDays !== null) out.archived = archiveOlder(root, jobsDays, trigger, opts).archived.map((a) => a.id);
  if (logsDays !== null) out.logs = deleteLogs(root, staleLogs(root, logsDays, opts.at), trigger).map((l) => l.file);
  return out;
}
