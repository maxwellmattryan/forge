// The notes layer's shapes, type-only: learnings and experiment entries and what `forge experiment` prints.

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
