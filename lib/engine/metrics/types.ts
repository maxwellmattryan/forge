// The spend ledger's bucket, the job source stats reads and `forge stats --by prompt`'s shapes, type-only.
import type { Job, JobEvent, Stats } from '#api/types.ts';
import type { JobFindings } from '#core/job/types.ts';

/** One job stats reads: live (its files on disk) or archived (its record), with the same accessors. */
export interface StatsSource {
  job: Job;
  events: () => JobEvent[];
  findings: () => JobFindings;
  archived: boolean;
}

/** One day, role and model's spend in the ledger: lib/engine/metrics/spend.ts. */
export interface SpendBucket {
  runs: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

/** One prompt cohort of `forge stats --by prompt` (statsByPrompt in lib/engine/metrics/stats.ts). */
export interface PromptCohort {
  promptHash: string;
  jobs: number;
  /** The first 20, oldest keyed start first. */
  jobIds: string[];
  /** The earliest and latest keyed start of the cohort's jobs. */
  firstAt: string;
  lastAt: string;
  /** At most 5 each, in run order. */
  pluginHashes: string[];
  configHashes: string[];
  /** The full metrics over this cohort's jobs only. */
  stats: Stats;
}

/** `forge stats --by prompt`: jobs keyed by the promptHash on their role's last hashed agent-start. */
export interface PromptStats {
  by: 'prompt';
  role: string;
  since: string | null;
  /** Oldest firstAt first. */
  cohorts: PromptCohort[];
  /** Jobs with no hashed start for the role. */
  unrecorded: number;
  /** Jobs whose starts for the role carry more than one hash. */
  mixed: number;
}
