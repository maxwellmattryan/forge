// Shapes of the forge dash HTTP API for API_VERSION 18. Derived from lib/server.ts and the modules it calls. Change this file in the same commit as any /api or SSE shape change, and bump API_VERSION here and in lib/schema.ts together; test/dashboard-lib.test.ts fails if they differ.

// ---------- constants mirrored from lib/schema.ts ----------

/** lib/schema.ts API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 18;
/** lib/requests.ts INBOX_SCOPE: the daemon session for requests without a job. */
export const INBOX_SCOPE = '_inbox';
/** lib/requests.ts OFFICE_SCOPE: the foreman's session, which decides gate requests. */
export const OFFICE_SCOPE = '_office';

/** lib/schema.ts STAGES, in pipeline order. */
export const STAGES = ['backlog', 'plan', 'spec', 'design', 'build', 'verify', 'review', 'integrate', 'decide', 'pr', 'done'] as const;

/** lib/schema.ts STATES. */
export const STATES = ['queued', 'running', 'waiting', 'blocked', 'failed', 'cancelled', 'done'] as const;

/** lib/schema.ts WAITING_ON. */
export const WAITING_ON = ['spec-approval', 'split-approval', 'issue-link', 'input', 'escalation', 'infra', 'conflicts', 'rounds-exhausted', 'pr-review', 'external', 'budget', 'human'] as const;

/** lib/schema.ts EFFORTS: reasoning effort levels, lowest first. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A pipeline stage: STAGES in lib/schema.ts. */
export type Stage = (typeof STAGES)[number];
/** A job state: STATES in lib/schema.ts. */
export type JobState = (typeof STATES)[number];
/** Why a job waits: WAITING_ON in lib/schema.ts. */
export type WaitingOn = (typeof WAITING_ON)[number];
/** lib/schema.ts BUDGET_KEYS. */
export type BudgetKey = 'tokens' | 'usd' | 'minutes' | 'changedLines' | 'verifyRetries';
/** A reasoning effort level: EFFORTS in lib/schema.ts. */
export type Effort = (typeof EFFORTS)[number];
/** Where a resolved effort came from: resolveEffort in lib/config.ts. */
export type EffortSource = 'job' | 'panel' | 'role' | 'complexity' | 'config' | 'none';
/** A spec's judged difficulty: COMPLEXITIES in lib/schema.ts. */
export type Complexity = 'low' | 'medium' | 'high';

// ---------- job data ----------

/** Tracker origin of a job: createJob in lib/jobs.ts. */
export interface JobSource {
  tracker: string;
  ref: string | null;
  url: string | null;
}

/** GitHub check rollup: summarizeChecks in lib/pr.ts. */
export interface PrChecks {
  state: 'passing' | 'failing' | 'pending' | 'none';
  passing: number;
  failing: number;
  pending: number;
}

/** Commits humans pushed after Forge: measureOnMerge in lib/pr.ts (shape from lib/delta.ts). */
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

/** A job's pull request: findPr, openPr and syncPr in lib/pr.ts; sync-only fields are optional. */
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
}

/** The session driving a job: claimJob in lib/jobs.ts. */
export interface JobOwner {
  session: string;
  host: string;
  since: string;
  heartbeat: string;
}

/** Why a daemon owner provably let go of a job: ownerYield in lib/daemon-owner.ts. */
export type YieldReason = 'moved-on' | 'not-running' | 'inbox-handoff';

/** Who recorded a `human` event: a person, or the foreman. */
export type HumanActor = 'human' | 'foreman';
/** Who owns a waiting job's gate: gateOwner in lib/foreman.ts; null when the job waits on nothing or the foreman is off. */
export type GateOwner = 'foreman' | 'human' | null;

/** `dead` only in the job detail, which adds the daemon-record proof; /api/state gives the rest. */
export type OwnerStatusKind = 'none' | 'live' | 'stale' | 'dead';

/** Whether a job's owner still drives it: ownerStatus in lib/jobs.ts, ownerStatusWithProof in lib/daemon-owner.ts. */
export interface OwnerStatus {
  status: OwnerStatusKind;
  session: string | null;
  since: string | null;
  heartbeat: string | null;
  /** An agent has been marked running for under 2 hours. */
  agentRunning: boolean;
  /** Set only with status `dead`. */
  reason: YieldReason | null;
  /**
   * The owner is this job's own daemon session, recorded and running: a `resume` reaches that
   * session, which claims as itself, so a live owner doesn't block it. Proven only in the job
   * detail and the resume guard; false in /api/state.
   */
  jobSession: boolean;
}

/** One orchestrator session's stint on a job: claimJob/releaseJob in lib/jobs.ts. */
export interface JobRun {
  session: string;
  startedAt: string;
  endedAt?: string;
}

/** Per-role agent record: recordAgent in lib/jobs.ts. */
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
}

/** One role's or model's usage totals: addUsage in lib/jobs.ts. */
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

/** A job's token and cost totals: normalizeJob in lib/schema.ts and addUsage in lib/jobs.ts. */
export interface JobUsage {
  totalTokens: number;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  estCostUsd: number;
  exact: boolean;
}

/** Budget limits per key; null means unlimited: defaults().pipeline.budget in lib/config.ts. */
export type BudgetLimits = Partial<Record<BudgetKey, number | null>>;

/** What a job has spent per key: measureBudget in lib/budget.ts. */
export type BudgetUsed = Record<BudgetKey, number | null>;

/** Per-job budget state: enforceBudget and budgetCmd in lib/budget.ts. */
export interface JobBudget {
  limits: BudgetLimits;
  ack: Partial<Record<BudgetKey, { used: number; round: number }>>;
  lastCheck: { at: string; checkpoint: string; used: BudgetUsed } | null;
}

/** One verify attempt: verify in lib/worktree.ts. */
export interface VerifyRun {
  round: number;
  attempt: number;
  sha: string | null;
  ok: boolean;
  at: string | null;
  file: string;
  /** The name of the step that failed (`test`, `integrity`, …), null on a pass. */
  failure?: string | null;
}

/** A reviewer's settled verdict for a round: the verdicts case in lib/commands/job.ts (via roundVerdicts in lib/jobs.ts). */
export type Verdict = 'PASS' | 'CHANGES' | 'MALFORMED';

/** A job record: normalizeJob in lib/schema.ts. */
export interface Job {
  schemaVersion: number;
  id: string;
  title: string;
  kind: string;
  size: string | null;
  source: JobSource | null;
  /** The human's override for the issue link: `forge job link --none` in lib/tracker-link.ts. */
  noIssue: { reason: string | null; at: string } | null;
  parent: string | null;
  children: string[];
  dependsOn: string[];
  services: string[];
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
  reason: string | null;
  branch: string | null;
  base: string | null;
  worktree: string | null;
  port: number | null;
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
  owner: JobOwner | null;
  agents: Record<string, JobAgent>;
  usage: JobUsage;
  runs: JobRun[];
  createdAt: string | null;
  updatedAt: string | null;
  finishedAt: string | null;
  eval: { run: string; task: string } | null;
  /** `never` when the planner must not split this job (from-ref, revise-split); null follows pipeline.split. */
  splitMode: 'never' | null;
  /** The human's reasoning effort for this job (`forge job effort`); null inherits runtime.effort. */
  effort: Effort | null;
  /** The spec's `Complexity:` header, recorded at SP3; picks runtime.effortByComplexity. */
  complexity: Complexity | null;
}

/** tasks.md checkbox counts: progress in lib/jobs.ts. */
export interface Progress {
  done: number;
  total: number;
}

/** The stage/state pair a transition event records: setJob in lib/jobs.ts. */
export interface TransitionSide {
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
}

/** Usage an agent reported at agent-end: the agent case in lib/commands/job.ts (transcript fields from importClaudeCodeTranscript in lib/usage.ts). */
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

/** One events.jsonl line: logEvent in lib/jobs.ts; open-ended because event types are. */
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
  summary?: string;
  name?: string;
  ok?: boolean;
  exit?: number | null;
  durationMs?: number;
  text?: string;
  action?: string;
  note?: string | null;
  /** On `human` events: who decided. Absent on older events, which read as `human`. */
  actor?: HumanActor;
  [key: string]: unknown;
}

// ---------- GET responses ----------

/** config.pipeline as served: defaults().pipeline in lib/config.ts. */
export interface PipelineConfig {
  plan: 'auto' | 'always' | 'never';
  split: 'ask' | 'auto' | 'never';
  specApproval: 'always' | 'large' | 'never';
  design: 'none' | 'reference' | 'mockup';
  maxRounds: number;
  budget: BudgetLimits;
}

/** Session supervisor status: state() in lib/daemon.ts. */
export type DaemonStatus = 'off' | 'idle' | 'busy' | 'stopping';

/** One supervised session (the inbox or a job's): state() in lib/daemon.ts, or offState in lib/daemon-pool.ts. */
export interface DaemonSessionState {
  /** `_inbox` or a job id. */
  scope: string;
  wanted: boolean;
  running: boolean;
  status: DaemonStatus;
  sessionId: string | null;
  pid: number | null;
  lastTurnAt: string | null;
  lastResultAt: string | null;
  turns: number;
  failures: number;
  held: 'budget' | null;
  /** Has fresh work but no free slot under daemon.maxConcurrent. */
  waiting: boolean;
  lastError: string | null;
  /** Tool calls outside the allowlist the session is waiting on a human for, oldest first. */
  permissions: DaemonPermissionPrompt[];
  /** The permission mode claude last reported for the running child (at init or after a switch); null while none runs. */
  permissionMode: string | null;
  /** A running agent of the job this session drives keeps it from slot eviction and idle stop; null otherwise and while none runs. */
  kept: 'agents' | null;
  /** The --effort Forge passed the running child; null while none runs or when it passed none. */
  effort: Effort | null;
}

/**
 * The permission modes a human may put one daemon session in from the dashboard: `default` asks in the
 * dashboard, `auto` lets Claude Code's classifier approve routine calls, `dontAsk` refuses. lib/daemon.ts PERMISSION_MODES.
 */
export type DaemonPermissionMode = 'default' | 'auto' | 'dontAsk';

/** How a human answers a permission prompt: allow this call, allow it and its suggested rules for the rest of the session, or deny it. */
export type PermissionDecision = 'allow' | 'session' | 'deny';

/**
 * A tool call a daemon session's permission check sent to the supervisor instead of refusing:
 * lib/daemon.ts. Every field but id and at comes from the session, so it is untrusted text.
 */
export interface DaemonPermissionPrompt {
  /** The supervisor's id for the prompt, not claude's request id. */
  id: string;
  tool: string;
  /** The tool's input as JSON, capped. */
  input: string;
  /** The agent's own words for the call. */
  description: string | null;
  /** Set when a subagent made the call. */
  agentId: string | null;
  /** The path outside the session's working directories that triggered the prompt. */
  blockedPath: string | null;
  /** What "allow for this session" adds on top of this call: permission rules and directories. Both empty when it adds nothing. */
  sessionRules: string[];
  sessionDirs: string[];
  /** When the supervisor received it. */
  at: string;
}

/** The session pool as the dashboard sees it: state() in lib/daemon-pool.ts plus `clients` from lib/server.ts. */
export interface DaemonPoolState {
  enabled: boolean;
  wanted: boolean;
  maxConcurrent: number;
  /** Running job sessions (the inbox is not counted against maxConcurrent). */
  live: number;
  lastError: string | null;
  inbox: DaemonSessionState;
  /** The foreman's office session (scope `_office`), never counted against maxConcurrent. */
  office: DaemonSessionState;
  /** foreman.enabled: the dashboard shows the office only then. */
  foreman: boolean;
  /** Job sessions worth showing: running, stopping, waiting, held, failed or stopped by a human. */
  jobs: Record<string, DaemonSessionState>;
  /** The permission mode daemon.command starts sessions in (`manual` reads as `default`). */
  permissionMode: string;
  /** Sessions a human put in another mode from the dashboard, by scope. Held in memory only, so they end with `forge dash`. */
  permissionModes: Record<string, DaemonPermissionMode>;
  /** Open /api/events streams across all sessions. */
  clients: number;
}

/** GET /api/daemons/log: readLogPage in lib/daemon.ts. Offsets are the SSE ids of the same lines. */
export interface DaemonLogPage {
  scope: string;
  lines: { offset: number; line: string }[];
  /** Where this page starts: pass it as `before` for the next older page. */
  start: number;
  end: number;
  /** Older lines exist in the current `<scope>.log`. */
  more: boolean;
}

/** A job row in /api/state: state() in lib/server.ts. */
export type StateJob = Job & { progress: Progress; lastEvent: JobEvent | null; eventCount: number; ownerStatus: OwnerStatus; gateOwner: GateOwner };

/** Request types the inbox accepts: REQUEST_TYPES in lib/requests.ts. */
export type RequestType = 'next' | 'run' | 'approve' | 'revise-spec' | 'rework' | 'answer' | 'cancel' | 'resume' | 'sync' | 'eval-run' | 'retro' | 'gate';

/** A queued request: enqueue, claimRequest and ackRequest in lib/requests.ts. */
export interface ForgeRequest {
  id: string;
  type: RequestType;
  job: string | null;
  text: string | null;
  args: Record<string, unknown>;
  from: string;
  status: 'pending' | 'in-progress' | 'done' | 'rejected';
  createdAt: string;
  session?: string;
  updatedAt?: string;
  result?: string | null;
}

/** GET /api/state: state() in lib/server.ts. */
export interface ApiState {
  apiVersion: number;
  forgeVersion: string;
  repo: { name: string };
  initialized: boolean;
  config: {
    base: string;
    tracker: string;
    panel: string[];
    pipeline: PipelineConfig;
    models: Record<string, string>;
    daemon: { enabled: boolean };
    /** runtime.effort when it is valid, else null. */
    effort: Effort | null;
  };
  daemons: DaemonPoolState;
  jobs: StateJob[];
  requests: ForgeRequest[];
  now: string;
}

/** GET /api/jobs/:id: jobDetail in lib/server.ts. */
export interface JobDetail {
  job: Job & { progress: Progress; ownerStatus: OwnerStatus };
  events: JobEvent[];
  files: string[];
  screenshots: string[];
  /** This job's requests in every status, oldest first, at most the last 50. */
  requests: ForgeRequest[];
  /** request.md without its `# title` line, trimmed, at most 2,000 characters: the Thread's opening message. */
  request: string | null;
  /** The job's `created` event has a ref (from-ref), so `request` is the issue's text. A later `job link` doesn't count. */
  requestFromTracker: boolean;
}

/**
 * GET /api/jobs/:id/file for a text file: the text/plain body (send in lib/server.ts). Images come
 * back as raw bytes and /raw as sandboxed HTML; neither goes through api().
 */
export type JobFileText = string;

/** Usage per role or model in stats: computeStats in lib/stats.ts. */
export interface UsageRow {
  tokens: number;
  estCostUsd: number;
  runs: number;
}

/** One review lens's record: computeStats in lib/stats.ts. */
export interface ReviewerStats {
  reviews: number;
  changes: number;
  blockers: number;
  changeRate: number | null;
}

/** GET /api/stats: computeStats in lib/stats.ts. */
export interface Stats {
  generatedAt: string;
  since: string | null;
  counts: { total: number; active: number; done: number; cancelled: number; failed: number; waiting: number };
  waitingOn: Record<string, number>;
  quality: {
    firstPassReviewRate: number | null;
    avgRounds: number | null;
    verifyFirstPassRate: number | null;
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
  };
  reviewers: Record<string, ReviewerStats>;
}

/** An eval task as served: loadTask in lib/evals.ts minus `dir` and `request`. */
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

/** A graded eval job: gradeJob in lib/evals.ts. */
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
}

/** Aggregates over a run's graded tasks: summarize in lib/evals.ts. */
export interface EvalSummary {
  tasks: number;
  graded: number;
  checkPassRate: number | null;
  avgJudgeScore: number | null;
  firstPassRate: number | null;
  avgRounds: number | null;
  escalationRate: number | null;
  avgTokens: number | null;
  avgCostUsd: number | null;
  avgMinutes: number | null;
}

/** An eval run record: startRun and gradeJob in lib/evals.ts, with summary filled by listRuns. */
export interface EvalRun {
  schemaVersion: number;
  id: string;
  label: string | null;
  forgeVersion: string;
  configHash: string;
  models: Record<string, string>;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done';
  tasks: { task: string; job: string; worktreeOk: boolean; result: EvalResult | null }[];
  summary: EvalSummary;
}

/** GET /api/evals: the handler in lib/server.ts over listTasks/listRuns in lib/evals.ts. */
export interface EvalsResponse {
  tasks: EvalTask[];
  runs: EvalRun[];
}

/** GET /api/evals/compare: compareRuns in lib/evals.ts. */
export interface EvalCompare {
  a: { id: string; configHash: string; forgeVersion: string };
  b: { id: string; configHash: string; forgeVersion: string };
  delta: Record<keyof EvalSummary, { a: number | null; b: number | null; change: number | null }>;
  perTask: { task: string; a: boolean | null; b: boolean | null }[];
}

/** A value `forge config set` and POST /api/config can write. */
export type ConfigValue = string | number | boolean | null | string[];

/** How a settings field is parsed, validated and rendered. */
export type ConfigFieldType = 'boolean' | 'integer' | 'number' | 'string' | 'enum' | 'list' | 'object';

/** The settings tab a field belongs to. */
export type ConfigSection = 'pipeline' | 'review' | 'agents' | 'tracker' | 'dashboard' | 'daemon';

/** One entry of FIELDS in lib/config-fields.ts. Every property is always present. */
export interface ConfigField {
  key: string;
  section: ConfigSection;
  label: string;
  help: string;
  type: ConfigFieldType;
  options: string[] | null;
  /** List options every value must keep (review.blockOn: blocker and major). */
  required: string[] | null;
  suggestions: string[] | null;
  min: number | null;
  /** `min` itself is not allowed: values must be greater than it. */
  minExclusive: boolean;
  max: number | null;
  nullable: boolean;
  default: unknown;
  editable: boolean;
  lockedReason: string | null;
}

/** GET /api/config: configResponse in lib/server.ts over FIELDS in lib/config-fields.ts. */
export interface ConfigResponse {
  initialized: boolean;
  path: '.forge/config.yml';
  fields: ConfigField[];
  /** The effective value of every field key. */
  values: Record<string, unknown>;
  problems: string[];
  writable: boolean;
  lockedBy: 'uninitialized' | 'daemon' | null;
}

/** One `forge doctor` check: doctor in lib/doctor.ts. */
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** What `forge doctor` prints: doctor in lib/doctor.ts. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** GET /api/doctor: doctor in lib/doctor.ts, plus when it ran. */
export type DoctorResponse = DoctorReport & { at: string };

/** GET /api/about: about in lib/server.ts. */
export interface AboutResponse {
  forgeVersion: string;
  apiVersion: number;
  pluginRoot: string;
  schemaVersions: { config: number; job: number; event: number };
  pricingAsOf: string | null;
  node: string;
  links: { repo: string | null; docs: string | null };
}

/** A CI rollup on a GitHub preview: GitHub's statusCheckRollup, folded to three outcomes; null when nothing ran. */
export type GitHubChecks = 'success' | 'failure' | 'pending' | null;

/** A repository's hover preview. Strings are GitHub text: render them as text. */
export interface GitHubRepoPreview {
  kind: 'repo';
  repo: string;
  url: string;
  description: string | null;
  private: boolean;
  archived: boolean;
  fork: boolean;
  stars: number;
  forks: number;
  language: string | null;
  defaultBranch: string | null;
  openIssues: number;
  openPulls: number;
  license: string | null;
  pushedAt: string | null;
}

/** A pull request's hover preview. `excerpt` is the start of the body as plain text. */
export interface GitHubPullPreview {
  kind: 'pull';
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  author: string | null;
  createdAt: string;
  updatedAt: string;
  base: string;
  head: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: GitHubChecks;
  labels: string[];
  excerpt: string;
}

/** An issue's hover preview. A closed issue keeps why it closed: completed (`closed`), not planned or a duplicate. */
export interface GitHubIssuePreview {
  kind: 'issue';
  repo: string;
  number: number;
  url: string;
  title: string;
  state: 'open' | 'closed' | 'not_planned' | 'duplicate';
  author: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: string[];
  assignees: string[];
  excerpt: string;
}

/** A commit's hover preview. */
export interface GitHubCommitPreview {
  kind: 'commit';
  repo: string;
  sha: string;
  url: string;
  headline: string;
  author: string | null;
  committedAt: string;
  additions: number;
  deletions: number;
  checks: GitHubChecks;
}

export type GitHubPreview = GitHubRepoPreview | GitHubPullPreview | GitHubIssuePreview | GitHubCommitPreview;

/** Why a preview could not be fetched: no `gh` on PATH, GitHub has no such page (or no access), or anything else. */
export type GitHubPreviewError = 'gh_missing' | 'not_found' | 'failed';

/** GET /api/github/preview?url=: previewGitHub in lib/github-preview.ts. A URL it can't preview is a 400 ApiError. */
export type GitHubPreviewResponse = { preview: GitHubPreview } | { error: GitHubPreviewError; message: string };

/** GET /api/requests: listRequests in lib/requests.ts. */
export type RequestsResponse = ForgeRequest[];

/** GET /api/roster: roster in lib/roster.ts. */
export interface Roster {
  agents: { role: string; description: string; model: string; promptHash: string; addendum: string | null; effort: Effort | null; effortSource: EffortSource }[];
  reviewers: { name: string; model: string; always: boolean; when: string | null; checklist: string | null; checklistHash: string | null; effort: Effort | null; effortSource: EffortSource }[];
  learnings: string | null;
  diversity: { enabled: boolean; builder: string; overlap: { role: string; model: string }[] };
  warnings: string[];
}

/** A backlog item, as a tracker's list() and get() return it (lib/trackers/index.ts). */
export interface TrackerItem {
  ref: string;
  title: string;
  url?: string | null;
  body?: string;
  labels?: string[];
  status?: string | null;
  priority?: string | null;
  assignees?: string[];
  claimedBy?: string | null;
}

/** GET /api/backlog: the handler in lib/server.ts over the tracker's list(). */
export interface BacklogResponse {
  tracker: string;
  items: TrackerItem[];
  error?: string;
}

// ---------- SSE frames (/api/events) ----------

/** One /api/events?session= frame: stateFrame and lineFrame in lib/server.ts; `id` is the line's offset in the session log, `data` the raw log line. */
export type SseFrame = { event: 'state'; data: DaemonSessionState } | { event: 'line'; id: number; data: string };

/** The line a frame carries instead of an oversized one: lineFrame in lib/server.ts. */
export interface ForgeTruncatedLine {
  type: 'forge-truncated';
  originalType: string | null;
  bytes: number;
}

// ---------- POST bodies and replies ----------

/** POST /api/requests body: read by the handler in lib/server.ts and passed to enqueue. */
export interface PostRequestBody {
  type: RequestType;
  job?: string | null;
  text?: string | null;
  args?: Record<string, unknown>;
}

/** POST /api/requests reply: the handler in lib/server.ts. */
export type PostRequestResponse = ForgeRequest & { daemon: boolean };

/** POST /api/jobs body: a new job from free text; `title` overrides the one derived from `text`. */
export interface PostJobBody {
  text: string;
  title?: string | null;
}

/** POST /api/jobs reply: the new job and the `resume` request queued for its session. */
export interface PostJobResponse {
  id: string;
  title: string;
  branch: string | null;
  request: ForgeRequest;
  daemon: boolean;
}

/** POST /api/config body: the handler in lib/server.ts passes it to setConfigValue. */
export interface PostConfigBody {
  key: string;
  value: ConfigValue;
}

/** POST /api/config reply: setConfigValue in lib/config.ts. */
export interface PostConfigResponse {
  ok: true;
  key: string;
  value: ConfigValue;
  previous: unknown;
  changed: boolean;
}

/** POST /api/daemon body: the handler in lib/server.ts. */
export interface PostDaemonBody {
  action: 'start' | 'stop';
  /** `_inbox` or a job id: start or stop that one session instead of the pool. */
  scope?: string;
}

/** POST /api/daemon reply on success: poolState in lib/server.ts. */
export type PostDaemonResponse = DaemonPoolState;

/** POST /api/daemon/mode body: the handler in lib/server.ts. */
export interface PostDaemonModeBody {
  /** `_inbox` or a job id. */
  scope: string;
  mode: DaemonPermissionMode;
}

/** POST /api/daemon/mode reply on success: poolState in lib/server.ts. */
export type PostDaemonModeResponse = DaemonPoolState;

/** POST /api/jobs/:id/effort body: the handler in lib/server.ts. null inherits runtime.effort. */
export interface PostJobEffortBody {
  effort: Effort | null;
}

/** POST /api/jobs/:id/effort reply, and `forge job effort`'s output: setJobEffort in lib/jobs.ts. */
export interface PostJobEffortResponse {
  id: string;
  effort: Effort | null;
  previous: Effort | null;
  changed: boolean;
}

/**
 * JSON error body: jsonStatus for /api/daemon's and /api/config's 4xx and the catch-all 500 in lib/server.ts.
 * The POST guard failures (403/415/421) are text/plain, not this.
 */
export interface ApiError {
  error: string;
}
