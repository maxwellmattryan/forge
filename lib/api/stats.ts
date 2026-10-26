// GET /api/stats, /api/evals and /api/evals/compare: the Analytics and Evals pages.
import type { Stage } from './enums.ts';
import type { EvalOverlay } from './job.ts';

/** Usage per role or model in stats: computeStats in lib/engine/metrics/stats.ts. */
export interface UsageRow {
  tokens: number;
  estCostUsd: number;
  runs: number;
}

/** One review lens's record: computeStats in lib/engine/metrics/stats.ts. */
export interface ReviewerStats {
  reviews: number;
  changes: number;
  blockers: number;
  changeRate: number | null;
  /** Tagged findings the lens raised in its review files. */
  findings: number;
  /** Builder answers `→ fixed` to this lens's findings. */
  fixed: number;
  /** Builder answers `→ disagree:` to this lens's findings. */
  disputes: number;
  /** disputes / (fixed + disputes); null when the builder answered none. */
  disputeRate: number | null;
  /** (lens, path) pairs this lens raised in two consecutive rounds of one job. */
  recurring: number;
  /** Merged jobs this lens reviewed whose escape status is known: a measured human delta or a final outcome. */
  missChecked: number;
  /** Of those, jobs with an escape this lens covered: a revert or follow-up, or a human-delta file in its paths, `when` or `always`. */
  missed: number;
  /** missed / missChecked; null when none is known. */
  missRate: number | null;
  /** Blocker and major findings, where the findings record carries severities. */
  blockerMajor: number;
  /** All findings where the record carries severities: blockerMajor's denominator. */
  severityKnown: number;
  /** blockerMajor / severityKnown; null at 0. */
  blockerMajorShare: number | null;
  /** By the UTC Monday of each job's createdAt, oldest first, the last 12 weeks with findings. */
  severityTrend: { week: string; findings: number; blockerMajor: number; share: number | null }[];
}

/** One verifier's record: computeStats in lib/engine/metrics/stats.ts, from `verifiers` record events. */
export interface VerifierStats {
  /** Records whose results name it. */
  runs: number;
  /** Answers `no`. */
  fails: number;
  /** Answers `none`: no valid answer from the verifier model. */
  unanswered: number;
  /** `no` or `none` in block mode. */
  blocks: number;
  /** fails / runs; null at 0 runs. */
  hitRate: number | null;
}

/** GET /api/stats: computeStats in lib/engine/metrics/stats.ts. */
export interface Stats {
  generatedAt: string;
  since: string | null;
  /** `archived`: how many of `total` were read from .forge/archive/ (lib/core/job/archive.ts). */
  counts: { total: number; active: number; done: number; cancelled: number; failed: number; waiting: number; archived: number };
  waitingOn: Record<string, number>;
  quality: {
    firstPassReviewRate: number | null;
    avgRounds: number | null;
    verifyFirstPassRate: number | null;
    /** Of jobs whose first round-1 verifiers record has results, the share whose outcome was CHANGES. */
    verifierFirstRoundBlockRate: number | null;
    escalationRate: number | null;
    humanFeedbackOnPrRate: number | null;
    humanDeltaRate: number | null;
    medianHumanDeltaLines: number | null;
    humanDeltaCoverage: { merged: number; measured: number };
    /** Reworks a person asked for (`human` events without actor foreman). */
    humanReworks: number;
    /** Every `human` event the foreman recorded. */
    foremanDecisions: number;
    foremanReworks: number;
    specFirstApprovalRate: number | null;
    /** Recurring (lens, path) review findings across every job in the window. */
    recurringFindings: number;
    /** Autonomous jobs (lib/engine/evals/autonomy.ts) over merged jobs with a final outcome. */
    autonomyRate: number | null;
    /** The same, also without a person's approval at a required gate. */
    autonomyRateStrict: number | null;
    revertRate: number | null;
    followUpRate: number | null;
    churnRate: number | null;
    outcomeCoverage: { merged: number; final: number; open: number };
    /** The median post-merge judge score (0-5) over scored jobs (lib/engine/evals/scoring.ts). */
    medianScore: number | null;
    /** `sampled` counts jobs with any score; `merged` is the merged count above. */
    scoreCoverage: { merged: number; sampled: number; scored: number; held: number; failed: number; queued: number };
    /** Scored jobs per builder model (`unknown` when none was recorded). */
    scoreByBuilderModel: Record<string, { scored: number; medianScore: number | null }>;
  };
  speed: { medianMinutesToPr: number | null; medianMinutesToDone: number | null };
  cost: {
    totalTokens: number;
    estCostUsd: number;
    avgTokensPerJob: number | null;
    avgCostPerJobUsd: number | null;
    reportingCoverage: { agentRuns: number; withUsage: number; exact: number };
    byRole: Record<string, UsageRow>;
    byModel: Record<string, UsageRow>;
    /** Supervisor-metered spend by session kind (orchestrator, inbox, office), on or after `since`; {} over a given job list. */
    sessions: Record<string, UsageRow>;
  };
  reviewers: Record<string, ReviewerStats>;
  verifiers: Record<string, VerifierStats>;
}

/** An eval task as served: loadTask in lib/engine/evals/run.ts minus `dir` and `request`. */
export interface EvalTask {
  name: string;
  title: string;
  base: string | null;
  tags: string[];
  check: { patch: string | null; files: string | null; command: string | null };
  rubric: string | null;
  reference: string | null;
  source: { pr: number; url: string; mergeCommit: string | null } | null;
}

/** A graded eval job: gradeJob in lib/engine/evals/run.ts. */
export interface EvalResult {
  check: {
    ran: boolean;
    pass: boolean | null;
    tail: string | null;
    reason?: string;
    /** Paths whose candidate version was replaced by the base before the hidden patch applied. */
    replaced?: string[];
  };
  judge: { score: number; outOf: number } | null;
  decision: string | null;
  rounds: number;
  firstPass: boolean | null;
  verifyFirstPass: boolean | null;
  tokens: number;
  estCostUsd: number;
  minutes: number | null;
  gradedAt: string;
  /** Minutes per stage the job entered: jobTiming in lib/engine/evals/stats.ts. Absent on results graded before it. */
  stages?: Partial<Record<Stage, number>>;
  /** Agent-run time, summed across parallel agents. */
  agentMinutes?: number | null;
  /** Wall time when no agent was running. */
  orchestratorMinutes?: number | null;
  reviewerRuns?: number;
  /** round > maxRounds at grade time: B6b sent it to decide. Absent on results graded before it. */
  roundsExhausted?: boolean;
}

/** Aggregates over a run's graded tasks: summarize in lib/engine/evals/run.ts. */
export interface EvalSummary {
  tasks: number;
  graded: number;
  checkPassRate: number | null;
  avgJudgeScore: number | null;
  firstPassRate: number | null;
  avgRounds: number | null;
  escalationRate: number | null;
  roundsExhaustedRate: number | null;
  avgTokens: number | null;
  avgCostUsd: number | null;
  avgMinutes: number | null;
  avgAgentMinutes: number | null;
  avgOrchestratorMinutes: number | null;
  avgReviewerRuns: number | null;
}

/** A sample's size and spread: stat in lib/engine/evals/stats.ts. */
export interface EvalStat {
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}

/** Two means and the sample count behind each: delta in lib/engine/evals/stats.ts. */
export interface EvalDelta {
  a: number | null;
  b: number | null;
  change: number | null;
  na: number;
  nb: number;
}

/** The per-task metrics: TASK_METRICS in lib/engine/evals/stats.ts. */
export type EvalTaskMetric = 'checkPass' | 'judgeScore' | 'firstPass' | 'rounds' | 'tokens' | 'costUsd' | 'minutes' | 'agentMinutes' | 'orchestratorMinutes' | 'reviewerRuns';

/** One task's repeats in a run: aggregateTasks in lib/engine/evals/stats.ts. */
export interface EvalTaskAggregate {
  task: string;
  runs: number;
  graded: number;
  metrics: Record<EvalTaskMetric, EvalStat>;
  stages: Record<string, EvalStat>;
}

/** An eval run record: startRun and gradeJob in lib/engine/evals/run.ts, with summary filled by listRuns. */
export interface EvalRun {
  schemaVersion: number;
  id: string;
  label: string | null;
  forgeVersion: string;
  configHash: string;
  /** The plugin's prompt and pipeline hash: pluginHash in lib/engine/evals/run.ts. Null on records before it. */
  pluginHash?: string | null;
  overlay?: EvalOverlay;
  repeat?: number;
  models: Record<string, string>;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done';
  tasks: { task: string; job: string; worktreeOk: boolean; result: EvalResult | null; repeat?: number }[];
  summary: EvalSummary;
  /** Filled by listRuns. */
  perTask?: EvalTaskAggregate[];
}

/** GET /api/evals: the handler in lib/server/routes/misc.ts over listTasks/listRuns in lib/engine/evals/run.ts. */
export interface EvalsResponse {
  tasks: EvalTask[];
  runs: EvalRun[];
}

/** GET /api/evals/compare: compareRuns in lib/engine/evals/run.ts. */
export interface EvalCompare {
  a: EvalCompareSide;
  b: EvalCompareSide;
  delta: Record<keyof EvalSummary, EvalDelta>;
  /** Mean minutes per stage over the graded jobs that entered it. */
  stages: Record<string, EvalDelta>;
  perTask: {
    task: string;
    a: boolean | null;
    b: boolean | null;
    stats: { a: EvalTaskAggregate | null; b: EvalTaskAggregate | null };
    delta: Record<EvalTaskMetric, EvalDelta>;
  }[];
  /** Post-merge scores of real jobs merged in the 14 days before each run started (lib/engine/evals/scoring.ts). */
  realJobs: { a: RealJobScores; b: RealJobScores };
}

/** Real jobs' post-merge scores over a window: realJobScores in lib/engine/evals/run.ts. avgScore is 0-1, as avgJudgeScore. */
export interface RealJobScores {
  from: string;
  to: string;
  scored: number;
  medianScore: number | null;
  avgScore: number | null;
}

/** One run's stamps in a comparison. */
export interface EvalCompareSide {
  id: string;
  configHash: string;
  forgeVersion: string;
  pluginHash: string | null;
  overlay: EvalOverlay;
  repeat: number;
}
