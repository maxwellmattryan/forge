// A job as job.json and events.jsonl hold it, as /api/state and /api/jobs/:id serve it.
import type { ActorSource, BudgetKey, Complexity, Effort, GateClass, HandoffClass, InterimStrategy, JobState, Stage, WaitingOn } from './enums.ts';

/**
 * One of a job's issues: lib/core/job/issue-ref.ts. `tracker` is the tracker kind; `ref` is `owner/repo#12`
 * for GitHub (a bare number only in legacy jobs), the slug for the local backlog, or a custom
 * adapter's own ref. A null ref keeps a url-only entry, which never counts as linked.
 */
export interface JobIssue {
  tracker: string;
  ref: string | null;
  url: string | null;
}

/** GitHub check rollup: summarizeChecks in lib/integrations/github/pull-requests.ts. */
export interface PrChecks {
  state: 'passing' | 'failing' | 'pending' | 'none';
  passing: number;
  failing: number;
  pending: number;
}

/** Commits humans pushed after Forge: measureOnMerge in lib/engine/pr/sync.ts (shape from lib/engine/pr/delta.ts). */
export interface HumanDelta {
  status: 'measured' | 'rewritten' | 'unavailable';
  reason?: string;
  commits: number | null;
  linesAdded: number | null;
  linesDeleted: number | null;
  lines: number | null;
  fileCount: number | null;
  files: string[];
  base?: string | null;
  head?: string | null;
  measuredAt?: string;
  attempts?: number;
}

/** What happened to a merged job inside its window: measureOutcome in lib/engine/evals/outcome.ts. */
export interface JobOutcome {
  status: 'open' | 'final';
  windowDays: number;
  mergedAt: string;
  closesAt: string;
  mergeSha: string | null;
  reverted: boolean | null;
  revertedBy: { kind: 'commit'; sha: string } | { kind: 'pr'; number: number } | null;
  followUps: number | 'unsupported' | null;
  followUpRefs: string[];
  churn: { commits: number; lines: number; files: number } | null;
  measuredAt: string;
  attempts: number;
  reason?: string;
}

/** A merged job's post-merge judge score (sampled, or in a mandate that scores all): queueScores and recordScore in lib/engine/evals/scoring.ts. */
export interface JobScore {
  status: 'queued' | 'held' | 'scored' | 'failed';
  /** null when held */
  queuedAt: string | null;
  /** 0-5, one decimal at most; only when scored */
  value: number | null;
  outOf: 5;
  /** when held, scored or failed was set */
  recordedAt: string | null;
  judgeModel: string | null;
  builderModel: string | null;
  reason?: 'budget exceeded' | 'repo budget' | 'no score.md' | 'malformed score.md';
}

/** A job's pull request: findPr, openPr and syncPr in lib/engine/pr/{adopt,open,sync}.ts; sync-only fields are optional. */
export interface JobPr {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  lastSyncedAt: string;
  openedAt?: string;
  pushedSha?: string | null;
  mergeable?: string;
  mergeState?: string;
  headOid?: string | null;
  reviewDecision?: string | null;
  checks?: PrChecks;
  behindBy?: number | null;
  conflicts?: boolean;
  unresolvedThreads?: number;
  changesRequested?: number;
  mergedAt?: string | null;
  humanDelta?: HumanDelta;
  /** The head sha forge sync last moved to integrate, so it routes each head once. */
  integrateFor?: string;
  /** The failing checks syncPrDetailed in lib/engine/pr/sync.ts last read; absent on a job not synced since it was recorded. */
  failingChecks?: PrFailingChecks;
  /**
   * Reviews and conversation comments by people with write access since the job's latest round, PR
   * open or PR update: syncPrDetailed in lib/engine/pr/sync.ts. Absent on a job not synced since it was recorded.
   */
  feedbackSinceRound?: number;
}

/** A PR's failing checks as sync recorded them: at most 5 CHECK_NAME names, the rest counted in `more`, and how many are GitHub Actions jobs in the PR's own repo (which Forge could re-run). */
export interface PrFailingChecks {
  names: string[];
  more: number;
  actions: number;
}

/**
 * The fenced claim on a job: claimJob, renewLease, expireLease and releaseJob in lib/core/job/store.ts. `epoch`
 * grows by one at every change of driver and never goes back, so a write fenced with an older one is
 * a driver that was taken over.
 */
export interface JobLease {
  /** The driving session; null when nobody holds the job. */
  driver: string | null;
  epoch: number;
  /** When this driver first claimed it. */
  since: string | null;
  renewedAt: string | null;
  /** Live while in the future; the supervisor sets it to now when the driver's process exits. */
  expiresAt: string | null;
}

/** `none` without a driver; `expired` with one whose expiresAt has passed. */
export type OwnerStatusKind = 'none' | 'live' | 'expired';

/** Whether a job's lease still holds: leaseStatus in lib/core/job/store.ts. */
export interface OwnerStatus {
  status: OwnerStatusKind;
  session: string | null;
  since: string | null;
  renewedAt: string | null;
  expiresAt: string | null;
  epoch: number;
  /**
   * The driver is this job's own pool session and it runs: a `resume` reaches that session, which
   * claims as itself, so its live lease doesn't block it. Set only in the job detail and the resume
   * guard, from the pool; false in /api/state.
   */
  jobSession: boolean;
}

/** One orchestrator session's stint on a job: claimJob/releaseJob in lib/core/job/store.ts. */
export interface JobRun {
  session: string;
  startedAt: string;
  endedAt?: string;
}

/** Per-role agent record: recordAgent in lib/core/job/store.ts. */
export interface JobAgent {
  runs: number;
  status?: string;
  model?: string | null;
  agentId?: string | null;
  startedAt?: string;
  endedAt?: string | null;
  round?: number;
  summary?: string;
  /**
   * Per agent id, the last transcript timestamp `--import` has recorded. A resumed agent appends to
   * the same transcript, so the next import counts only what comes after it.
   */
  importedThrough?: Record<string, string>;
  /** The role's single output, job-dir-relative: `agent start --output` or the role's default. */
  output?: string | null;
  /** `agent end` found no output written since this run started. */
  outputMissing?: boolean;
  /** This run is the one retry after a missing or malformed output: `agent start --retry`. */
  retry?: boolean;
  /** The role's ended runs, oldest first, at most MAX_AGENT_RUNS: recordRun in lib/core/job/schema.ts. */
  runHistory?: AgentRun[];
  /** Runs that ended before runHistory existed, set by the `agent-run-history` job step: agentRuns rebuilds them from events. */
  legacyRuns?: number;
}

/** One run's billing split, as addUsage added it: runBilling in lib/core/job/schema.ts. */
export interface RunBilling {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** The run's total; more than the four counts for a self-reported (`--tokens`) run. */
  totalTokens: number;
}

/** One named share of a context composition. */
export interface ContextPart {
  name: string;
  tokens: number;
}

/**
 * What filled a run's context at its last request, estimated from its transcript: composeContext in
 * lib/engine/metrics/composition.ts. The parts sum to `total`.
 */
export interface ContextComposition {
  /** The last request's input + cache read + cache write (exact). */
  total: number;
  /** The start prefix's role prompt and brief, estimated from their text. */
  forgePrompt: number;
  /** The start prefix minus forgePrompt: Claude Code's system prompt, tools, MCP and skills. */
  harness: number;
  /** Earlier runs of a resumed transcript; 0 when fresh. */
  carried: number;
  /** Tool results by tool name, MCP as `mcp:<server>`; at most MAX_TOOL_PARTS named plus `other`, largest first. */
  tools: ContextPart[];
  assistant: number;
  user: number;
}

/** One ended run of a role: recordRun in lib/core/job/schema.ts (recorded), or agentRuns in lib/engine/metrics/runs.ts (legacy, from events). */
export interface AgentRun {
  /** null for a legacy run. */
  round: number | null;
  startedAt: string | null;
  endedAt: string | null;
  status: string | null;
  model: string | null;
  /** null when the run recorded no usage (lost, or unmeasured in a daemon session). */
  usage: RunBilling | null;
  /** null when the run imported no transcript, or ended before compositions were recorded. */
  composition: ContextComposition | null;
}

/** One role's or model's usage totals: addUsage in lib/core/job/store.ts. */
export interface UsageBucket {
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  toolUses: number;
  durationMs: number;
  runs: number;
  estCostUsd: number;
}

/** A job's token and cost totals: normalizeJob in lib/core/job/schema.ts and addUsage in lib/core/job/store.ts. */
export interface JobUsage {
  totalTokens: number;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  estCostUsd: number;
  exact: boolean;
}

/** Budget limits per key; null means unlimited: defaults().pipeline.budget in lib/core/config/load.ts. */
export type BudgetLimits = Partial<Record<BudgetKey, number | null>>;

/** What a job has spent per key: measureBudget in lib/engine/metrics/budget.ts. */
export type BudgetUsed = Record<BudgetKey, number | null>;

/** Per-job budget state: enforceBudget and budgetCmd in lib/engine/metrics/budget.ts. */
export interface JobBudget {
  limits: BudgetLimits;
  ack: Partial<Record<BudgetKey, { used: number; round: number }>>;
  lastCheck: { at: string; checkpoint: string; used: BudgetUsed } | null;
}

/** One verify attempt: verify in lib/engine/verify/gate.ts. */
export interface VerifyRun {
  round: number;
  attempt: number;
  sha: string | null;
  ok: boolean;
  at: string | null;
  file: string;
  /** The name of the step that failed (`test`, `integrity`, `secrets`, `protected`, …), null on a pass. */
  failure?: string | null;
  /** One record per member repo, only when the job has members: verify in lib/engine/verify/gate.ts. */
  repos?: VerifyRunRepo[];
}

/** One member repo's part of a verify run: the HEAD it checked and its first failing step. */
export interface VerifyRunRepo {
  repo: string;
  sha: string;
  ok: boolean;
  failure: string | null;
}

/** A job repo's PR: a JobPr whose url is null when `gh` gave anything but an https url. */
export type JobRepoPr = Omit<JobPr, 'url'> & { url: string | null };

/**
 * One repo a job changes: `repos[0]` is the root repo (`repo: null`), mirrored from the top-level
 * branch/base/worktree/pr by normalizeJob; later entries are member repos (lib/engine/project/job-repos.ts).
 */
export interface JobRepo {
  repo: string | null;
  worktree: string | null;
  /** The job's branch, derived on every load; null for a verify-only member. */
  branch: string | null;
  base: string | null;
  pr: JobRepoPr | null;
  /** Verified with the job but never branched, pushed or given a PR. */
  verifyOnly: boolean;
  /** The human's interim strategy for this repo as a dependency (`forge job repo interim`); null inherits config. repos[0] mirrors `Job.interim`. normalizeJob always sets it. */
  interim?: InterimStrategy | null;
}

/** A reviewer's settled verdict for a round: `verdicts` in lib/cli/commands/job/review.ts (via roundVerdicts in lib/core/job/store.ts). */
export type Verdict = 'PASS' | 'CHANGES' | 'MALFORMED';

/** A job record: normalizeJob in lib/core/job/schema.ts. */
export interface Job {
  schemaVersion: number;
  id: string;
  title: string;
  kind: string;
  size: string | null;
  /** The job's issues, primary first; one issue may sit on several jobs: lib/engine/trackers/link.ts. */
  issues: JobIssue[];
  /** The human's decision that the job needs no issue, cleared by linking one: `forge job link --none` in lib/engine/trackers/link.ts. */
  noIssue: { reason: string | null; at: string } | null;
  parent: string | null;
  children: string[];
  dependsOn: string[];
  /**
   * The configured components Forge acts on (`jobComponent`, ports, verify's commands, the Project page): the
   * declared list until `forge verify` recomputes it from the diff (lib/engine/verify/components.ts).
   */
  components: string[];
  /** The estimate: the spec's `Components:` list (SP3) or `forge job new --components`; null until one is recorded. */
  componentsDeclared: string[] | null;
  /** The last recompute from the committed diff; null before the first. Only `forge verify` writes it. */
  componentsFromDiff: string[] | null;
  /**
   * Whether the last recompute found changed files in the root repo that no root component covers. Then
   * `jobComponent` selects none, so the top-level commands run, however many components matched. Only
   * `forge verify` writes it.
   */
  componentsUnmatched: boolean;
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
  reason: string | null;
  branch: string | null;
  base: string | null;
  worktree: string | null;
  /** The first port-bearing component's port (what `{port}`, the dev server and the live dot use): lib/engine/environment/ports.ts. */
  port: number | null;
  /** One port per service or app component (`dev` when the repo has none), allocated with the worktree: lib/engine/environment/ports.ts. */
  ports: Record<string, number>;
  round: number;
  maxRounds: number;
  reviewers: string[];
  /** Round number (as a string key) to reviewer name to verdict. */
  verdicts: Record<string, Record<string, Verdict>>;
  /** Legacy per-round result kept beside verifyRuns. */
  verify: Record<string, 'PASS' | 'FAIL'>;
  verifyRuns: VerifyRun[];
  verifyRetries: Record<string, number>;
  budget: JobBudget;
  decision: string | null;
  pr: JobPr | null;
  lease: JobLease;
  agents: Record<string, JobAgent>;
  usage: JobUsage;
  runs: JobRun[];
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  eval: { run: string; task: string; repeat?: number; overlay?: EvalOverlay } | null;
  /** `never` when the planner must not split this job (from-ref, revise-split); null follows pipeline.split. */
  splitMode: 'never' | null;
  /** The human's reasoning effort for this job (`forge job effort`); null inherits runtime.effort. */
  effort: Effort | null;
  /**
   * The mandate this job works under (`forge job new --mandate`, or its split parent's), which narrows
   * the gates the Foreman may decide for it; null when it is in none. Locked once set.
   */
  mandate: string | null;
  /** The spec's `Complexity:` header, recorded at SP3; picks runtime.effortByComplexity. */
  complexity: Complexity | null;
  /** Escalate paths the branch changes, recorded by the CLI only: recordProtected in lib/engine/guard/protected.ts. */
  protectedPaths: ProtectedPaths | null;
  /** The human's interim strategy for the root repo as a dependency (`forge job repo interim --root`); null inherits config. */
  interim: InterimStrategy | null;
  /** The root repo first, then member repos: `forge job repo add|remove` in lib/engine/project/job-repos.ts. */
  repos: JobRepo[];
  /** The merged root PR's post-merge outcome, written by `forge sync` (lib/engine/evals/outcome.ts); null until measured. */
  outcome: JobOutcome | null;
  /** The post-merge judge score of a merged job, sampled or in a mandate that scores all (lib/engine/evals/scoring.ts); null until forge sync queues one. */
  score: JobScore | null;
  /** Why and from where a person shelved the job (`forge job shelve`); non-null only while it waits on `shelved`. */
  shelved: JobShelf | null;
  /**
   * True when the job was cancelled or set done while shelved (a cancel, Close in the Shelved list, a
   * merge or close on GitHub), and only while it stays done or cancelled: only a person's grant moves it back to work.
   */
  finishedWhileShelved: boolean;
}

/** A shelved job's record: shelveJob in lib/engine/pipeline/moves/shelve.ts, cleanShelf in lib/core/job/schema.ts. */
export interface JobShelf {
  /** When it was shelved. */
  at: string;
  /** The person's reason: one line of 1 to 200 characters, with no control characters or backticks. */
  reason: string;
  actor: EventActor;
  /** Where un-shelving puts it back. */
  from: {
    state: 'waiting' | 'queued' | 'failed' | 'blocked';
    /** Never `shelved`; non-null exactly when `state` is `waiting`. */
    waitingOn: WaitingOn | null;
    reason: string | null;
  };
}

/** A changed path an escalate rule matched; `rule` is 1-based and `blob` is null for a deletion. */
export interface ProtectedHit {
  path: string;
  rule: number;
  glob: string;
  reason: string;
  blob: string | null;
  /** The member repo a `<repo>:<path>` hit came from; absent for a root hit. */
  repo?: string;
}

/** job.protectedPaths: the escalate paths that need a human approval given after `at`. */
export interface ProtectedPaths {
  hits: ProtectedHit[];
  more: number;
  at: string;
  gate: 'add' | 'commit' | 'verify' | 'pr';
  head: string | null;
  /** sha256 over every (path, blob) of the set, `more` included; absent on a flag from before it. */
  digest?: string;
}

/** tasks.md checkbox counts: progress in lib/core/job/store.ts. */
export interface Progress {
  done: number;
  total: number;
}

/** One member repo an agent proposed for a job (lib/engine/project/repo-proposals.ts), as repo-proposals.json lists it. */
export interface RepoProposal {
  repo: string;
  reason: string;
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  actor: EventActor | null;
  note: string | null;
}

/** The stage/state pair a transition event records: setJob in lib/core/job/store.ts. */
export interface TransitionSide {
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
}

/** Usage an agent reported at agent-end: `agent` in lib/cli/commands/job/agent.ts (transcript fields from importClaudeCodeTranscript in lib/engine/metrics/usage.ts). */
export interface AgentUsage {
  model?: string | null;
  outputEstimated?: boolean;
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  toolUses?: number;
  durationMs?: number;
  exact?: boolean;
}

/** One events.jsonl line: logEvent in lib/core/job/store.ts; open-ended because event types are. */
export interface JobEvent {
  v: number;
  ts: string;
  type: string;
  from?: TransitionSide | string | null;
  to?: TransitionSide | string | null;
  reason?: string | null;
  role?: string;
  model?: string | null;
  usage?: AgentUsage;
  /** agent-end since event v7: the agent ended inside its job's own daemon session, whose meter already holds its cost. */
  metered?: boolean;
  /** agent-end since event v7: a daemon session's end whose transcript wasn't found, recorded with no usage. */
  unmeasured?: boolean;
  summary?: string;
  name?: string;
  ok?: boolean;
  exit?: number | null;
  durationMs?: number;
  text?: string;
  action?: string;
  note?: string | null;
  /** On human-action events (lib/integrations/github/actor.ts): who acted, best effort and unauthenticated. */
  actor?: EventActor;
  /** agent-start since event v3 (lib/engine/evals/provenance.ts): the running plugin's 10-hex hash. */
  pluginHash?: string | null;
  /** agent-start since event v3: the role's 12-hex hash as `forge roster` reports it; null for a role with no agent file. */
  promptHash?: string | null;
  /** agent-start since event v3: the 10-hex hash of the repo layer and the job's effective config; null when the config could not be built. */
  configHash?: string | null;
  [key: string]: unknown;
}
/** A Foreman hand-off still standing at the job's current park: foremanHandoff in lib/office/foreman/policy.ts. */
export interface ForemanHandoff {
  gate: GateClass;
  class: HandoffClass;
  reason: string;
  at: string;
}
/** Who did a human action (lib/integrations/github/actor.ts); `login` is null for the foreman and when nothing resolved. */
export interface EventActor {
  login: string | null;
  source: ActorSource;
}
/** Who owns a waiting job's gate: gateOwner in lib/office/foreman/policy.ts; null when the job waits on nothing. */
export type GateOwner = 'foreman' | 'human' | null;

/** A per-run config overlay: dotted config keys to typed values, parseOverlay in lib/engine/evals/overlay.ts. */
export type EvalOverlay = Record<string, unknown>;
