// The dollar cap a job session's spawn passes as --max-budget-usd: what is left of the job's usd limit after its
// self-reported spend, recomputed at every spawn because the flag caps one process. And the stop message once
// claude reaches it.
import { configForJob } from '#engine/evals/overlay.ts';
import { remainingUsd } from '#engine/metrics/budget.ts';
import { loadJob } from '#core/job/store.ts';
import { INBOX_SCOPE, OFFICE_SCOPE } from '#core/job/requests.ts';
import { capArg } from '#integrations/claude/argv.ts';
import type { Config, Job } from '#core/types.ts';

/** The job's remaining dollars, or null (no flag) for the inbox and office, an unreadable job or an unlimited usd. */
export function spawnBudgetCap(root: string, scope: string, config: Config): number | null {
  if (scope === INBOX_SCOPE || scope === OFFICE_SCOPE) return null;
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
  return remainingUsd(c, job);
}

/** The session's lastError once claude reached its cap. */
export function budgetStopMessage(cap: number): string {
  return `daemon stopped: this job's session reached its --max-budget-usd cap of $${capArg(cap)} (the job's dollar limit minus its self-reported spend); raise or acknowledge the job's budget in the dashboard, then start the session again`;
}
