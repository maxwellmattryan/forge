// `forge job repo|interim`: a job's member repos, their interim strategies, canary publishes and recorded releases.
import { readEvents } from '#core/job/store.ts';
import { addJobRepo, refuseInterimInDaemon, refuseJobRepoInDaemon, removeJobRepo } from '#engine/project/job-repos.ts';
import { proposeJobRepo } from '#engine/project/repo-proposals.ts';
import { addDownstreamRepos } from '#engine/project/downstream.ts';
import { RELEASE_DAEMON_REFUSAL, interimStatus, publishCanary, recordRelease, setRepoInterim } from '#engine/release/interim-apply.ts';
import { releaseGates } from '#engine/release/interim.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { requireJob, str, usageError } from '../args.ts';
import { JOB } from './help.ts';

export function repo(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  // Computed from config and events, never named: the one way a job's own session adds a repo, and only verify-only.
  if (rest[0] === 'downstream') {
    if (rest.length !== 2 || Object.keys(flags).length) throw usageError(JOB, 'repo');
    return addDownstreamRepos(root, config, rest[1]);
  }
  if (rest[0] === 'interim') {
    refuseInterimInDaemon();
    const jobId = rest[1];
    const root_ = flags.root;
    // parseArgs gives `--root` the next word as its value, so `--root canary` arrives as root: 'canary'.
    const strategy = typeof root_ === 'string' ? root_ : rest[root_ === true ? 2 : 3];
    const name = root_ === undefined ? rest[2] : undefined;
    if (!jobId || !strategy || (root_ === undefined && !name) || rest.length > (root_ === undefined ? 4 : typeof root_ === 'string' ? 2 : 3)) throw usageError(JOB, 'repo');
    return setRepoInterim(root, config, requireJob(root, jobId).id, name ?? null, strategy);
  }
  const action = rest[0];
  const jobId = rest[1];
  const name = rest[2];
  // An agent may propose (in its own job's session only); adding and removing stay human-only.
  if (action === 'propose') {
    if (!jobId || !name || rest.length > 3 || flags['verify-only'] !== undefined) throw usageError(JOB, 'repo');
    // A bare or empty --reason is a missing reason (exit 1), not a usage error.
    const reason = Array.isArray(flags.reason) ? str(flags.reason, '--reason') : typeof flags.reason === 'string' ? flags.reason : undefined;
    return proposeJobRepo(root, config, requireJob(root, jobId).id, name, reason);
  }
  refuseJobRepoInDaemon();
  if (flags.reason !== undefined) throw usageError(JOB, 'repo');
  if (!['add', 'remove'].includes(String(action)) || !jobId || !name || rest.length > 3 || (action === 'remove' && flags['verify-only'] !== undefined)) throw usageError(JOB, 'repo');
  requireJob(root, jobId);
  return action === 'add' ? addJobRepo(root, config, jobId, name, flags['verify-only'] === true) : removeJobRepo(root, jobId, name);
}

export function interim(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  if (rest[0] === 'publish') {
    const jobId = rest[1];
    const root_ = flags.root;
    if (!jobId || (root_ !== undefined && root_ !== true) || (root_ === true ? rest.length !== 2 : rest.length !== 3)) throw usageError(JOB, 'interim');
    if (flags.confirm !== undefined && flags.confirm !== true) throw usageError(JOB, 'interim');
    return publishCanary(root, config, requireJob(root, jobId).id, root_ === true ? null : rest[2], { confirm: flags.confirm === true, interactive: process.stdin.isTTY === true });
  }
  if (rest[0] === 'release') {
    // Before the job or config is read: a daemon session never records a release.
    if (process.env.FORGE_DAEMON === '1') throw new ForgeError(RELEASE_DAEMON_REFUSAL);
    const jobId = rest[1];
    const root_ = flags.root;
    // parseArgs gives `--root` the next word as its value, so `--root 1.2.0` arrives as root: '1.2.0'.
    const version = typeof root_ === 'string' ? root_ : rest[root_ === true ? 2 : 3];
    const name = root_ === undefined ? rest[2] : undefined;
    if (!jobId || !version || (root_ === undefined && !name) || rest.length !== (root_ === undefined ? 4 : typeof root_ === 'string' ? 2 : 3)) throw usageError(JOB, 'interim');
    return recordRelease(root, config, requireJob(root, jobId).id, name ?? null, version);
  }
  if (!id || rest.length > 1) throw usageError(JOB, 'interim');
  const job = requireJob(root, id);
  const edges = interimStatus(root, config, job).edges;
  return { id: job.id, edges, gates: releaseGates(edges, readEvents(root, job.id), job) };
}
