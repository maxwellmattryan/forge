// The dollar cap a job session's spawn passes as --max-budget-usd: what is left of the job's usd limit after its
// spent figure (the metered one when the supervisor has metered it), recomputed at every spawn because the flag
// caps one process. And the stop message once claude reaches it.
import { configForJob } from '#engine/evals/overlay.ts';
import { remainingUsd } from '#engine/metrics/budget.ts';
import { jobSpend, spentFrom } from '#engine/metrics/spend.ts';
import { loadJob } from '#core/job/store.ts';
import { sharedScope } from '#core/job/requests.ts';
import { capArg } from '#integrations/claude/argv.ts';
import type { Config, Job } from '#core/types.ts';

/**
 * The job's remaining dollars plus `baselineUsd`, or null (no flag) for a shared session (inbox, office, chat), an unreadable job or
 * an unlimited usd. `baselineUsd` is the resumed conversation's last metered cumulative: claude's own running total
 * already includes it on a resume, so the cap adds it back. A fresh spawn's is 0.
 */
export function spawnBudgetCap(root: string, scope: string, config: Config, baselineUsd = 0): number | null {
  if (sharedScope(scope)) return null;
  let job: Job;
  try {
    job = loadJob(root, scope);
  } catch {
    return null;
  }
  let c = config;
  try {
    c = configForJob(root, config, job);
  } catch {
    // A tampered eval overlay falls back to the base, as the pool's jobConfig does.
  }
  const left = remainingUsd(c, job, spentFrom(jobSpend(root, c, job)).usd);
  return left === null ? null : left + baselineUsd;
}

/** The session's lastError once claude reached its cap. */
export function budgetStopMessage(cap: number): string {
  return `daemon stopped: this job's session reached its --max-budget-usd cap of $${capArg(cap)} (the job's dollar limit minus its spend); raise or acknowledge the job's budget in the dashboard, then start the session again`;
}
