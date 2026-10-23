// `forge job claim|release|step`: a job's lease and its driver's epoch, and the `--epoch` fence other handlers share.
import { claimRespectingDeps } from '#engine/pipeline/moves/deps.ts';
import { checkFence, leaseStatus, loadJob, logEvent, releaseJob, renewLease, type Fence } from '#core/job/store.ts';
import { refuseInOffice } from '#office/owner.ts';
import { loadStepInput, step } from '#engine/pipeline/step.ts';
import { refreshRequest } from '#engine/trackers/request-refresh.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { checkRepoBudget, isRepoHold, parkForRepoBudget, repoBudgetBlock, repoBudgetExempt } from '#engine/metrics/repo-budget.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { num, req, requireJob, str } from '../args.ts';

const TERMINAL_STATES = ['done', 'cancelled', 'failed'];

/** `--epoch N` as a fence, with `session` when the call names one; undefined without the flag. Parsed before any write. */
export function epochFence(flags: Record<string, any>, session?: string): Fence | undefined {
  const epoch = num(flags.epoch, '--epoch', { integer: true });
  return epoch === undefined ? undefined : { epoch, ...(session !== undefined ? { session } : {}) };
}

export async function claim(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  refuseInOffice(`it never claims ${jobId}`);
  const force = Boolean(flags.force);
  const session = req(str(flags.session, '--session'), '--session');
  const fence = epochFence(flags, session);
  // Before the budget check, which may park the job: a stale driver writes nothing.
  if (fence) checkFence(root, jobId, fence);
  const status = checkRepoBudget(root, config);
  let budgetNote: { held: boolean; reason: string | null } | null = null;
  if (status.reason) {
    const cur = loadJob(root, jobId);
    const own = leaseStatus(cur);
    const agentRunning = Object.values(cur.agents ?? {}).some((a) => a?.status === 'running');
    const foreignOwner = own.status === 'live' && own.session !== session;
    const limited = !repoBudgetExempt(root, cur, status) && !TERMINAL_STATES.includes(cur.state) && !agentRunning && !foreignOwner;
    // A running agent finishes its step, a foreign owner gets its exit 3, and another gate's wait is kept.
    if (limited && status.held && (cur.state !== 'waiting' || isRepoHold(cur))) {
      parkForRepoBudget(root, jobId, status);
      throw new ForgeError(status.reason, 'blocked', 'forge budget');
    }
    if ((limited && cur.state !== 'waiting') || agentRunning) budgetNote = repoBudgetBlock(status);
  }
  // Only a forced takeover is a person's decision; a plain claim is the pipeline's own.
  const opts = { ...(force ? { actor: currentActor(root) } : {}), ...(fence ? { fence } : {}) };
  const { job, overridden } = claimRespectingDeps(root, jobId, session, force, opts);
  if (budgetNote && !budgetNote.held) logEvent(root, job.id, 'repo-budget-warn', { reason: budgetNote.reason });
  const refresh = await refreshRequest(root, config, job.id, 'claim');
  // The epoch is what the driver passes as --epoch to every later step and advance.
  return { id: job.id, lease: job.lease, epoch: job.lease.epoch, ...(overridden.length ? { dependenciesOverridden: overridden } : {}), ...(budgetNote ? { repoBudget: budgetNote } : {}), ...(refresh.refreshed ? { requestRefreshed: true } : {}) };
}

export function release(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  releaseJob(root, jobId);
  return { id: jobId, released: true };
}

export function stepCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = loadJob(root, req(id, 'job id')).id;
  // The loop's renewal: only the driver's own step renews its lease, and nothing else changes.
  const session = str(flags.session, '--session');
  const fence = epochFence(flags, session);
  if (session !== undefined) renewLease(root, jobId, { session, fence });
  else if (fence) checkFence(root, jobId, fence);
  return step(loadStepInput(root, config, jobId));
}
