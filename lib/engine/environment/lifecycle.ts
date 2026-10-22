// A job's environment (docs/CONFIG.md "Backing services" › Lifecycle): its per-job containers and
// volumes, its job databases on shared servers and its background processes. Ensure up starts it,
// stop keeps everything but the running processes, teardown removes it. None of these throws on a
// Docker, psql or record failure: each returns `ok: false` with the error and logs its event, so a
// state change that triggered it is never rolled back. Names reach Docker only through
// lib/engine/environment/backing.ts, which derives them from the job id and config. The dashboard's read model of an
// environment (dev status, services, usage) is lib/engine/environment/status.ts.
import fs from 'node:fs';
import path from 'node:path';
import { backingDown, backingStop, backingUp, isManaged } from './backing.ts';
import type { DockerRunner } from './backing.ts';
import { readFocusRecord, readSmallJson } from '../../core/job/focus.ts';
import { readEnvironments, updateEnvironments } from './record.ts';
import { isActive, jobDir, logEvent } from '../../core/job/store.ts';
import type { BackingDownResult, BackingUpEntry, Config, EnvironmentDownResult, EnvironmentFinishStopResult, EnvironmentRecord, EnvironmentDownTrigger, EnvironmentStopResult, EnvironmentStopTrigger, EnvironmentUpResult, EnvironmentUpTrigger, Job } from '../../core/types.ts';
import { databaseCommands } from '../workspace/job-command.ts';
import { readJson, writeJsonAtomic } from '../../core/os/fs.ts';
import { now } from '../../core/utils.ts';

const message = (e: unknown): string => String((e as Error)?.message ?? e).slice(0, 500);

/** A record write that never throws: a planted directory at the record path is an error, not a crash. */
function record(root: string, fn: Parameters<typeof updateEnvironments>[1]): string | null {
  try {
    updateEnvironments(root, fn);
    return null;
  } catch (e) {
    return `environment record: ${message(e)}`;
  }
}

/** The names runtime.json lists, read without following a link (the job dir is agent-writable). */
function runtimeNames(root: string, id: string): string[] {
  const rt = readSmallJson(path.join(jobDir(root, id), 'runtime.json'));
  return rt ? Object.keys(rt).filter((k) => rt[k] && typeof rt[k] === 'object') : [];
}

export function stopBackground(root: string, id: string): string[] {
  const pidFile = path.join(jobDir(root, id), 'runtime.json');
  const rt = readJson(pidFile, {});
  const stopped: string[] = [];
  for (const [name, info] of Object.entries(rt)) {
    // runtime.json is in the job dir, which the job's agents can write, and this runs unattended on
    // every park: pid 1 would make kill(-1) signal every process the user may signal.
    const pid = (info as any)?.pid;
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      process.kill(-pid, 'SIGTERM');
      stopped.push(name);
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
        stopped.push(name);
      } catch {}
    }
  }
  writeJsonAtomic(pidFile, {});
  if (stopped.length) logEvent(root, id, 'background-stop', { names: stopped });
  return stopped;
}

/** stopBackground only when runtime.json lists something, so a job with no process writes nothing. */
function stopProcesses(root: string, id: string): string[] {
  if (!runtimeNames(root, id).length) return [];
  try {
    return stopBackground(root, id);
  } catch {
    return [];
  }
}

/** Whether the config has a container Forge runs (not only external addresses). */
export const hasManagedBacking = (config: Config): boolean => Array.isArray(config.backing) && config.backing.some((e) => e && typeof e === 'object' && isManaged(e));

/**
 * Whether teardown has anything to do: backing.json or backing-db.json in the job dir, a
 * background process in runtime.json, or an entry in the environment record. Never a Docker call.
 */
export function hasEnvironment(root: string, id: string): boolean {
  const dir = jobDir(root, id);
  return fs.existsSync(path.join(dir, 'backing.json')) || fs.existsSync(path.join(dir, 'backing-db.json')) || runtimeNames(root, id).length > 0 || id in readEnvironments(root).jobs;
}

/**
 * The entries to stop so at most `cap` run: oldest `usedAt` first (then id, so the order is total),
 * never `self` and never the focused job. Fewer when only those two are left, so the cap can be
 * exceeded rather than stop the job being started or the one a human is looking at.
 */
export function pickVictims(rec: EnvironmentRecord, self: string, cap: number | null, focused: string | null): string[] {
  if (cap === null || !Number.isInteger(cap) || cap < 1) return [];
  const running = Object.entries(rec.jobs).filter(([, e]) => e.state === 'running');
  let over = running.length - cap;
  const out: string[] = [];
  const candidates = running.filter(([id]) => id !== self && id !== focused).sort(([a, x], [b, y]) => (x.usedAt < y.usedAt ? -1 : x.usedAt > y.usedAt ? 1 : a < b ? -1 : 1));
  for (const [id] of candidates) {
    if (over <= 0) break;
    out.push(id);
    over--;
  }
  return out;
}

/**
 * The idempotent start: the record says `running` with `usedAt` now, then backingUp runs (a missing
 * container is run, a stopped one started, a running one left) and gives the job its job database.
 * Without `backing` entries there is no Docker call, though the record is still written.
 */
export function ensureEnvironment(root: string, config: Config, job: Job, trigger: EnvironmentUpTrigger, runner?: DockerRunner): EnvironmentUpResult {
  const evicted: string[] = [];
  // A finished job never takes a place in the record (forge run on one still starts its services).
  let error = isActive(job)
    ? record(root, (rec) => {
        rec.jobs[job.id] = { state: 'running', usedAt: now() };
        evicted.push(...pickVictims(rec, job.id, config.environments?.maxRunning ?? null, readFocusRecord(root)?.job ?? null));
        for (const id of evicted) rec.jobs[id].state = 'stopped';
      })
    : null;
  // A record that was never written chose no victim.
  if (error !== null) evicted.length = 0;
  // Outside the lock: docker stop can take seconds per container. Each victim is already `stopped`
  // in the record, so its next resume or ensure up starts it again whatever this stop does.
  for (const id of evicted) stopEnvironment(root, config, id, 'evict', { by: job.id, runner, keepRecord: true });
  let backing: BackingUpEntry[] = [];
  if (Array.isArray(config.backing) && config.backing.length) {
    try {
      backing = backingUp(root, config, job, runner, databaseCommands(root, config, job));
    } catch (e) {
      error = message(e);
    }
  }
  error ??= backing.find((b) => !b.ok)?.error ?? (backing.some((b) => !b.ok) ? 'a backing service did not start' : null);
  const result: EnvironmentUpResult = { ok: error === null, backing, evicted, ...(error === null ? {} : { error }) };
  logEvent(root, job.id, 'environment-up', { trigger, ok: result.ok, ...(error === null ? {} : { error }), evicted });
  return result;
}

/**
 * Stop: background processes signalled, then this job's labelled per-job containers stopped. Volumes,
 * job databases, records and shared containers stay. The record says `stopped` whatever Docker did,
 * so the next resume or ensure up starts it again.
 */
export function stopEnvironment(
  root: string,
  config: Config,
  id: string,
  trigger: EnvironmentStopTrigger,
  // keepRecord: eviction marked it `stopped` under the lock already; writing again could undo a start that raced in since.
  opts: { by?: string; runner?: DockerRunner; keepRecord?: boolean } = {},
): EnvironmentStopResult {
  const processes = stopProcesses(root, id);
  let r: { stopped: string[]; ok: boolean; error?: string };
  try {
    r = backingStop(root, config, id, opts.runner);
  } catch (e) {
    r = { stopped: [], ok: false, error: message(e) };
  }
  const recError = opts.keepRecord
    ? null
    : record(root, (rec) => {
        rec.jobs[id] = { state: 'stopped', usedAt: rec.jobs[id]?.usedAt ?? now() };
      });
  const error = r.error ?? recError ?? undefined;
  const result: EnvironmentStopResult = { ok: error === undefined, processes, stopped: r.stopped, ...(error === undefined ? {} : { error }) };
  logEvent(root, id, 'environment-stop', { trigger, ...(opts.by ? { by: opts.by } : {}), ...result });
  return result;
}

/**
 * Teardown: stopBackground, then backingDown (per-job containers and volumes removed, job
 * databases dropped, backing.json and backing-db.json deleted), then the job leaves the record. On
 * a failure the records are kept, so any later teardown path retries. The worktree stays.
 */
export function teardownEnvironment(root: string, config: Config, id: string, trigger: EnvironmentDownTrigger, runner?: DockerRunner): EnvironmentDownResult {
  const processes = stopProcesses(root, id);
  let r: BackingDownResult;
  try {
    r = backingDown(root, config, id, runner);
  } catch (e) {
    r = { removed: [], volumes: [], ok: false, error: message(e) };
  }
  const recError = r.ok
    ? record(root, (rec) => {
        delete rec.jobs[id];
      })
    : null;
  const error = r.error ?? recError ?? undefined;
  const result: EnvironmentDownResult = { ok: error === undefined, processes, removed: r.removed, volumes: r.volumes, ...(r.databases ? { databases: r.databases } : {}), ...(error === undefined ? {} : { error }) };
  logEvent(root, id, 'environment-down', { trigger, ...result });
  return result;
}

/**
 * Teardown on finish: only when `before` was active, `after` is done or cancelled, and the job has
 * something to tear down. Null when it did not run. Never throws.
 */
export function finishEnvironment(root: string, config: Config, before: Job, after: Job, runner?: DockerRunner): EnvironmentDownResult | null {
  if (!isActive(before) || (after.state !== 'done' && after.state !== 'cancelled')) return null;
  try {
    if (!hasEnvironment(root, after.id)) return null;
    return teardownEnvironment(root, config, after.id, after.state, runner);
  } catch (e) {
    return { ok: false, processes: [], removed: [], volumes: [], error: message(e) };
  }
}

/**
 * finishEnvironment for the inbox and office sessions: a stop instead of the teardown, so text that
 * misleads one into cancelling another job can't remove that job's volumes or job databases, which
 * `forge environment down` refuses there too. The records stay, so archive or `forge environment
 * down` finishes it. Null when finishEnvironment would not have run. Never throws.
 */
export function finishEnvironmentStopOnly(root: string, config: Config, before: Job, after: Job, runner?: DockerRunner): EnvironmentFinishStopResult | null {
  if (!isActive(before) || (after.state !== 'done' && after.state !== 'cancelled')) return null;
  try {
    if (!hasEnvironment(root, after.id)) return null;
    return { ...stopEnvironment(root, config, after.id, after.state, { runner }), teardown: 'deferred' };
  } catch (e) {
    return { ok: false, processes: [], stopped: [], error: message(e), teardown: 'deferred' };
  }
}

/**
 * The record says `stopped` for a job whose per-job containers were stopped outside stopEnvironment
 * (the dashboard's backing Stop), so environments.maxRunning stops counting it. Only an entry that
 * is already there changes. The error, or null.
 */
export function recordEnvironmentStopped(root: string, id: string): string | null {
  return record(root, (rec) => {
    const e = rec.jobs[id];
    if (e) rec.jobs[id] = { state: 'stopped', usedAt: e.usedAt };
  });
}
