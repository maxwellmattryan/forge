// `forge job archive|delete|prune`: archiving finished jobs, deleting a mistaken one, and pruning old jobs and session logs; never from a daemon session.
import { daemonScope } from '#core/job/requests.ts';
import { TeardownRefusal, archiveJob, archiveOlder, prune } from '#engine/ops/retention.ts';
import { deleteJob } from '#engine/ops/delete.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import type { ArchiveResult } from '#engine/ops/types.ts';
import { num, req, usageError } from '../args.ts';
import { JOB } from './help.ts';

// Archive and prune delete job folders and session logs: a session misled by tracker text must not
// wipe the evidence. The retention policy itself still runs from forge sync, since a human set it.
const refuseRetentionInDaemon = (sub: string) => {
  const s = daemonScope(process.env);
  if ('problem' in s || s.daemon) throw new ForgeError(`forge job ${sub} deletes job folders and session logs, which a daemon session may not do; run it from your own terminal`, 1, 'run it from your own terminal');
};

export function archive(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  refuseRetentionInDaemon('archive');
  if (flags.done !== undefined || flags['older-than'] !== undefined) {
    if (id !== undefined || flags.done !== true || flags['older-than'] === undefined) throw usageError(JOB, 'archive');
    return archiveOlder(root, num(flags['older-than'], '--older-than', { integer: true })!, 'cli', { config });
  }
  if (rest.length !== 1) throw usageError(JOB, 'archive');
  const jobId = req(id, 'job id');
  try {
    return { archived: [archiveJob(root, jobId, 'cli', { config })], refused: [] } satisfies ArchiveResult;
  } catch (e) {
    // Kept for the next attempt, as --done lists it: the job dir and its records still exist.
    if (e instanceof TeardownRefusal) return { archived: [], refused: [{ id: jobId, reason: e.reason }] } satisfies ArchiveResult;
    throw e;
  }
}

export function deleteCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  refuseRetentionInDaemon('delete');
  if (rest.length !== 1) throw usageError(JOB, 'delete');
  return deleteJob(root, config, req(id, 'job id'), { force: flags.force === true, trigger: 'cli' });
}

export function pruneCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  refuseRetentionInDaemon('prune');
  if (rest.length || flags['older-than'] === undefined) throw usageError(JOB, 'prune');
  return prune(root, num(flags['older-than'], '--older-than', { integer: true })!, { dryRun: flags['dry-run'] === true });
}
