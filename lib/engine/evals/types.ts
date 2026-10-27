// The notes layer's shapes, type-only: learnings and experiment entries and what `forge experiment` prints,
// and the retro's transcript stats (transcripts.json) and digest batches.
import type { Effort } from '#core/types.ts';
import type { RunCounts } from '#integrations/claude/types.ts';

/** One agent run in transcripts.json: its job, role, per-role run number and agent id, and its friction counts. */
export interface TranscriptRun extends RunCounts {
  job: string;
  role: string;
  /** 1, 2, … per role, in start order. */
  run: number;
  agentId: string;
  /** The job's tasks.md checkboxes. */
  tasks: number;
  /** turns / max(1, tasks), to 2 places. */
  turnsPerTask: number;
  /** max(0, job.round - 1). */
  reworkRounds: number;
}

/** A role's totals in transcripts.json; repeatedFailures, rereadFiles and forgeNonZero count list entries. */
export interface TranscriptRoleTotals {
  runs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  repeatedFailures: number;
  permissionDenials: number;
  rereadFiles: number;
  forgeNonZero: number;
}

/** transcripts.json: `forge retro prepare`'s transcript stats. Counts, ids and keys only: never transcript text or a path. */
export interface TranscriptStats {
  since: string | null;
  mandate: string | null;
  /** improve.transcripts.max. */
  max: number;
  /** Agent runs in scope, after a resumed agent's earlier runs are dropped. */
  runs: number;
  /** Runs whose transcript was found and read. */
  read: number;
  /** Runs past the per-prepare cap, oldest first. */
  skipped: number;
  byRole: Record<string, TranscriptRoleTotals>;
  /** Sorted by job id, role, run. */
  perRun: TranscriptRun[];
  /** The runs digest agents read in depth, worst first, with their batch. */
  deepRead: { job: string; role: string; run: number; batch: number }[];
}

/** One digest agent's batch in `forge retro prepare`'s output: what the orchestrator spawns. */
export interface DigestBatch {
  batch: number;
  runs: number;
  /** `<job dir>/digest/batch-<n>.md`. */
  input: string;
  /** `<job dir>/friction-<n>.md`. */
  output: string;
  subagent: 'forge:digest';
  model: string;
  effort: Effort | null;
  brief: string;
}

/** One entry of `.forge/notes/learnings.md`: parseLearnings in lib/engine/evals/learnings.ts. Dates are valid or null. */
export interface LearningEntry {
  /** Unsanitised; callers pass it through safeText before writing it anywhere. */
  rule: string;
  experiment: string | null;
  reviewBy: string | null;
  added: string | null;
}

/** One line of `.forge/notes/experiments.md`: parseExperiments in lib/engine/evals/learnings.ts. */
export interface ExperimentEntry {
  id: string | null;
  date: string | null;
  change: string;
  metric: string | null;
  direction: 'up' | 'down' | null;
  baseline: number | null;
  /** The baseline's sample size: the denominator of a `0.344 (11/32)` baseline, else null. */
  baselineN: number | null;
  status: string | null;
}

/** One `forge experiment evaluate` result (lib/engine/evals/experiments.ts). */
export interface ExperimentResult {
  id: string | null;
  metric: string | null;
  direction: 'up' | 'down' | null;
  baseline: number | null;
  baselineN: number | null;
  /** Done or cancelled non-eval, non-retro jobs created after the entry's date; null when nothing was computed. */
  jobsAfter: number | null;
  /** After-jobs with a value for the metric. */
  n: number | null;
  /** The mean of the per-job values. */
  value: number | null;
  method: 'two-proportion' | 'wilson' | 'bootstrap' | null;
  /** The difference from the baseline, [lo, hi], rounded to 3 decimals. */
  interval: [number, number] | null;
  verdict: 'kept' | 'reverted' | 'inconclusive' | 'pending' | 'settled';
  /** The entry's status segment after the run (with --dry-run: what the run would leave). */
  status: string | null;
  reason: string | null;
}

/** `forge experiment evaluate`: the target ledger and every entry's result. */
export interface ExperimentEvaluation {
  file: string;
  dryRun: boolean;
  written: number;
  entries: ExperimentResult[];
}

/** `forge experiment check`: problems in the notes layer. */
export interface NotesCheck {
  ok: boolean;
  problems: { file: string; entry: string; problem: string }[];
}
