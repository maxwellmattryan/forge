// A job's environment (docs/CONFIG.md "Backing services" › Lifecycle): its per-job containers and
// volumes, its job databases on shared servers and its background processes. Ensure up starts it,
// stop keeps everything but the running processes, teardown removes it. None of these throws on a
// Docker, psql or record failure: each returns `ok: false` with the error and logs its event, so a
// state change that triggered it is never rolled back. Names reach Docker only through
// lib/backing.ts, which derives them from the job id and config.
import fs from 'node:fs';
import path from 'node:path';
import { backingDown, backingStop, backingUp, isManaged } from './backing.ts';
import type { DockerRunner } from './backing.ts';
import { readSmallJson } from './focus.ts';
import { readEnvironments, updateEnvironments } from './environment-record.ts';
import { isActive, jobDir, logEvent } from './jobs.ts';
import type { BackingDownResult, BackingUpEntry, Config, EnvironmentDownResult, EnvironmentDownTrigger, EnvironmentStopResult, EnvironmentStopTrigger, EnvironmentUpResult, EnvironmentUpTrigger, Job } from './types.ts';
import { now } from './util.ts';
import { databaseCommands, stopBackground } from './worktree.ts';

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
 * The idempotent start: the record says `running` with `usedAt` now, then backingUp runs (a missing
 * container is run, a stopped one started, a running one left) and gives the job its job database.
 * Without `backing` entries there is no Docker call, though the record is still written.
 */
export function ensureEnvironment(root: string, config: Config, job: Job, trigger: EnvironmentUpTrigger, runner?: DockerRunner): EnvironmentUpResult {
  const evicted: string[] = [];
  let error = record(root, (rec) => {
    rec.jobs[job.id] = { state: 'running', usedAt: now() };
  });
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
export function stopEnvironment(root: string, config: Config, id: string, trigger: EnvironmentStopTrigger, opts: { by?: string; runner?: DockerRunner } = {}): EnvironmentStopResult {
  const processes = stopProcesses(root, id);
  let r: { stopped: string[]; ok: boolean; error?: string };
  try {
    r = backingStop(root, config, id, opts.runner);
  } catch (e) {
    r = { stopped: [], ok: false, error: message(e) };
  }
  const recError = record(root, (rec) => {
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
