// Shapes of the forge dash HTTP API for API_VERSION 28. Derived from lib/server.ts and the modules it calls. Change this file in the same commit as any /api or SSE shape change, and bump API_VERSION here and in lib/schema.ts together; test/dashboard-lib.test.ts fails if they differ.

// ---------- constants mirrored from lib/schema.ts ----------

/** lib/schema.ts API_VERSION: the dashboard refuses data from a newer server. */
export const API_VERSION = 33;
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
export type InterimStrategy = 'canary' | 'git-ref' | 'local' | 'sequential';

// ---------- job data ----------

/**
 * One of a job's issues: lib/issue-ref.ts. `tracker` is the tracker kind; `ref` is `owner/repo#12`
 * for GitHub (a bare number only in legacy jobs), the slug for the local backlog, or a custom
 * adapter's own ref. A null ref keeps a url-only entry, which never counts as linked.
 */
export interface JobIssue {
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

/** What happened to a merged job inside its window: measureOutcome in lib/outcome.ts. */
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

/** A sampled merged job's post-merge judge score: queueScores and recordScore in lib/scoring.ts. */
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

/** The fenced claim on a job: claimJob, renewLease, expireLease and releaseJob in lib/jobs.ts. */
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

/** Where an event's actor came from: ACTOR_SOURCES in lib/schema.ts. */
export type ActorSource = 'env' | 'gh' | 'git' | 'os' | 'dashboard' | 'foreman' | 'unknown';
/** Who did a human action; `login` is null for the foreman and when nothing resolved. */
export interface EventActor {
  login: string | null;
  source: ActorSource;
}
/** Who owns a waiting job's gate: gateOwner in lib/foreman.ts; null when the job waits on nothing or the foreman is off. */
export type GateOwner = 'foreman' | 'human' | null;

/** `none` without a driver; `expired` with one whose expiresAt has passed. */
export type OwnerStatusKind = 'none' | 'live' | 'expired';

/** Whether a job's lease still holds: leaseStatus in lib/jobs.ts. */
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
  /** The name of the step that failed (`test`, `integrity`, `secrets`, `protected`, …), null on a pass. */
  failure?: string | null;
  /** One record per member repo, only when the job has members: verify in lib/worktree.ts. */
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
 * branch/base/worktree/pr by normalizeJob; later entries are member repos (lib/job-repos.ts).
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
  /** The human's interim strategy for this repo as a dependency; null inherits config. */
  interim?: InterimStrategy | null;
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
  /** The job's issues, primary first; one issue may sit on several jobs: lib/tracker-link.ts. */
  issues: JobIssue[];
  /** The human's decision that the job needs no issue, cleared by linking one: `forge job link --none` in lib/tracker-link.ts. */
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
  /** The first port-bearing component's port (what `{port}`, the dev server and the live dot use): lib/ports.ts. */
  port: number | null;
  /** One port per service or app component (`dev` when the repo has none), allocated with the worktree: lib/ports.ts. */
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
  /** The spec's `Complexity:` header, recorded at SP3; picks runtime.effortByComplexity. */
  complexity: Complexity | null;
  /** Escalate paths the branch changes, recorded by the CLI only: recordProtected in lib/protected.ts. */
  protectedPaths: ProtectedPaths | null;
  /** The human's interim strategy for the root repo as a dependency; null inherits config. */
  interim: InterimStrategy | null;
  /** The root repo first, then member repos: `forge job repo add|remove` in lib/job-repos.ts. */
  repos: JobRepo[];
  /** The merged root PR's post-merge outcome, written by `forge sync` (lib/outcome.ts); null until measured. */
  outcome: JobOutcome | null;
  /** The post-merge judge score of a sampled merged job (lib/scoring.ts); null until forge sync queues one. */
  score: JobScore | null;
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
  /** On human-action events (lib/actor.ts): who acted, best effort and unauthenticated. */
  actor?: EventActor;
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
  /** The total-round ceiling (B7); null means twice the job's maxRounds. */
  maxTotalRounds: number | null;
  budget: BudgetLimits;
}

/** daemon.jobBudget: the spend limits an unattended job with none of its own gets (lib/budget.ts effectiveLimits). */
export type DaemonJobBudget = { tokens?: number | null; usd?: number | null; minutes?: number | null } | null;

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
  held: 'budget' | 'repo-budget' | null;
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
/** What a transcript's agent did last. Plain text, at most 160 characters. */
export interface TranscriptActivity {
  kind: 'tool' | 'text';
  text: string;
  at: string | null;
}

/** One running agent of a job in /api/state. `last` is null when no transcript is found. */
export interface AgentActivity {
  role: string;
  model: string | null;
  startedAt: string | null;
  last: TranscriptActivity | null;
}

/** One agent of the job's current round (or still running) in the job detail. */
export interface AgentRow {
  role: string;
  status: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** endedAt − startedAt; null while running or when either is unknown. */
  durationMs: number | null;
  /** usage.totalTokens of this run's agent-end event, else null. */
  tokens: number | null;
  /** Its transcript was found. */
  transcript: boolean;
}

/** GET /api/jobs/:id/transcript: a page of an agent's or the interactive owner's transcript, read backwards. */
export interface TranscriptPage {
  job: string;
  source: 'agent' | 'owner';
  /** The agent's role; null for the owner. */
  role: string | null;
  lines: { offset: number; line: string }[];
  start: number;
  end: number;
  more: boolean;
}

/** The last event that carries an actor: who last acted on a job (lastHuman in lib/server.ts). */
export interface LastHuman {
  ts: string;
  type: string;
  action: string | null;
  actor: EventActor;
}

export type StateJob = Job & { progress: Progress; lastEvent: JobEvent | null; eventCount: number; ownerStatus: OwnerStatus; activity: AgentActivity[]; gateOwner: GateOwner; lastHuman: LastHuman | null; endpoints: Endpoint[] };

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
  /** How often requeueOrphans returned it to pending after its session ended; a second time rejects it. */
  requeues?: number;
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
    daemon: { enabled: boolean; jobBudget: DaemonJobBudget };
    /** runtime.effort when it is valid, else null. */
    effort: Effort | null;
  };
  daemons: DaemonPoolState;
  jobs: StateJob[];
  requests: ForgeRequest[];
  /** The focused job (forge focus), or null when none is focused or it is gone or finished. */
  focus: FocusFact | null;
  /** Repo spend against the day and month caps. */
  budget: RepoBudgetStatus;
  now: string;
}

/** A repo budget cap: REPO_BUDGET_KEYS in lib/schema.ts. */
export type RepoBudgetKey = 'usdPerMonth' | 'tokensPerMonth' | 'usdPerDay';
/** budget.onExceeded: REPO_BUDGET_MODES in lib/schema.ts. */
export type RepoBudgetMode = 'hold' | 'warn';

/** Repo spend against the caps: repoBudgetStatus in lib/repo-budget.ts (`forge budget`, /api/state.budget). */
export interface RepoBudgetStatus {
  /** Current UTC period ids: YYYY-MM-DD and YYYY-MM. */
  day: string;
  month: string;
  onExceeded: RepoBudgetMode;
  /** USD to 4 decimal places. */
  spent: { dayUsd: number; monthUsd: number; monthTokens: number };
  configured: Record<RepoBudgetKey, number | null>;
  acks: { day: number; month: number };
  /** Effective caps: configured x (1 + acks for the period). */
  caps: Record<RepoBudgetKey, number | null>;
  /** max(0, cap - spent); null when uncapped. */
  remaining: Record<RepoBudgetKey, number | null>;
  /** monthUsd / dayOfMonth x daysInMonth, 2dp. */
  projectedMonthUsd: number;
  exceeded: RepoBudgetKey[];
  held: boolean;
  /** `repo budget: …` when any key is exceeded, also under warn. */
  reason: string | null;
  /** Live jobs waiting on budget with a `repo budget:` reason. */
  heldJobs: string[];
}

/** POST /api/budget/ack: the repo budget status after the acknowledgement. */
export type PostBudgetAckResponse = RepoBudgetStatus;

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
  /** The current round's agent records plus any still running, newest start first. */
  agents: AgentRow[];
  /** The owner is an interactive (non-daemon) session whose transcript exists; null otherwise. */
  ownerTranscript: { session: string } | null;
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
}

/** One verifier's record: computeStats in lib/stats.ts, from `verifiers` record events. */
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

/** GET /api/stats: computeStats in lib/stats.ts. */
export interface Stats {
  generatedAt: string;
  since: string | null;
  /** `archived`: how many of `total` were read from .forge/archive/ (lib/archive.ts). */
  counts: { total: number; active: number; done: number; cancelled: number; failed: number; waiting: number; archived: number };
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
    /** Recurring (lens, path) review findings across every job in the window. */
    recurringFindings: number;
    /** Autonomous jobs (lib/autonomy.ts) over merged jobs with a final outcome. */
    autonomyRate: number | null;
    /** The same, also without a person's approval at a required gate. */
    autonomyRateStrict: number | null;
    revertRate: number | null;
    followUpRate: number | null;
    churnRate: number | null;
    outcomeCoverage: { merged: number; final: number; open: number };
    /** The median post-merge judge score (0-5) over scored jobs (lib/scoring.ts). */
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
  };
  reviewers: Record<string, ReviewerStats>;
  verifiers: Record<string, VerifierStats>;
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
  /** Minutes per stage the job entered: jobTiming in lib/eval-stats.ts. Absent on results graded before it. */
  stages?: Partial<Record<Stage, number>>;
  /** Agent-run time, summed across parallel agents. */
  agentMinutes?: number | null;
  /** Wall time when no agent was running. */
  orchestratorMinutes?: number | null;
  reviewerRuns?: number;
  /** round > maxRounds at grade time: B6 sent it to decide. Absent on results graded before it. */
  roundsExhausted?: boolean;
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
  roundsExhaustedRate: number | null;
  avgTokens: number | null;
  avgCostUsd: number | null;
  avgMinutes: number | null;
  avgAgentMinutes: number | null;
  avgOrchestratorMinutes: number | null;
  avgReviewerRuns: number | null;
}

/** A per-run config overlay: dotted config keys to typed values, parseOverlay in lib/eval-overlay.ts. */
export type EvalOverlay = Record<string, unknown>;

/** A sample's size and spread: stat in lib/eval-stats.ts. */
export interface EvalStat {
  n: number;
  mean: number | null;
  min: number | null;
  max: number | null;
}

/** Two means and the sample count behind each: delta in lib/eval-stats.ts. */
export interface EvalDelta {
  a: number | null;
  b: number | null;
  change: number | null;
  na: number;
  nb: number;
}

/** The per-task metrics: TASK_METRICS in lib/eval-stats.ts. */
export type EvalTaskMetric = 'checkPass' | 'judgeScore' | 'firstPass' | 'rounds' | 'tokens' | 'costUsd' | 'minutes' | 'agentMinutes' | 'orchestratorMinutes' | 'reviewerRuns';

/** One task's repeats in a run: aggregateTasks in lib/eval-stats.ts. */
export interface EvalTaskAggregate {
  task: string;
  runs: number;
  graded: number;
  metrics: Record<EvalTaskMetric, EvalStat>;
  stages: Record<string, EvalStat>;
}

/** An eval run record: startRun and gradeJob in lib/evals.ts, with summary filled by listRuns. */
export interface EvalRun {
  schemaVersion: number;
  id: string;
  label: string | null;
  forgeVersion: string;
  configHash: string;
  /** The plugin's prompt and pipeline hash: pluginHash in lib/evals.ts. Null on records before it. */
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

/** GET /api/evals: the handler in lib/server.ts over listTasks/listRuns in lib/evals.ts. */
export interface EvalsResponse {
  tasks: EvalTask[];
  runs: EvalRun[];
}

/** GET /api/evals/compare: compareRuns in lib/evals.ts. */
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
  /** Post-merge scores of real jobs merged in the 14 days before each run started (lib/scoring.ts). */
  realJobs: { a: RealJobScores; b: RealJobScores };
}

/** Real jobs' post-merge scores over a window: realJobScores in lib/evals.ts. avgScore is 0-1, as avgJudgeScore. */
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
  /** ok, but worth a look; never set with ok: false. */
  warn?: boolean;
}

/** What `forge doctor` prints: doctor in lib/doctor.ts. */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** GET /api/doctor: doctor in lib/doctor.ts, plus when it ran. */
export type DoctorResponse = DoctorReport & { at: string };

/** How `forge version --json` names the install: versionInfo in lib/version.ts. */
export type InstalledAs = 'plugin' | 'clone' | 'unknown';

/** GET /api/about: about in lib/server.ts. */
export interface AboutResponse {
  forgeVersion: string;
  apiVersion: number;
  pluginRoot: string;
  schemaVersions: { config: number; job: number; event: number };
  pricingAsOf: string | null;
  node: string;
  links: { repo: string | null; docs: string | null };
  /** versionInfo(PLUGIN_ROOT) in lib/version.ts: 40 lowercase hex, or null. */
  commit: string | null;
  installedAs: InstalledAs;
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

/** One component of GET /api/project: projectGraph in lib/project.ts. Never its commands, owners or notes. */
export interface ProjectComponent {
  name: string;
  /** null: the root repo. */
  repo: string | null;
  kind: 'library' | 'service' | 'app';
  path: string;
}

/** One dependsOn edge of GET /api/project, from the dependent to its dependency. */
export interface ProjectEdge {
  from: string;
  to: string;
  target: 'component' | 'backing';
  type: 'build' | 'runtime';
}

/** GET /api/project: projectGraph in lib/project.ts, the config-derived graph only. */
export interface ProjectResponse {
  components: ProjectComponent[];
  backing: string[];
  edges: ProjectEdge[];
  /** componentProblems(config).length: the graph keeps only the entries that are usable. */
  problems: number;
}

/** GET /api/roster: roster in lib/roster.ts. */
/** The builder's model overrides, as the roster reports them. */
export interface RosterModelBy {
  low: string | null;
  medium: string | null;
  high: string | null;
  rework: string | null;
}

export interface Roster {
  /** `modelBy`: the builder entry only, its runtime.modelByComplexity and runtime.reworkModel (null when unset or invalid). */
  agents: { role: string; description: string; model: string; promptHash: string; addendum: string | null; effort: Effort | null; effortSource: EffortSource; modelBy?: RosterModelBy }[];
  reviewers: { name: string; model: string; always: boolean; when: string | null; checklist: string | null; checklistHash: string | null; effort: Effort | null; effortSource: EffortSource }[];
  learnings: string | null;
  /** Entries in learnings.md; 0 when it is missing. */
  learningCount: number;
  /** The earliest valid review-by among all learnings, expired ones included. */
  oldestReviewBy: string | null;
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
  /** Marked needs-info by readiness triage (local `[?]`, GitHub `<prefix>needs-info`): ready lists leave it out. */
  needsInfo?: boolean;
}

/** A readiness rubric key a triage verdict can name: TRIAGE_MISSING in lib/triage.ts. */
export type TriageMissing = 'outcome' | 'acceptance' | 'scope' | 'duplicate';

/** The last triage verdict for an item, from the triage cache (lib/triage.ts). */
export interface TriageInfo {
  ready: boolean;
  missing: TriageMissing[];
  at: string;
}

/** A /api/backlog item: the tracker's item plus its last triage verdict, when there is one. */
export interface BacklogItem extends TrackerItem {
  triage?: TriageInfo;
}

/** GET /api/backlog: the handler in lib/server.ts over the tracker's list(). */
export interface BacklogResponse {
  tracker: string;
  items: BacklogItem[];
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

/** POST /api/jobs/:id/delete body: the job id typed back. */
export interface PostDeleteJobBody {
  confirm: string;
}

/** POST /api/jobs/:id/delete reply, and `forge job delete`'s output: deleteJob in lib/delete.ts. `branch` is null when Forge did not name it. */
export interface DeleteJobResult {
  deleted: string;
  title: string;
  worktree: string | null;
  branch: string | null;
  repos?: string[];
  /** Open requests for the job, now rejected. */
  requests: number;
}

/** POST /api/jobs/:id/repos body: the handler in lib/server.ts. `repos` are the names the drawer listed, which must be the whole pending set. */
export interface PostJobReposBody {
  decision: 'approve' | 'reject';
  repos: string[];
  note?: string | null;
}

/** POST /api/jobs/:id/repos reply: decideRepoProposals in lib/repo-proposals.ts, and whether the job was set running and resumed. */
export interface PostJobReposResponse {
  id: string;
  decision: 'approve' | 'reject';
  repos: string[];
  added: string[];
  pending: string[];
  resumed: boolean;
}

/** One row of a job's repo-proposals.json: RepoProposal in lib/types.ts (lib/repo-proposals.ts writes it). */
export interface RepoProposal {
  repo: string;
  reason: string;
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  actor: EventActor | null;
  note: string | null;
}

/** A focused job, as `forge focus` and /api/state report it: resolveFocus in lib/focus.ts. */
export interface FocusFact {
  id: string;
  title: string;
  since: string;
}

/**
 * One row of a job's Environment card: endpointsFor in lib/server.ts. A `component` row has a
 * `http://localhost:<port>/` url; a `backing` row has none. `live` is a boolean only on the component
 * row the dev command serves (the one whose port is `job.port`), null everywhere else.
 */
export interface Endpoint {
  kind: 'component' | 'backing';
  name: string;
  url: string | null;
  port: number;
  live: boolean | null;
}

/** POST /api/focus body: a job id to focus, or null to clear. */
export interface PostFocusBody {
  job: string | null;
}

/** One checkout step applied or undone on a focus change: lib/checkout.ts. `log` is relative to the job dir. */
export interface CheckoutStepResult {
  step: number;
  kind: 'link' | 'run';
  ok: boolean;
  to?: string;
  command?: string;
  log?: string;
  error?: string;
}

/** `forge focus <id>|--clear` and POST /api/focus reply: focusJob in lib/focus-actions.ts. */
export interface FocusResponse {
  focus: FocusFact | null;
  previous: string | null;
  /** Present only when a checkout step was undone or applied; `job` is the job whose steps were undone. */
  checkout?: { undone: CheckoutStepResult[]; applied: CheckoutStepResult[]; job?: string };
}

/** POST /api/jobs/:id/run body: `dev` is the only command the dashboard may start. */
export interface PostRunBody {
  command: 'dev';
}

/** POST /api/jobs/:id/run reply: startBackground in lib/worktree.ts, without the pid and log path. */
export interface PostRunResponse {
  reused: boolean;
  listening: boolean | null;
  port: number | null;
}

/** POST /api/jobs/:id/editor reply: the editor command that was started. */
export interface PostEditorResponse {
  ok: true;
  editor: string;
}

/** A job's dev server: `down` is a recorded pid that is dead (it crashed or was killed outside Forge). */
export type DevState = 'running' | 'starting' | 'down' | 'stopped';

/** GET /api/jobs/:id/environment's dev row: `pid` only while alive, `tail` (oldest first) only when `down`. */
export interface EnvironmentDev {
  state: DevState;
  pid: number | null;
  port: number | null;
  listening: boolean | null;
  startedAt: string | null;
  tail: string[];
}

/** A container's healthcheck status; null without a healthcheck or while not running. */
export type BackingHealth = 'healthy' | 'unhealthy' | 'starting' | null;

/** One `backing:` entry as the Environment card shows it (from `forge backing status <id>`). */
export interface EnvironmentService {
  name: string;
  isolation: string;
  managed: boolean;
  container: string | null;
  state: 'running' | 'stopped' | 'missing' | 'unknown' | 'external';
  health: BackingHealth;
  ports: Record<string, number>;
}

/** GET /api/jobs/:id/environment reply. `backingError` is the redacted reason the backing status failed. */
export interface JobEnvironmentResponse {
  job: string;
  active: boolean;
  worktree: boolean;
  dev: EnvironmentDev | null;
  backing: EnvironmentService[];
  backingError: string | null;
  /** Docker's state, asked only when a managed service reads `unknown`; null otherwise. */
  docker: 'ok' | 'missing' | 'stopped' | null;
  at: string;
}

export type EnvironmentTarget = 'dev' | 'backing';
export type EnvironmentAction = 'start' | 'stop' | 'restart';

/** POST /api/jobs/:id/environment body. */
export interface PostEnvironmentBody {
  target: EnvironmentTarget;
  action: EnvironmentAction;
}

/** POST /api/jobs/:id/environment reply, with the environment read after the action. */
export interface PostEnvironmentResponse {
  target: EnvironmentTarget;
  action: EnvironmentAction;
  ok: boolean;
  detail: string | null;
  environment: JobEnvironmentResponse;
}

/** CPU % and memory of a process group or a container; null where they can't be measured. */
export interface EnvironmentUsage {
  cpu: number | null;
  memBytes: number | null;
}

/** One row of GET /api/environments: a job (or, with `job: null`, the shared services) with what runs for it. */
export interface EnvironmentRow {
  job: string | null;
  title: string;
  state: string | null;
  focused: boolean;
  dev: ({ pid: number; port: number | null } & EnvironmentUsage) | null;
  containers: ({ name: string; backing: string } & EnvironmentUsage)[];
}

/** GET /api/environments reply: every running environment in this checkout. */
export interface EnvironmentsResponse {
  docker: 'ok' | 'missing' | 'stopped' | 'error';
  rows: EnvironmentRow[];
  at: string;
}

/**
 * JSON error body: jsonStatus for /api/daemon's and /api/config's 4xx and the catch-all 500 in lib/server.ts.
 * The POST guard failures (403/415/421) are text/plain, not this.
 */
export interface ApiError {
  error: string;
}
