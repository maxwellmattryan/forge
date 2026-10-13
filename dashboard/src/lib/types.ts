// Shapes of the forge dash HTTP API for API_VERSION 4. Derived from lib/server.mjs and the modules it calls. Change this file in the same commit as any /api or SSE shape change, and bump API_VERSION here and in lib/schema.mjs together; test/dashboard-lib.test.mjs fails if they differ.

// ---------- constants mirrored from lib/schema.mjs ----------

/** lib/schema.mjs API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 4;

/** lib/schema.mjs STAGES, in pipeline order. */
export const STAGES = ['backlog', 'plan', 'spec', 'design', 'build', 'verify', 'review', 'decide', 'integrate', 'pr', 'done'] as const;

/** lib/schema.mjs STATES. */
export const STATES = ['queued', 'running', 'waiting', 'blocked', 'failed', 'cancelled', 'done'] as const;

/** lib/schema.mjs WAITING_ON. */
export const WAITING_ON = ['spec-approval', 'input', 'escalation', 'infra', 'conflicts', 'rounds-exhausted', 'pr-review', 'external', 'budget'] as const;

/** A pipeline stage: STAGES in lib/schema.mjs. */
export type Stage = (typeof STAGES)[number];
/** A job state: STATES in lib/schema.mjs. */
export type JobState = (typeof STATES)[number];
/** Why a job waits: WAITING_ON in lib/schema.mjs. */
export type WaitingOn = (typeof WAITING_ON)[number];
/** lib/schema.mjs BUDGET_KEYS. */
export type BudgetKey = 'tokens' | 'usd' | 'minutes' | 'changedLines' | 'verifyRetries';

// ---------- job data ----------

/** Tracker origin of a job: createJob in lib/jobs.mjs. */
export interface JobSource {
  tracker: string;
  ref: string | null;
  url: string | null;
}

/** GitHub check rollup: summarizeChecks in lib/pr.mjs. */
export interface PrChecks {
  state: 'passing' | 'failing' | 'pending' | 'none';
  passing: number;
  failing: number;
  pending: number;
}

/** Commits humans pushed after Forge: measureOnMerge in lib/pr.mjs (shape from lib/delta.mjs). */
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

/** A job's pull request: findPr, openPr and syncPr in lib/pr.mjs; sync-only fields are optional. */
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

/** The session driving a job: claimJob in lib/jobs.mjs. */
export interface JobOwner {
  session: string;
  host: string;
  since: string;
  heartbeat: string;
}

/** One orchestrator session's stint on a job: claimJob/releaseJob in lib/jobs.mjs. */
export interface JobRun {
  session: string;
  startedAt: string;
  endedAt?: string;
}

/** Per-role agent record: recordAgent in lib/jobs.mjs. */
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

/** One role's or model's usage totals: addUsage in lib/jobs.mjs. */
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

/** A job's token and cost totals: normalizeJob in lib/schema.mjs and addUsage in lib/jobs.mjs. */
export interface JobUsage {
  totalTokens: number;
  byRole: Record<string, UsageBucket>;
  byModel: Record<string, UsageBucket>;
  estCostUsd: number;
  exact: boolean;
}

/** Budget limits per key; null means unlimited: defaults().pipeline.budget in lib/config.mjs. */
export type BudgetLimits = Partial<Record<BudgetKey, number | null>>;

/** What a job has spent per key: measureBudget in lib/budget.mjs. */
export type BudgetUsed = Record<BudgetKey, number | null>;

/** Per-job budget state: enforceBudget and budgetCmd in lib/budget.mjs. */
export interface JobBudget {
  limits: BudgetLimits;
  ack: Partial<Record<BudgetKey, { used: number; round: number }>>;
  lastCheck: { at: string; checkpoint: string; used: BudgetUsed } | null;
}

/** One verify attempt: verify in lib/worktree.mjs. */
export interface VerifyRun {
  round: number;
  attempt: number;
  sha: string | null;
  ok: boolean;
  at: string | null;
  file: string;
}

/** A reviewer's settled verdict for a round: the verdicts case in lib/commands/job.mjs (via roundVerdicts in lib/jobs.mjs). */
export type Verdict = 'PASS' | 'CHANGES' | 'MALFORMED';

/** A job record: normalizeJob in lib/schema.mjs. */
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

/** tasks.md checkbox counts: progress in lib/jobs.mjs. */
export interface Progress {
  done: number;
  total: number;
}

/** The stage/state pair a transition event records: setJob in lib/jobs.mjs. */
export interface TransitionSide {
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
}

/** Usage an agent reported at agent-end: recordAgent in lib/jobs.mjs. */
export interface AgentUsage {
  totalTokens?: number;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  toolUses?: number;
  durationMs?: number;
  exact?: boolean;
}

/** One events.jsonl line: logEvent in lib/jobs.mjs; open-ended because event types are. */
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

// ---------- GET responses ----------

/** config.pipeline as served: defaults().pipeline in lib/config.mjs. */
export interface PipelineConfig {
  plan: 'auto' | 'always' | 'never';
  specApproval: 'always' | 'large' | 'never';
  design: 'none' | 'reference' | 'mockup';
  maxRounds: number;
  budget: BudgetLimits;
}

/** Supervisor status: state() in lib/daemon.mjs. */
export type DaemonStatus = 'off' | 'idle' | 'busy' | 'stopping';

/** The daemon as the dashboard sees it: state() in lib/daemon.mjs (or idleDaemonState) plus `clients` from lib/server.mjs. */
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

/** A job row in /api/state: state() in lib/server.mjs. */
export type StateJob = Job & { progress: Progress; lastEvent: JobEvent | null; eventCount: number };

/** Request types the inbox accepts: REQUEST_TYPES in lib/requests.mjs. */
export type RequestType = 'next' | 'run' | 'approve' | 'revise-spec' | 'rework' | 'answer' | 'cancel' | 'resume' | 'sync' | 'eval-run' | 'retro';

/** A queued request: enqueue, claimRequest and ackRequest in lib/requests.mjs. */
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

/** GET /api/state: state() in lib/server.mjs. */
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

/** GET /api/jobs/:id: jobDetail in lib/server.mjs. */
export interface JobDetail {
  job: Job & { progress: Progress };
  events: JobEvent[];
  files: string[];
  screenshots: string[];
}

/**
 * GET /api/jobs/:id/file for a text file: the text/plain body (send in lib/server.mjs). Images come
 * back as raw bytes and /raw as sandboxed HTML; neither goes through api().
 */
export type JobFileText = string;

/** Usage per role or model in stats: computeStats in lib/stats.mjs. */
export interface UsageRow {
  tokens: number;
  estCostUsd: number;
  runs: number;
}

/** One review lens's record: computeStats in lib/stats.mjs. */
export interface ReviewerStats {
  reviews: number;
  changes: number;
  blockers: number;
  changeRate: number | null;
}

/** GET /api/stats: computeStats in lib/stats.mjs. */
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

/** An eval task as served: loadTask in lib/evals.mjs minus `dir` and `request`. */
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

/** A graded eval job: gradeJob in lib/evals.mjs. */
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

/** Aggregates over a run's graded tasks: summarize in lib/evals.mjs. */
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

/** An eval run record: startRun and gradeJob in lib/evals.mjs, with summary filled by listRuns. */
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

/** GET /api/evals: the handler in lib/server.mjs over listTasks/listRuns in lib/evals.mjs. */
export interface EvalsResponse {
  tasks: EvalTask[];
  runs: EvalRun[];
}

/** GET /api/evals/compare: compareRuns in lib/evals.mjs. */
export interface EvalCompare {
  a: { id: string; configHash: string; forgeVersion: string };
  b: { id: string; configHash: string; forgeVersion: string };
  delta: Record<keyof EvalSummary, { a: number | null; b: number | null; change: number | null }>;
  perTask: { task: string; a: boolean | null; b: boolean | null }[];
}

/** GET /api/requests: listRequests in lib/requests.mjs. */
export type RequestsResponse = ForgeRequest[];

/** GET /api/roster: roster in lib/roster.mjs. */
export interface Roster {
  agents: { role: string; description: string; model: string; promptHash: string; addendum: string | null }[];
  reviewers: { name: string; model: string; always: boolean; when: string | null; checklist: string | null; checklistHash: string | null }[];
  learnings: string | null;
  diversity: { enabled: boolean; builder: string; overlap: { role: string; model: string }[] };
  warnings: string[];
}

/** A backlog item: the TrackerItem typedef in lib/trackers/index.mjs. */
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

/** GET /api/backlog: the handler in lib/server.mjs over the tracker's list(). */
export interface BacklogResponse {
  tracker: string;
  items: TrackerItem[];
  error?: string;
}

// ---------- SSE frames (/api/events) ----------

/** One /api/events frame: stateFrame and lineFrame in lib/server.mjs; `id` is the line's seq, `data` the raw log line. */
export type SseFrame = { event: 'state'; data: DaemonState } | { event: 'line'; id: number; data: string };

/** The line a frame carries instead of an oversized one: lineFrame in lib/server.mjs. */
export interface ForgeTruncatedLine {
  type: 'forge-truncated';
  originalType: string | null;
  bytes: number;
}

// ---------- POST bodies and replies ----------

/** POST /api/requests body: read by the handler in lib/server.mjs and passed to enqueue. */
export interface PostRequestBody {
  type: RequestType;
  job?: string | null;
  text?: string | null;
  args?: Record<string, unknown>;
}

/** POST /api/requests reply: the handler in lib/server.mjs. */
export type PostRequestResponse = ForgeRequest & { daemon: boolean };

/** POST /api/daemon body: the handler in lib/server.mjs. */
export interface PostDaemonBody {
  action: 'start' | 'stop';
}

/** POST /api/daemon reply on success: daemonState in lib/server.mjs. */
export type PostDaemonResponse = DaemonState;

/**
 * JSON error body: jsonStatus for /api/daemon's 400/409 and the catch-all 500 in lib/server.mjs.
 * The POST guard failures (403/415/421) are text/plain, not this.
 */
export interface ApiError {
  error: string;
}
