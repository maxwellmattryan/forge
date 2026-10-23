// What keeps a request waiting: a job parked on its budget, or the repo budget.
import { effectiveLimits, exceededKeys, measureBudget } from '#engine/metrics/budget.ts';
import { configForJob } from '#engine/evals/overlay.ts';
import { loadJob } from '#core/job/store.ts';
import { validJobId } from '#core/job/requests.ts';
import { repoBudgetExempt } from '#engine/metrics/repo-budget.ts';
import type { Config, ForgeRequest, RepoBudgetStatus } from '#core/types.ts';

/** Request types that act on a job a budget stop may have parked. `approve` is the acknowledgement, so it is never held. */
const HOLD_TYPES: string[] = ['resume', 'rework', 'answer', 'revise-spec'];

/**
 * Request types the repo budget holds. Approving is no acknowledgement of a repo cap (only
 * `forge budget ack` is), so `approve` waits too; `cancel` never does.
 */
const REPO_HOLD_TYPES: string[] = [...HOLD_TYPES, 'approve'];

/**
 * A request is held while its job is parked on a budget that is still exceeded; once a human
 * raises or acknowledges it, the request becomes eligible on the next tick.
 */
export function heldByBudget(root: string, config: Config, rec: { type: string; job: string | null }): boolean {
  if (!HOLD_TYPES.includes(rec?.type) || !validJobId(rec.job)) return false;
  let job;
  try {
    job = loadJob(root, rec.job);
  } catch {
    return false;
  }
  if (job.state !== 'waiting' || job.waitingOn !== 'budget') return false;
  let limitsConfig = config;
  try {
    limitsConfig = configForJob(root, config, job);
  } catch {
    // A tampered overlay must not crash the supervisor; step and verify already refuse that job.
  }
  return exceededKeys(effectiveLimits(limitsConfig, job), measureBudget(job), job.budget.ack, job.round).length > 0;
}

/** A request is held while the repo budget holds new work and its job is not exempt (retro, or forced past the cap this month). */
function heldByRepoBudget(root: string, repo: RepoBudgetStatus | null | undefined, rec: { type: string; job: string | null }): boolean {
  if (!repo?.held || !REPO_HOLD_TYPES.includes(rec?.type) || !validJobId(rec.job)) return false;
  let job;
  try {
    job = loadJob(root, rec.job);
  } catch {
    return false;
  }
  return !repoBudgetExempt(root, job, repo);
}

/** Which of a tick's pending requests a budget holds: the hold to show, and the ids still eligible. */
export function routeHolds(root: string, c: Config, pending: ForgeRequest[], repo: RepoBudgetStatus | null | undefined): { held: 'budget' | 'repo-budget' | null; eligible: string[] } {
  // The repo budget reads first when both hold: it is the one a per-job ack can't clear.
  let next: 'budget' | 'repo-budget' | null = null;
  const eligible: string[] = [];
  for (const r of pending) {
    if (heldByRepoBudget(root, repo, r)) next = 'repo-budget';
    else if (heldByBudget(root, c, r)) next ??= 'budget';
    else eligible.push(r.id);
  }
  return { held: next, eligible };
}
