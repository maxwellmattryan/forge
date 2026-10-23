// What keeps a request or a turn waiting: a job parked on its budget, the repo budget, and the
// quota limits a failed turn reports.
import { effectiveLimits, exceededKeys, measureBudget } from '#engine/metrics/budget.ts';
import { configForJob } from '#engine/evals/overlay.ts';
import { loadJob } from '#core/job/store.ts';
import { validJobId } from '#core/job/requests.ts';
import { repoBudgetExempt } from '#engine/metrics/repo-budget.ts';
import type { Config, RepoBudgetStatus } from '#core/types.ts';

/** Request types that act on a job a budget stop may have parked. `approve` is the acknowledgement, so it is never held. */
const HOLD_TYPES: string[] = ['resume', 'rework', 'answer', 'revise-spec'];

/**
 * Request types the repo budget holds. Approving is no acknowledgement of a repo cap (only
 * `forge budget ack` is), so `approve` waits too; `cancel` never does.
 */
const REPO_HOLD_TYPES: string[] = [...HOLD_TYPES, 'approve'];

/**
 * A failed turn whose message says the account is out of quota, not that the request is broken:
 * it is retried for as long as it takes, never counted as a strike. Claude Code's wording for the
 * subscription windows and the API's 400 for a spend cap ("usage limits"), 429 and 529 all match.
 */
export const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|too many requests|\b429\b|overloaded|\b529\b/i;

/** The part of a `rate_limit_event` the supervisor uses: whether the last request was refused, and when the window resets. */
export interface RateLimitInfo {
  status: string;
  /** ms since the epoch */
  resetsAt: number | null;
}

/** Reads `rate_limit_info` from a `rate_limit_event` line tolerantly; the shape is Claude Code's, not a contract. */
export function parseRateLimit(info: unknown): RateLimitInfo | null {
  if (!info || typeof info !== 'object') return null;
  const r = info as Record<string, unknown>;
  if (typeof r.status !== 'string') return null;
  const raw = typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) && r.resetsAt > 0 ? r.resetsAt : null;
  // Observed as epoch seconds; accept milliseconds too, in case that changes.
  const resetsAt = raw === null ? null : raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  return { status: r.status, resetsAt };
}

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
export function heldByRepoBudget(root: string, repo: RepoBudgetStatus | null | undefined, rec: { type: string; job: string | null }): boolean {
  if (!repo?.held || !REPO_HOLD_TYPES.includes(rec?.type) || !validJobId(rec.job)) return false;
  let job;
  try {
    job = loadJob(root, rec.job);
  } catch {
    return false;
  }
  return !repoBudgetExempt(root, job, repo);
}
