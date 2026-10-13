// Shared data shapes of the engine, type-only: engine modules import these with `import type`, so
// this file never runs. The dashboard's src/lib/types.ts carries a copy of the API shapes, kept
// equal by test/types-parity.ts, until the dashboard imports this file. Unions that have a runtime
// list are derived from that list, never retyped.
import type { BUDGET_KEYS, SEVERITIES, STAGES, STATES, WAITING_ON } from './schema.ts';
import type { REQUEST_TYPES } from './requests.ts';

// ---------- enumerations ----------

/** A pipeline stage: STAGES in lib/schema.ts. */
export type Stage = (typeof STAGES)[number];
/** A job state: STATES in lib/schema.ts. */
export type JobState = (typeof STATES)[number];
/** Why a job waits: WAITING_ON in lib/schema.ts. */
export type WaitingOn = (typeof WAITING_ON)[number];
/** lib/schema.ts BUDGET_KEYS. */
export type BudgetKey = (typeof BUDGET_KEYS)[number];
/** A review finding's severity: SEVERITIES in lib/schema.ts. */
export type Severity = (typeof SEVERITIES)[number];

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
}

/** The session driving a job: claimJob in lib/jobs.ts. */
export interface JobOwner {
  session: string;
  host: string;
  since: string;
  heartbeat: string;
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
}

/** tasks.md checkbox counts: progress in lib/jobs.ts. */
export interface Progress {
  done: number;
  total: number;
}

/** A job as loadJob and normalizeJob return it: normalizeJob marks one written by a newer Forge. */
export type LoadedJob = Job & { _unsupported?: true };

// ---------- events ----------

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
  [key: string]: unknown;
}

// ---------- config ----------

/** One review lens: an entry of review.panel in defaults() (lib/config.ts). */
export interface PanelEntry {
  name: string;
  always?: boolean;
  model?: string;
  when?: string;
  checklist?: string;
}

/** Something agents should know exists: an entry of `resources` (docs/CONFIG.md). */
export interface ResourceConfig {
  name: string;
  kind?: string;
  url?: string;
  path?: string;
  use?: string;
}

/** One service of a monorepo: an entry of `services` (docs/CONFIG.md). */
export interface ServiceConfig {
  name: string;
  path: string;
  commands?: Record<string, string | null>;
  owners?: string[];
}

/** What `forge run <job> <name>` executes: defaults().commands in lib/config.ts. */
export interface CommandsConfig {
  setup: string | null;
  build: string | null;
  test: string | null;
  lint: string | null;
  format: string | null;
  typecheck: string | null;
  dev: string | null;
  e2e: string | null;
  [name: string]: string | null;
}

/** The effective config: defaults() in lib/config.ts merged with .forge/config.yml by loadConfig. docs/CONFIG.md documents each key. */
export interface Config {
  schemaVersion: number;
  project: {
    name: string | null;
    description: string | null;
    kinds: string[];
    instructions: string[];
    notes: string | null;
  };
  git: {
    base: string;
    remote: string;
    branchPrefix: string;
  };
  worktrees: {
    root: string;
    copy: string[];
    setup: string[];
    cleanup: 'on-merge' | 'manual';
    cargo: { sharedTarget: boolean; targetDir: string | null };
  };
  commands: CommandsConfig;
  verify: string[];
  verifyE2e: {
    when: 'ui' | 'always' | 'never';
    paths: string[];
  };
  verifyIntegrity: 'warn' | 'block';
  ports: { base: number; span: number };
  runtime: {
    provider: string;
    host: string;
    maxParallelJobs: number;
    diversity: boolean;
    models: Record<string, string>;
  };
  tracker: {
    /** local | github | none | the name of a .forge/trackers/<name>.mjs or .ts module */
    kind: string;
    local: { path: string };
    github: {
      repo: string | null;
      ready: { labels: string[]; excludeLabels: string[]; assignee: string | null; milestone: string | null; projectStatus: string | null };
      claim: { assign: boolean };
      comments: 'collaborators' | 'all';
      statusSync: 'none' | 'labels' | 'project' | 'both';
      labels: { prefix: string };
      project: {
        config: string;
        owner: string | null;
        number: number | null;
        statusField: string;
        statusMap: Record<string, string>;
      };
    };
  };
  pipeline: PipelineConfig;
  review: {
    blockOn: Severity[];
    panel: PanelEntry[];
    onPrFeedback: 'changed' | 'full' | 'none';
  };
  approver: { alwaysEscalate: string[] };
  pr: {
    enabled: boolean;
    draft: boolean;
    closeIssue: boolean;
    labels: string[];
    reviewers: string[];
    conflicts: 'ask' | 'fix' | 'defer';
    updateStrategy: 'merge' | 'rebase';
  };
  merge: {
    auto: boolean;
    method: 'squash' | 'merge' | 'rebase';
    autoWhen: string[];
  };
  aiAttribution: 'forbid' | 'allow';
  resources: ResourceConfig[];
  services: ServiceConfig[];
  infra: {
    mode: 'human' | 'plan-only' | 'agent';
    allowed: string[];
    notes: string | null;
  };
  usage: {
    track: boolean;
    /** Overrides for lib/pricing.json: { models: { <id>: {input, output, cacheRead, cacheWrite} }, aliases: {…} }. */
    pricing: Record<string, unknown>;
  };
  improve: { retroEvery: number; maxLearnings: number };
  evals: { testPattern: string | null };
  dashboard: { port: number };
  daemon: {
    enabled: boolean;
    command: string;
    allowedTools: string[];
    maxConcurrent: number;
    idleStopMinutes: number | null;
  };
}

/** What loadConfig in lib/config.ts returns. */
export interface LoadedConfig {
  config: Config;
  initialized: boolean;
  path: string;
  migratedFrom?: number;
}

// ---------- settings (lib/config-fields.ts) ----------

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
  suggestions: string[] | null;
  min: number | null;
  max: number | null;
  nullable: boolean;
  default: unknown;
  editable: boolean;
  lockedReason: string | null;
}

/** What setConfigValue in lib/config.ts returns: `forge config set` and POST /api/config. */
export interface PostConfigResponse {
  ok: true;
  key: string;
  value: ConfigValue;
  previous: unknown;
  changed: boolean;
}

// ---------- requests ----------

/** Request types the inbox accepts: REQUEST_TYPES in lib/requests.ts. */
export type RequestType = (typeof REQUEST_TYPES)[number];

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

// ---------- tracker contract ----------

/** What every tracker method receives: loadTracker's callers (lib/trackers/index.ts). */
export interface TrackerCtx {
  root: string;
  config: Config;
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

/**
 * The tracker contract. Every adapter (built-in or a repo's own `.forge/trackers/<name>.mjs` or `.ts`)
 * default-exports an object with these synchronous methods. docs/TRACKERS.md has the details.
 */
export interface Tracker {
  name: string;
  list: (ctx: TrackerCtx, opts: { ready?: boolean; limit?: number }) => TrackerItem[];
  get: (ctx: TrackerCtx, ref: string) => TrackerItem | null;
  claim: (ctx: TrackerCtx, ref: string, job: Job) => { ok: boolean; reason?: string };
  update: (ctx: TrackerCtx, ref: string, job: Job) => void;
  comment: (ctx: TrackerCtx, ref: string, body: string) => void;
  create: (ctx: TrackerCtx, item: { title: string; body?: string; labels?: string[]; parentRef?: string | null }) => { ref: string; url?: string | null };
  close: (ctx: TrackerCtx, ref: string, opts?: { reason?: 'completed' | 'not-planned' }) => void;
}

// ---------- HTTP API: GET responses ----------

/** config.pipeline as served: defaults().pipeline in lib/config.ts. */
export interface PipelineConfig {
  plan: 'auto' | 'always' | 'never';
  split: 'ask' | 'auto' | 'never';
  specApproval: 'always' | 'large' | 'never';
  design: 'none' | 'reference' | 'mockup';
  maxRounds: number;
  budget: BudgetLimits;
}

/** Supervisor status: state() in lib/daemon.ts. */
export type DaemonStatus = 'off' | 'idle' | 'busy' | 'stopping';

/** The daemon as the dashboard sees it: state() in lib/daemon.ts (or idleDaemonState) plus `clients` from lib/server.ts. */
export interface DaemonState {
  enabled: boolean;
  wanted: boolean;
  running: boolean;
  status: DaemonStatus;
  sessionId: string | null;
  pid: number | null;
  lastTurnAt: string | null;
  lastResultAt: string | null;
  turns: number;
  held: { reason: 'budget'; jobs: string[] } | null;
  lastError: string | null;
  clients: number;
}

/** A job row in /api/state: state() in lib/server.ts. */
export type StateJob = Job & { progress: Progress; lastEvent: JobEvent | null; eventCount: number };

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
  };
  daemon: DaemonState;
  jobs: StateJob[];
  requests: ForgeRequest[];
  now: string;
}

/** GET /api/jobs/:id: jobDetail in lib/server.ts. */
export interface JobDetail {
  job: Job & { progress: Progress };
  events: JobEvent[];
  files: string[];
  screenshots: string[];
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
    humanReworks: number;
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
  check: { ran: boolean; pass: boolean | null; tail: string | null; reason?: string };
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

/** GET /api/requests: listRequests in lib/requests.ts. */
export type RequestsResponse = ForgeRequest[];

/** GET /api/roster: roster in lib/roster.ts. */
export interface Roster {
  agents: { role: string; description: string; model: string; promptHash: string; addendum: string | null }[];
  reviewers: { name: string; model: string; always: boolean; when: string | null; checklist: string | null; checklistHash: string | null }[];
  learnings: string | null;
  diversity: { enabled: boolean; builder: string; overlap: { role: string; model: string }[] };
  warnings: string[];
}

/** GET /api/backlog: the handler in lib/server.ts over the tracker's list(). */
export interface BacklogResponse {
  tracker: string;
  items: TrackerItem[];
  error?: string;
}

// ---------- SSE frames (/api/events) ----------

/** One /api/events frame: stateFrame and lineFrame in lib/server.ts; `id` is the line's seq, `data` the raw log line. */
export type SseFrame = { event: 'state'; data: DaemonState } | { event: 'line'; id: number; data: string };

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

/** POST /api/daemon body: the handler in lib/server.ts. */
export interface PostDaemonBody {
  action: 'start' | 'stop';
}

/** POST /api/daemon reply on success: daemonState in lib/server.ts. */
export type PostDaemonResponse = DaemonState;

/**
 * JSON error body: jsonStatus for /api/daemon's 400/409 and the catch-all 500 in lib/server.ts.
 * The POST guard failures (403/415/421) are text/plain, not this.
 */
export interface ApiError {
  error: string;
}
