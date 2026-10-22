// `forge job delete`: removes a job that should never have existed (a mistaken start, a duplicate)
// and everything Forge made for it, keeping no archive record, so stats and retro never count it.
// Real work goes through cancel and archive instead: a job with a PR, a split parent with children,
// or a dependency of an active job is refused. A retention.log line records who deleted what.
import fs from 'node:fs';
import path from 'node:path';
import { currentActor } from './actor.ts';
// The tracker mirror lives with the tracker commands; nothing there imports this module back.
import { mirrorToTracker } from './commands/tracker.ts';
import { exists } from './paths.ts';
import { isActive, jobDir, leaseStatus, listJobs } from './jobs.ts';
import { ackRequest, listRequests } from './requests.ts';
import { appendRetentionLog, daemonRunning, readableJob } from './retention.ts';
import { sessionFiles } from './daemon-files.ts';
import { removeWorktree } from './worktree.ts';
import type { Config, DeleteJobResult, EventActor, Job } from './types.ts';
import { ForgeError, withLock } from './util.ts';

/**
 * Why `job` can't be deleted, or null. `force` lets a live interactive owner go; `stopsDaemon` skips
 * the running-daemon check, for the dashboard, which stops that session itself before the delete.
 */
export function deleteRefusal(root: string, job: Job, live: Job[], opts: { force?: boolean; stopsDaemon?: boolean } = {}): string | null {
  if (job.kind === 'eval') return 'eval jobs stay with their run; delete the run instead';
  if (job.pr?.number) return `it has PR #${job.pr.number}; cancel it and archive it instead (forge job archive)`;
  const owner = leaseStatus(job);
  if (owner.status === 'live' && !opts.force) return `owned by live session ${owner.session}; stop that session or pass --force`;
  if (!opts.stopsDaemon && daemonRunning(root, job.id)) return 'a dashboard session is running it; stop it in the dashboard first';
  const kids = (Array.isArray(job.children) ? job.children : []).filter((k) => live.some((o) => o.id === k));
  if (kids.length) return `it has split children (${kids.join(', ')}); delete them first`;
  for (const other of live) {
    if (other.id === job.id || !isActive(other)) continue;
    const deps = Array.isArray(other.dependsOn) ? other.dependsOn : [];
    if (deps.includes(job.id)) return `needed by ${other.id} (${other.stage}/${other.state})`;
  }
  return null;
}

/**
 * Checks everything before it changes anything, then: releases the tracker claim (best effort),
 * removes the worktrees, per-job backing services and, when Forge named it, the branch, rejects the
 * job's open requests, deletes its daemon session files and finally its job dir. A failure before
 * the job dir goes leaves the job in place, so a rerun finishes the work.
 */
export async function deleteJob(root: string, config: Config, id: string, opts: { force?: boolean; actor?: EventActor; trigger?: 'cli' | 'dashboard' } = {}): Promise<DeleteJobResult> {
  if (!exists(path.join(jobDir(root, id), 'job.json'))) throw new ForgeError(`no job ${id}`, 'not_found');
  const pre = readableJob(root, id);
  if (typeof pre === 'string') throw new ForgeError(`cannot delete ${id}: ${pre}`, 1, 'not_found');
  const job = pre.job;
  const refusal = deleteRefusal(root, job, listJobs(root), { force: opts.force });
  if (refusal) throw new ForgeError(`cannot delete ${id}: ${refusal}`, 1);

  // A finished job releases its issues, so the tracker sees it as cancelled before the record goes.
  await mirrorToTracker(root, config, { ...job, state: 'cancelled', reason: 'deleted' }).catch(() => {});

  // Only the branch Forge named for this job: one given with --branch may be a human's own.
  const ownBranch = job.branch === `${config.git.branchPrefix}${id}`;
  const wt = await removeWorktree(root, id, { deleteBranch: ownBranch, force: true });
  if (wt.backing && !wt.backing.ok) throw new ForgeError(`cannot delete ${id}: its backing services were not removed (${wt.backing.error ?? 'docker failed'}); fix that and rerun forge job delete ${id}`, 1);
  const stuck = wt.repos?.find((r) => r.error);
  if (stuck) throw new ForgeError(`cannot delete ${id}: ${stuck.error}; rerun forge job delete ${id} once it is fixed`, 1);

  let requests = 0;
  for (const r of listRequests(root)) {
    if (r.job !== id || (r.status !== 'pending' && r.status !== 'in-progress')) continue;
    ackRequest(root, r.id, { status: 'rejected', result: 'job deleted' });
    requests++;
  }

  const files = sessionFiles(root, id);
  for (const f of [files.info, files.log, `${files.log}.1`]) if (fs.lstatSync(f, { throwIfNoEntry: false })?.isFile()) fs.rmSync(f, { force: true });

  const dir = jobDir(root, id);
  withLock(path.join(dir, '.lock'), () => {
    // Re-read inside the lock: a session may have claimed it while the worktree came down.
    const cur = readableJob(root, id);
    if (typeof cur === 'string') throw new ForgeError(`cannot delete ${id}: ${cur}`, 1);
    const owner = leaseStatus(cur.job);
    if (owner.status === 'live' && !opts.force && owner.session !== job.lease.driver) throw new ForgeError(`cannot delete ${id}: claimed by live session ${owner.session} meanwhile`, 1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const actor = opts.actor ?? currentActor(root);
  appendRetentionLog(root, { type: 'deleted', kind: 'job', id, title: job.title, trigger: opts.trigger ?? 'cli', actor });
  return { deleted: id, title: job.title, worktree: wt.removed, branch: ownBranch ? job.branch : null, ...(wt.repos ? { repos: wt.repos.map((r) => r.repo) } : {}), requests };
}
