// Who drives a job and whether that driver is one of this pool's sessions, by every id the session
// has had; and the one release of everything a gone session held. Every check of a lease's driver
// against a session's ids in lib/office/ and lib/server/ asks here, so the server, the reconciler
// and a session's exit never disagree after a session-changed.
import fs from 'node:fs';
import path from 'node:path';
import { UUID, readInfo, sessionRecords } from '#core/job/session-files.ts';
import { expireLease, leaseStatus, loadJob, markAgentsLost, requeueOrphanedRequests } from '#core/job/store.ts';
import { INBOX_SCOPE } from '#core/job/requests.ts';
import { paths } from '#core/paths.ts';
import type { Config, Job, LoadedJob } from '#core/types.ts';

/** The summary an agent gets when its session's child exits under it. */
export const LOST_SUMMARY = 'lost: its daemon session ended';

/**
 * Every id a session record has held: current, spawn, then past, deduped. The record is a local
 * file the session itself can write, so anything that is not a uuid is dropped.
 */
export function recordIds(info: any): string[] {
  const past: unknown[] = Array.isArray(info?.pastSessionIds) ? info.pastSessionIds : [];
  const ids = [info?.sessionId, info?.spawnSessionId, ...past].filter((s): s is string => typeof s === 'string' && UUID.test(s));
  return [...new Set(ids)];
}

/**
 * The intake runner's claim id (lib/office/inbox/runner.ts) in the inbox's record, or null when it is not a uuid.
 * Never one of recordIds: the inbox session's own exit must not let go of what a live intake run holds.
 */
export function intakeIdOf(info: any): string | null {
  const id = info?.intakeSessionId;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

/** Every id of the inbox session's record, and the intake runner's claim id. */
export function inboxSessionIds(root: string): string[] {
  const rec = sessionRecords(root).find((r) => r.scope === INBOX_SCOPE);
  if (!rec) return [];
  const info = readInfo(rec.info);
  const intake = intakeIdOf(info);
  return [...new Set([...recordIds(info), ...(intake ? [intake] : [])])];
}

/** Every id of every session record, and the intake runner's: the sessions `forge dash` ran, as opposed to interactive ones. */
export function daemonSessionIds(root: string): string[] {
  return [
    ...new Set(
      sessionRecords(root).flatMap((r) => {
        const info = readInfo(r.info);
        const intake = r.scope === INBOX_SCOPE ? intakeIdOf(info) : null;
        return [...recordIds(info), ...(intake ? [intake] : [])];
      }),
    ),
  ];
}

/** The lease has a driver and it is one of `ids`, live or expired. */
export function drivenBy(job: Pick<Job, 'lease'>, ids: readonly string[]): boolean {
  const driver = job.lease?.driver;
  return typeof driver === 'string' && ids.includes(driver);
}

/** whoDrives' answer. */
export interface Drive {
  driver: string | null;
  lease: 'live' | 'expired' | 'none';
  /** The driver is one of the session's ids, whether the lease is live or expired. */
  own: boolean;
  /** Own, and that session's child runs (any status but `off`). */
  jobSession: boolean;
  /** A live lease that is not the job session's: a resume would only bounce off it. */
  held: boolean;
}

/**
 * Who drives a job, asked of the one session whose scope is that job (null when there is none), so
 * the same id driving a different job is a stranger there. Pure.
 */
export function whoDrives(job: Pick<Job, 'lease'>, session: { ids: readonly string[]; status: string } | null | undefined, at = Date.now()): Drive {
  const lease = leaseStatus(job, at).status;
  const own = session != null && drivenBy(job, session.ids);
  const jobSession = own && session.status !== 'off';
  return { driver: job.lease?.driver ?? null, lease, own, jobSession, held: lease === 'live' && !jobSession };
}

/** What releaseSession let go: per job the ids drove, the roles marked lost and the driver whose lease it expired. */
export interface Released {
  jobs: { job: string; lost: string[]; expired: string | null }[];
  requeued: string[];
  rejected: string[];
  errors: string[];
}

/** Every job.json under the jobs dir; one that cannot be read is an error, not a stop. */
function readJobs(root: string, errors: string[]): LoadedJob[] {
  const dir = paths(root).jobs;
  let names: string[];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'job.json')))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const jobs: LoadedJob[] = [];
  for (const name of names) {
    try {
      jobs.push(loadJob(root, name));
    } catch (e) {
      errors.push(`reading ${name}'s job.json: ${(e as Error).message}`);
    }
  }
  return jobs;
}

/**
 * Everything sessions under `ids` held, let go once they are gone: for every job one of the ids
 * drives (any job, not only a session's own scope), its running agents are marked lost (re-checked
 * per role, stopping once another driver has the job) and its live lease expires (driver and epoch
 * kept: anyone may now claim); then every request the ids claimed goes back to pending. `byAge`
 * (default false) also applies the claim-age rule, for a caller that knows no session of its pool
 * is mid-turn. Never throws: an exit must finish whatever job.json says.
 */
export function releaseSession(root: string, ids: readonly string[], opts: { reason: string; config: Config; byAge?: boolean; at?: number }): Released {
  const out: Released = { jobs: [], requeued: [], rejected: [], errors: [] };
  if (!ids.length || !fs.existsSync(root)) return out;
  for (const job of readJobs(root, out.errors)) {
    if (!drivenBy(job, ids)) continue;
    const entry: Released['jobs'][number] = { job: job.id, lost: [], expired: null };
    out.jobs.push(entry);
    const running = Object.entries(job.agents ?? {})
      .filter(([, a]) => a?.status === 'running')
      .map(([role]) => role)
      .sort();
    if (running.length) {
      try {
        entry.lost = markAgentsLost(root, job.id, running, LOST_SUMMARY, opts.config, ids);
      } catch (e) {
        out.errors.push(`marking agents lost: ${(e as Error).message}`);
      }
    }
    try {
      entry.expired = expireLease(root, job.id, ids, opts.reason);
    } catch (e) {
      out.errors.push(`expiring ${job.id}'s lease: ${(e as Error).message}`);
    }
  }
  try {
    const { requeued, rejected } = requeueOrphanedRequests(root, { exited: ids, byAge: opts.byAge ?? false, ...(opts.at !== undefined ? { at: opts.at } : {}) });
    out.requeued = requeued.map((r) => r.id);
    out.rejected = rejected.map((r) => r.id);
  } catch (e) {
    out.errors.push(`requeueing claimed requests: ${(e as Error).message}`);
  }
  return out;
}
