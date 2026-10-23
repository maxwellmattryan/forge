// The environment record (docs/CONFIG.md "Backing services" › Lifecycle): what Forge last did to
// each job's environment, `running` or `stopped`, with when it was last used. Only the CLI writes it,
// under one lock. It is file I/O only, no Docker, so lib/engine/pipeline/step/input.ts can read it. The runtime dir is
// agent-writable, so the read follows no link or FIFO, and a hand-written entry can only ever cause
// a stop (never a removal) or lose a job its place: a future `usedAt` reads as now.
import fs from 'node:fs';
import path from 'node:path';
import { readSmallJson } from '#core/job/focus.ts';
import { isActive, jobDir, loadJob } from '#core/job/store.ts';
import { paths } from '#core/paths.ts';
import { validJobId } from '#core/job/requests.ts';
import type { EnvironmentEntry, EnvironmentRecord, EnvironmentState } from '#core/types.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { withLock } from '#core/os/lock.ts';

const EPOCH = new Date(0).toISOString();

export const environmentsFile = (root: string): string => path.join(paths(root).runtime, 'environments.json');
const environmentsLock = (root: string): string => path.join(paths(root).locks, 'environments');

const empty = (): EnvironmentRecord => ({ v: 1, jobs: {} });

/** `usedAt` as an ISO time no later than `at`: unparseable reads as the epoch, a future one as `at`. */
function usedAtOf(v: unknown, at: number): string {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return EPOCH;
  return new Date(Math.min(t, at)).toISOString();
}

/**
 * The record read safely: an unreadable file (missing, a link, a FIFO, oversized, not JSON) reads
 * as empty, an invalid job id or a bad state drops the entry. Nothing is written.
 */
export function readEnvironments(root: string, at = Date.now()): EnvironmentRecord {
  const raw = readSmallJson(environmentsFile(root));
  const out = empty();
  const jobs = raw?.jobs;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) return out;
  for (const [id, e] of Object.entries(jobs as Record<string, unknown>)) {
    if (!validJobId(id) || !e || typeof e !== 'object') continue;
    const state = (e as Record<string, unknown>).state;
    if (state !== 'running' && state !== 'stopped') continue;
    out.jobs[id] = { state, usedAt: usedAtOf((e as Record<string, unknown>).usedAt, at) };
  }
  return out;
}

/** The job's recorded state, or null when the record has no entry for it. */
export function environmentState(root: string, id: string): EnvironmentState | null {
  return readEnvironments(root).jobs[id]?.state ?? null;
}

/** A job whose job.json exists and is neither done nor cancelled. */
export function liveJob(root: string, id: string): boolean {
  try {
    if (!fs.existsSync(path.join(jobDir(root, id), 'job.json'))) return false;
    return isActive(loadJob(root, id));
  } catch {
    return false;
  }
}

/**
 * The locked read-modify-write. `fn` changes `rec.jobs` in place; entries whose job is missing or
 * finished are dropped first, so a finished job never holds a place. Written only when it changed.
 */
export function updateEnvironments<T>(root: string, fn: (rec: EnvironmentRecord) => T): T {
  return withLock(environmentsLock(root), () => {
    const before = readEnvironments(root);
    const rec: EnvironmentRecord = { v: 1, jobs: {} };
    for (const [id, e] of Object.entries(before.jobs)) if (liveJob(root, id)) rec.jobs[id] = e;
    const out = fn(rec);
    const jobs: Record<string, EnvironmentEntry> = {};
    for (const [id, e] of Object.entries(rec.jobs)) if (validJobId(id) && (e.state === 'running' || e.state === 'stopped')) jobs[id] = { state: e.state, usedAt: e.usedAt };
    const next: EnvironmentRecord = { v: 1, jobs };
    const raw = readSmallJson(environmentsFile(root));
    if (JSON.stringify(next) !== JSON.stringify(raw)) writeJsonAtomic(environmentsFile(root), next);
    return out;
  });
}
