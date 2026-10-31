// What `forge job step` reads and prints, and the verifier shapes, type-only: step/ is at its entry cap, so they live here.
import type { AcCoverage } from './acs.ts';
import type { BackingRecord, EnvironmentState } from '../environment/types.ts';
import type { Config } from '#core/config/types.ts';
import type { Effort, Job, JobEvent, JobState, WaitingOn } from '#api/types.ts';
import type { ResumeSkip } from './step/facts.ts';

/** What a `wait` waits on: a gate, or the agents still running. */
export type StepWaitingOn = WaitingOn | 'agents';

interface StepBase {
  id: string;
  /** The rule in lib/engine/pipeline/step/rules.ts RULES that chose this action. */
  rule: string;
}

/** Spawn one agent: run `start` (argv after `forge`), spawn `agent` with `model` and `brief`, then `agent end`. */
export interface StepSpawn extends StepBase {
  action: 'spawn';
  role: string;
  agent: string;
  lens?: string;
  model: string;
  round: number;
  output?: string;
  retry?: true;
  /** The session the run continues: N2's and IG10b's answered agent, or a rework spawn's role's last run (reworkResume). */
  resume?: string;
  /** Why a rework spawn of a role that ran before does not resume (reworkResume in step/facts.ts); absent on a role's first run. */
  resumeSkipped?: ResumeSkip;
  parallel?: true;
  start: string[];
  startShell: string;
  brief: string;
  /** The Agent tool's `effort`: the job's effective level (resolveEffort), or null to pass none. */
  effort: Effort | null;
  /** RV4 and RV10: the round's other unstarted lenses, each a complete spawn; launch them with this one. */
  spawns?: StepSpawn[];
  /** RV10 only: why only part of the recorded panel reviews this round. */
  why?: string;
}

/** Run one forge command: `command` is argv after `forge`, `shell` the same as one quoted line. */
export interface StepRun extends StepBase {
  action: 'run';
  command: string[];
  shell: string;
  why: string;
  tell?: string;
}

/** Wait on agents or a human gate; `tell` is what to report. */
export interface StepWait extends StepBase {
  action: 'wait';
  waitingOn: StepWaitingOn;
  running: string[];
  tell?: string;
}

/** Follow a reference procedure the CLI does not decide (split children, PR continuation, retro). */
export interface StepProcedure extends StepBase {
  action: 'procedure';
  reference: string;
  why: string;
}

/** Nothing more to drive. */
export interface StepDone extends StepBase {
  action: 'done';
  state: JobState;
  tell?: string;
}

/** What `forge job step` prints. */
export type StepAction = StepSpawn | StepRun | StepWait | StepProcedure | StepDone;

/** The round's or integration review's verdicts as step reads them: roundVerdicts in lib/core/job/store.ts. */
export interface StepVerdicts {
  complete: boolean;
  outcome: string;
  reviewers: Record<string, { verdict: string }>;
}

/** Everything `step` decides from, read once by loadStepInput in lib/engine/pipeline/step/input.ts. */
export interface StepInput {
  job: Job;
  config: Config;
  root: string;
  jobDir: string;
  pluginRoot: string;
  /** jobPathMap in lib/engine/pipeline/brief.ts. */
  paths: Record<string, unknown>;
  /** Which job files exist, by name. */
  files: Record<StepFile, boolean>;
  /** The absolute paths in `paths` that exist, for brief inputs. */
  present: string[];
  worktreeExists: boolean;
  /** A member repo on the job has no worktree yet (step RP2). */
  memberWorktreesMissing: boolean;
  /** requestBody(): its length and the lines that start with a list marker or a heading. */
  request: { length: number; listLines: number };
  plan: { verdict: 'SINGLE' | 'SPLIT' | null; jobs: number; recommendSplit: boolean };
  /** spec.md's header lines and Approach paths; suggested names and services are raw, step filters them. `uiAcs`: specUiAcs, the builder's `UI proof:` line. */
  /** `split`: the header's `Split: yes`, the spec-writer's answer to the split check (SP8 reads it only while splitCheck holds). */
  spec: { size: string | null; complexity: string | null; needsDesign: boolean; components: string[]; suggested: string[]; approachPaths: string[]; uiAcs: string[]; split: boolean };
  /** design.md's `## Spec deltas` section is non-empty and not None. */
  designDeltas: boolean;
  /** decision.md's first line. Its Auto-merge eligible line is not here: only the recorded decision event counts (lib/engine/pr/eligible.ts). */
  decision: { decision: string | null };
  /**
   * At stage pr with auto-merge on and an eligible recorded decision: whether every job repo's
   * worktree HEAD still follows the head it was decided on (decisionCurrent); null otherwise.
   */
  decisionCurrent: boolean | null;
  /**
   * At stage pr, for a mandate job with an open PR while Forge merges (autoMerge): the ready PR ranked ahead of it
   * in its overlap group, which merges first (mergeHold, lib/engine/pipeline/moves/merge-queue.ts); null otherwise.
   */
  mergeAhead: string | null;
  /**
   * At stage decide or pr, state running, for a non-eval job: whether every job repo's HEAD still
   * follows the head the round's review was given (reviewCurrent); null otherwise, or when the round
   * has no recorded review.
   */
  reviewCurrent: boolean | null;
  /**
   * The `outcome` the CLI logged on the round's last `verdicts` event, when the whole panel's review ended; null when
   * the round has none. The clean pass reads it beside the lens verdicts, which a later edit of `job.reviewers` can narrow.
   */
  panelOutcome: string | null;
  /**
   * Earlier round (as a string) → the validated sha its review saw (reviewedSha in
   * lib/engine/pipeline/scope.ts), for a round 2+ reviewer brief's `Changed since:` line. Only at stage
   * review, round ≥ 2, no open PR, no reviewed member, with a worktree; `{}` otherwise.
   */
  reviewedShas: Record<string, string>;
  verdicts: { round: StepVerdicts | null; integration: StepVerdicts | null };
  acs: AcCoverage;
  /**
   * At stage build with a worktree and a spec: the folder maps over the spec's file-map paths and the
   * topics their `Design:` bullets link, as absolute paths (folderMaps in lib/engine/pipeline/step/input.ts),
   * for the fresh builder brief's `Maps (JSON)` line; null at every other stage.
   */
  folderMaps: { maps: string[]; topics: string[]; more?: number } | null;
  /**
   * The instruction files the branch's committed diff changed (changedInstructionFiles), sorted, for
   * the brief's `Instructions changed by this branch` line: null means the diff could not be read,
   * `[]` means none changed or the job has no worktree yet.
   */
  instructionsChanged: string[] | null;
  /** The record names in runtime.json. */
  runtime: string[];
  /** The job's entry in the environment record (lib/engine/environment/record.ts); null when it has none. */
  environment: EnvironmentState | null;
  /** The events step reads, oldest first: human, round, worktree*, pr-*, scope, integrate*, integration-review, decision, fields, eval-graded, transition, agent-start/end. */
  events: JobEvent[];
  evalTask: { rubric: string | null; reference: string | null } | null;
  /** Checklist path per panel lens and selected reviewer. */
  checklists: Record<string, string | null>;
  /**
   * In integrate: what the last conflict episode's resolution changed at the last verified sha
   * (lib/engine/pipeline/scope.ts integrationTouched), keyed by the sides that event recorded; null when unknown.
   */
  integrationTouched: { head: string; upstream: string; sha: string; files: string[] | null } | null;
  /**
   * The recall eval gate (lib/engine/pipeline/step/input.ts loadRecall): whether the committed diff touches
   * evals.recall.paths, and the worktree's pluginHash a recorded run must match. `invalidFixtures`
   * when the gate is required but a main-checkout fixture does not load, so `start` cannot run, RC1
   * skips the eval and PR17 holds the merge. Null outside decide and pr, for an eval job, without a
   * worktree, or when the main checkout has no recall fixture.
   */
  recall: { required: boolean; pluginHash: string | null; invalidFixtures?: true } | null;
  /** How many `.forge/verifiers/*.md` entries the main checkout has: 0 keeps the verify stage as it was. */
  verifiers: number;
  /** The job's and the project's backing port records, for the brief's Backing services line; absent without backing entries. */
  backing?: { job: BackingRecord; shared: BackingRecord };
  /** loadStepInput's clock, ISO: step reads no other (the repo-budget tell names its period from it). */
  now: string;
  /** jobEndpoints' components, for a reviewer brief's Endpoints line; empty without `commands.dev`. */
  endpoints: { name: string; url: string }[];
  /** trustedMemberWorktree per member repo, never job.json's `worktree`: a reviewer brief's Lens repo line. */
  memberWorktrees: Record<string, string | null>;
  /** While the job waits on `budget`: the keys still over their limit after acks (`forge job budget`'s stillExceeded); null otherwise. */
  budgetExceeded: string[] | null;
  /**
   * At stage build or review: each rework role's (`builder`, `reviewer:*`) last run as a session `claude --resume` could
   * continue (loadLastSessions in lib/engine/pipeline/step/input.ts): its uuid, whether its transcript is in the job's
   * own worktree project dir, and its last context from the runner's sidecar (null when unknown). A role with no runner
   * sidecar naming it has no entry; `{}` at every other stage.
   */
  lastSessions: Record<string, { session: string; transcript: boolean; context: number | null }>;
  /**
   * A backlog retro job's start (the K rows): whether `forge retro prepare` wrote stats.json, and the digest batches it
   * wrote (`digest/batch-<n>.md`, regular files in a real `digest/` dir), ascending. null for any other job or stage.
   */
  retro: { stats: boolean; batches: number[] } | null;
}

/** The job files StepInput.files records. */
export type StepFile = 'request' | 'plan' | 'spec' | 'design' | 'mockup' | 'build' | 'tasks' | 'questions' | 'feedback' | 'prFeedback' | 'runbook' | 'decision' | 'scope' | 'issueCandidates' | 'evalJudge' | 'score';

/** One valid `.forge/verifiers/<name>.md`: loadVerifiers in lib/engine/pipeline/verifiers.ts. */
export interface Verifier {
  name: string;
  /** Globs matched with inSpec (lib/core/glob.ts). */
  paths: string[];
  severity: 'blocker' | 'major' | 'minor';
  mode: 'warn' | 'block';
  /** The body's first non-empty line, on one line: yes means the change is fine. */
  question: string;
  /** The whole trimmed body after the frontmatter. */
  body: string;
}

/** A verifier file that never runs: loadVerifiers. */
export interface VerifierProblem {
  file: string;
  problem: string;
}

/** What `forge verifiers list` prints (without the bodies): loadVerifiers. */
export interface VerifierSet {
  dir: string;
  verifiers: Verifier[];
  problems: VerifierProblem[];
}

/** What `forge verifiers run` returns: verifiersRun in lib/engine/pipeline/verifiers.ts. */
export interface VerifiersRun {
  id: string;
  round: number;
  sha: string;
  selected: string[];
  problems: number;
  truncated: boolean;
  /** PASS when nothing matched and the report is already written; null while the verifier agent has to answer. */
  outcome: 'PASS' | null;
  file: string;
}

/** A selected verifier's answer: parseAnswers in lib/engine/pipeline/verifiers.ts; `none` fails closed. */
export type VerifierAnswer = 'yes' | 'no' | 'none';

/** What `forge verifiers record` returns: verifiersRecord in lib/engine/pipeline/verifiers.ts. */
export interface VerifiersRecord {
  id: string;
  round: number;
  outcome: 'PASS' | 'CHANGES';
  blocking: number;
  warned: number;
  /** Block-mode verifiers answered NO or not at all. */
  failed: string[];
  file: string;
  budget?: { stopped: true; reason: string; exceeded: unknown[] };
}
