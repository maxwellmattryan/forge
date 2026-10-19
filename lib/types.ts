// Shared data shapes of the engine, type-only: engine modules import these with `import type`, so
// this file never runs. The dashboard's src/lib/types.ts carries a copy of the API shapes, kept
// equal by test/types-parity.ts, until the dashboard imports this file. Unions that have a runtime
// list are derived from that list, never retyped.
import type { ACTOR_SOURCES, BACKING_ISOLATIONS, BUDGET_KEYS, COMPLEXITIES, DAEMON_AUTH, EFFORT_ROLES, EFFORTS, FOREMAN_SHIP, NOTIFY_EVENTS, NOTIFY_FORMATS, OFFICE_GATES, REPO_BUDGET_KEYS, REPO_BUDGET_MODES, SEVERITIES, STAGES, STATES, WAITING_ON } from './schema.ts';
import type { REQUEST_TYPES } from './requests.ts';
import type { COMPONENT_KINDS, DEPENDENCY_TYPES, INTERIM_STRATEGIES, LINK_ECOSYSTEMS } from './components.ts';
import type { SINK_FORMATS, SINK_MODES } from './config-sinks.ts';
import type { AcCoverage } from './acs.ts';
import type { RELEASE_CADENCES, RELEASE_MECHANISMS, RELEASE_PUBLISH, RELEASE_REGISTRIES, RELEASE_VERSIONINGS } from './release-strategy.ts';
import type { SECRET_KINDS } from './secrets.ts';
import type { JobFindings } from './findings.ts';

// ---------- enumerations ----------

/** A pipeline stage: STAGES in lib/schema.ts. */
export type Stage = (typeof STAGES)[number];
/** A job state: STATES in lib/schema.ts. */
export type JobState = (typeof STATES)[number];
/** Why a job waits: WAITING_ON in lib/schema.ts. */
export type WaitingOn = (typeof WAITING_ON)[number];
/** lib/schema.ts BUDGET_KEYS. */
export type BudgetKey = (typeof BUDGET_KEYS)[number];
/** A repo budget cap: REPO_BUDGET_KEYS in lib/schema.ts. */
export type RepoBudgetKey = (typeof REPO_BUDGET_KEYS)[number];
/** budget.onExceeded: REPO_BUDGET_MODES in lib/schema.ts. */
export type RepoBudgetMode = (typeof REPO_BUDGET_MODES)[number];
/** A review finding's severity: SEVERITIES in lib/schema.ts. */
export type Severity = (typeof SEVERITIES)[number];
/** A reasoning effort level: EFFORTS in lib/schema.ts. */
export type Effort = (typeof EFFORTS)[number];
/** Where a resolved effort came from: resolveEffort in lib/config.ts. */
export type EffortSource = 'job' | 'panel' | 'role' | 'complexity' | 'config' | 'none';
/** A spec's judged difficulty: COMPLEXITIES in lib/schema.ts. */
export type Complexity = (typeof COMPLEXITIES)[number];
/** A role with its own runtime.efforts entry: EFFORT_ROLES in lib/schema.ts. */
export type EffortRole = (typeof EFFORT_ROLES)[number];
/** What the secret scanner reports: SECRET_KINDS in lib/secrets.ts. */
export type SecretKind = (typeof SECRET_KINDS)[number];

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

/** `dead` only with a daemon-record proof (ownerStatusWithProof); the time rule alone gives the rest. */
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
  /** The human's interim strategy for this repo as a dependency (`forge job repo interim`); null inherits config. repos[0] mirrors `Job.interim`. normalizeJob always sets it. */
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
  owner: JobOwner | null;
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
  /** The human's interim strategy for the root repo as a dependency (`forge job repo interim --root`); null inherits config. */
  interim: InterimStrategy | null;
  /** The root repo first, then member repos: `forge job repo add|remove` in lib/job-repos.ts. */
  repos: JobRepo[];
}

/** One `policy.protectedPaths` rule: docs/CONFIG.md "Protected paths". */
export interface ProtectedRule {
  paths: string[];
  action: 'escalate' | 'refuse';
  reason: string;
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

/** A job as loadJob and normalizeJob return it: normalizeJob marks one written by a newer Forge. */
export type LoadedJob = Job & { _unsupported?: true };

// ---------- forge job step (lib/step.ts; not /api shapes) ----------

/** What a `wait` waits on: a gate, or the agents still running. */
export type StepWaitingOn = WaitingOn | 'agents';

interface StepBase {
  id: string;
  /** The rule in lib/step.ts RULES that chose this action. */
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
  resume?: string;
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

/** The round's or integration review's verdicts as step reads them: roundVerdicts in lib/jobs.ts. */
export interface StepVerdicts {
  complete: boolean;
  outcome: string;
  reviewers: Record<string, { verdict: string }>;
}

/** Everything `step` decides from, read once by loadStepInput in lib/step.ts. */
export interface StepInput {
  job: Job;
  config: Config;
  root: string;
  jobDir: string;
  pluginRoot: string;
  /** jobPathMap in lib/brief.ts. */
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
  spec: { size: string | null; complexity: string | null; needsDesign: boolean; services: string[]; suggested: string[]; approachPaths: string[]; uiAcs: string[] };
  /** design.md's `## Spec deltas` section is non-empty and not None. */
  designDeltas: boolean;
  decision: { decision: string | null; autoMerge: boolean };
  runbookBeforeMerge: boolean;
  verdicts: { round: StepVerdicts | null; integration: StepVerdicts | null };
  acs: AcCoverage;
  /** The record names in runtime.json. */
  runtime: string[];
  /** The events step reads, oldest first: human, round, worktree*, pr-*, scope, integrate*, integration-review, decision, fields, eval-graded, transition, agent-start/end. */
  events: JobEvent[];
  evalTask: { rubric: string | null; reference: string | null } | null;
  /** Checklist path per panel lens and selected reviewer. */
  checklists: Record<string, string | null>;
  /**
   * In integrate: what the last conflict episode's resolution changed at the last verified sha
   * (lib/scope.ts integrationTouched), keyed by the sides that event recorded; null when unknown.
   */
  integrationTouched: { head: string; upstream: string; sha: string; files: string[] | null } | null;
  /** How many `.forge/verifiers/*.md` entries the main checkout has: 0 keeps the verify stage as it was. */
  verifiers: number;
  /** The job's and the project's backing port records, for the brief's Backing services line; absent without backing entries. */
  backing?: { job: BackingRecord; shared: BackingRecord };
}

/** The job files StepInput.files records. */
export type StepFile = 'request' | 'plan' | 'spec' | 'design' | 'mockup' | 'build' | 'tasks' | 'questions' | 'feedback' | 'prFeedback' | 'runbook' | 'decision' | 'scope' | 'issueCandidates' | 'evalJudge';

/** One member repo an agent proposed for a job (lib/repo-proposals.ts), as repo-proposals.json lists it. */
export interface RepoProposal {
  repo: string;
  reason: string;
  proposedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt: string | null;
  actor: EventActor | null;
  note: string | null;
}

// ---------- events ----------

/** What setJob in lib/jobs.ts applies; stage, state and waitingOn are checked against their lists before the write. */
export interface JobChange {
  stage?: string;
  state?: string;
  waitingOn?: string | null;
  reason?: string | null;
  fields?: Record<string, any>;
  note?: string;
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

// ---------- secret scanning (lib/secrets.ts) ----------

/** Text the scanner reads: a run of added lines, a whole file, or text Forge is about to send. */
export interface TextUnit {
  /** A repo path, a job-dir path, or a label in parentheses such as `(pr body)`. */
  path: string;
  /** The line `text` starts on. */
  line: number;
  text: string;
  /** Repository content: path globs in the allowlist apply, and so does the entropy check. */
  file: boolean;
  /** 12-char sha, `staged`, or null. */
  commit: string | null;
  /** Overrides the entropy check, which otherwise follows `file` (agent output is text, but checked). */
  entropy?: boolean;
}

/** One likely credential. Never holds the value: `excerpt` is masked and `fingerprint` is its sha256. */
export interface SecretFinding {
  kind: SecretKind;
  path: string;
  line: number;
  excerpt: string;
  /** `sha256:` + 64 hex of the full value. */
  fingerprint: string;
  commit: string | null;
  /** `.forge/secrets-allow.txt:<line>`, on an allowed finding. */
  allowedBy?: string;
}

/** `.forge/secrets-allow.txt` in the main checkout: loadAllowlist. */
export interface SecretAllowlist {
  file: string;
  present: boolean;
  entries: number;
  problems: string[];
  globs: { glob: string; line: number }[];
  prints: Map<string, number>;
}

/** One valid `.forge/verifiers/<name>.md`: loadVerifiers in lib/verifiers.ts. */
export interface Verifier {
  name: string;
  /** Globs matched with inSpec (lib/scope.ts). */
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

/** What `forge verifiers run` returns: verifiersRun in lib/verifiers.ts. */
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

/** A selected verifier's answer: parseAnswers in lib/verifiers.ts; `none` fails closed. */
export type VerifierAnswer = 'yes' | 'no' | 'none';

/** What `forge verifiers record` returns: verifiersRecord in lib/verifiers.ts. */
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

/** A scan's result: scanBranch, scanPaths, scanAgentOutputs. `error` means it did not finish. */
export interface SecretScan {
  findings: SecretFinding[];
  allowed: SecretFinding[];
  scanned: { commits: number; files: number; texts: number; skipped: number };
  allowlist: SecretAllowlist;
  base: string | null;
  mergeBase: string | null;
  error?: string;
}

/** The `secrets` key of verify's JSON: compactSecrets. */
export interface CompactSecrets {
  mode: 'block' | 'warn';
  ok: boolean;
  count: number;
  allowed: number;
  findings: { kind: SecretKind; path: string; line: number }[];
  more: number;
  error?: string;
}

// ---------- config ----------

/** One review lens: an entry of review.panel in defaults() (lib/config.ts). */
export interface PanelEntry {
  name: string;
  always?: boolean;
  model?: string;
  when?: string;
  checklist?: string;
  /** This lens's reasoning effort; beats runtime.efforts.reviewer, not a job's own. */
  effort?: Effort | null;
  /** Whether the lens reviews the running app (commands.dev); absent means the name default in lensNeedsApp. */
  needsApp?: boolean;
  /** Globs matched against the job's committed diff by `forge job panel`: a match adds the lens for the round. */
  paths?: string[];
  /** Chosen only by `always`, a `paths` hit or carry, never by Suggested reviewers or the Approach. */
  pathsOnly?: boolean;
}

/** Something agents should know exists: an entry of `resources` (docs/CONFIG.md). */
export interface ResourceConfig {
  name: string;
  kind?: string;
  url?: string;
  path?: string;
  use?: string;
}

export type ComponentKind = (typeof COMPONENT_KINDS)[number];
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export type LinkEcosystem = (typeof LINK_ECOSYSTEMS)[number];
export type InterimStrategy = (typeof INTERIM_STRATEGIES)[number];
export type ReleaseVersioning = (typeof RELEASE_VERSIONINGS)[number];
export type ReleaseMechanism = (typeof RELEASE_MECHANISMS)[number];
export type ReleaseRegistry = (typeof RELEASE_REGISTRIES)[number];
export type ReleaseCadence = (typeof RELEASE_CADENCES)[number];
/** Whether `forge release run` asks before a publish step; null asks too. */
export type ReleasePublish = (typeof RELEASE_PUBLISH)[number];

/** A repo's release strategy beside its interim strategy (docs/CONFIG.md "Release strategy"); null or absent is undeclared. */
export interface ReleaseStrategy {
  versioning?: ReleaseVersioning | null;
  mechanism?: ReleaseMechanism | null;
  /** The release command a human runs; only read with `mechanism: tag`. */
  command?: string | null;
  registry?: ReleaseRegistry | null;
  cadence?: ReleaseCadence | null;
  /** `allow` lets `forge release run` run this repo's publish steps without asking; null or `confirm` asks on a terminal. */
  publish?: ReleasePublish | null;
}

/** A `dependsOn` edge's local link (docs/CONFIG.md "Components"): the consumer builds against the dependency's job worktree. */
export interface ComponentLink {
  ecosystem: LinkEcosystem;
  /** The crate, FetchContent or package name. */
  name: string;
  /** cargo only: the `[patch.<source>]` table; absent or null is `crates-io`. */
  source?: string | null;
  /** The directory in the dependency's repo; absent or null is the dependency component's `path`. */
  path?: string | null;
  /** The consumer's manifest an interim pin is written to, relative to the consumer repo's root; absent or null is the ecosystem's file in the consumer component's path. */
  manifest?: string | null;
}

/** One edge of a component's `dependsOn`: exactly one of `component` or `backing` is set. */
export interface ComponentDependency {
  component?: string;
  backing?: string;
  type: DependencyType;
  /** Only on a `component` edge to a component of another repo. */
  link?: ComponentLink;
}

/** One part of a repo: an entry of `components` (docs/CONFIG.md "Components"). */
export interface ComponentConfig {
  name: string;
  /** a `repos` name; null or absent: the root repo. */
  repo?: string | null;
  path: string;
  kind: ComponentKind;
  commands?: Record<string, string | null>;
  dependsOn?: ComponentDependency[];
  owners?: string[];
  notes?: string | null;
  /** Config sinks rendered before each of this component's commands (docs/CONFIG.md "Config sinks"); root repo only. */
  config?: ConfigSink[];
}

export type SinkFormat = (typeof SINK_FORMATS)[number];
export type SinkMode = (typeof SINK_MODES)[number];
/** Merge `values`: a nested map whose leaves are strings (expressions), numbers, booleans or null. */
export type SinkValues = { [k: string]: string | number | boolean | null | SinkValues };

/** One config sink: a map with exactly one kind key (lib/config-sinks.ts). */
export type ConfigSink =
  | { env: Record<string, string> }
  | { 'env-file': string; values?: Record<string, string> }
  | { file: { path: string; format: SinkFormat; mode: SinkMode; from?: string | null }; values?: SinkValues }
  | { command: string; values?: Record<string, string> };

/** One member repo: an entry of `repos` (docs/CONFIG.md "Repos"). The root repo is implicit. */
export interface MemberRepoConfig {
  name: string;
  remote: string;
  defaultBranch: string;
  tracker?: { kind: 'github' | 'none'; repo?: string | null } | null;
  /** How the repo releases: its interim strategy as a dependency and its release strategy (docs/CONFIG.md "Release strategy"). */
  release?: ({ interim?: InterimStrategy } & ReleaseStrategy) | null;
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

/** One `verify` entry: a step name, or a group of step names that run at the same time (config schemaVersion 3). */
export type VerifyEntry = string | string[];

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
    generated: string[];
    generatedBy: string;
  };
  commands: CommandsConfig;
  verify: VerifyEntry[];
  verifyE2e: {
    when: 'ui' | 'always' | 'never';
    paths: string[];
  };
  verifyIntegrity: 'warn' | 'block';
  verifySecrets: 'block' | 'warn';
  ports: { base: number; span: number };
  runtime: {
    provider: string;
    host: string;
    maxParallelJobs: number;
    diversity: boolean;
    /** The default reasoning effort for jobs; null leaves it to Claude Code's own setting. */
    effort: Effort | null;
    /** Per-role effort; null falls through to effortByComplexity, then effort. */
    efforts: Record<EffortRole, Effort | null>;
    /** Effort by the spec's complexity, for a role with no effort of its own. */
    effortByComplexity: Record<Complexity, Effort | null>;
    models: Record<string, string>;
    /** The builder's model by the spec's complexity; null falls through to models.builder. */
    modelByComplexity: Record<Complexity, string | null>;
    /** The builder's model on a rework round that only addresses review findings; null falls through. */
    reworkModel: string | null;
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
    /** Rounds 2+: `narrow` re-runs only the rework panel (forge job panel's `rerun`), `full` every lens. */
    onRework: 'narrow' | 'full';
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
    integrationReview: 'always' | 'code-only';
  };
  merge: {
    auto: boolean;
    method: 'squash' | 'merge' | 'rebase';
    autoWhen: string[];
  };
  aiAttribution: 'forbid' | 'allow';
  /** The root repo's release settings: its interim strategy as a dependency and its release strategy, every key present once defaults fill it (docs/CONFIG.md "Release strategy"). */
  release: { interim: InterimStrategy } & { [K in keyof ReleaseStrategy]-?: ReleaseStrategy[K] };
  resources: ResourceConfig[];
  components: ComponentConfig[];
  repos: MemberRepoConfig[];
  /** Steps `forge focus` applies to the focused job and undoes on the next change: lib/checkout.ts. */
  checkout: CheckoutStep[];
  /** Databases, caches and queues jobs run against: lib/backing.ts, docs/CONFIG.md "Backing services". */
  backing: BackingEntry[];
  /** Verify-only consumers of a changed library: docs/CONFIG.md "Downstream verification". */
  downstream: { enabled: boolean; max: number; skip: string[] };
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
    auth: DaemonAuth;
  };
  /** The office session's authority: docs/CONFIG.md "Foreman". */
  foreman: {
    enabled: boolean;
    decides: GateClass[];
    reserved: string[];
    ship: ForemanShip;
  };
  /** Paths the CLI refuses to write or escalates to a human: docs/CONFIG.md "Protected paths". */
  policy: { protectedPaths: ProtectedRule[] };
  /** What Forge deletes and when; null keeps forever: docs/CONFIG.md "Retention". */
  retention: { jobsDays: number | null; logsDays: number | null; logMaxBytes: number | null };
  /** Where Forge pushes gate, PR, failure and budget notifications: docs/CONFIG.md "Notifications". */
  notify: { webhooks: NotifyWebhook[]; command: string | null };
  /** Repo-wide spend caps per UTC day and month: docs/CONFIG.md "Repo budget". */
  budget: RepoBudgetConfig;
}

/** config `budget:`; null means unlimited. */
export interface RepoBudgetConfig {
  usdPerDay: number | null;
  usdPerMonth: number | null;
  tokensPerMonth: number | null;
  onExceeded: RepoBudgetMode;
}

/** One day, role and model's spend in the ledger: lib/spend.ts. */
export interface SpendBucket {
  runs: number;
  tokens: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  usd: number;
}

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

/** A notify event: NOTIFY_EVENTS in lib/schema.ts. */
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
/** notify.webhooks[].format: NOTIFY_FORMATS in lib/schema.ts. */
export type NotifyFormat = (typeof NOTIFY_FORMATS)[number];
/** One notify.webhooks entry; `events` omitted subscribes to every event, `format` defaults to json. */
export interface NotifyWebhook {
  url: string;
  events?: NotifyEvent[];
  format?: NotifyFormat;
}

/** A gate class the foreman may decide: OFFICE_GATES in lib/schema.ts. */
export type GateClass = (typeof OFFICE_GATES)[number];
/** foreman.ship: FOREMAN_SHIP in lib/schema.ts. */
export type ForemanShip = (typeof FOREMAN_SHIP)[number];
/** Where an event's actor came from: ACTOR_SOURCES in lib/schema.ts. */
export type ActorSource = (typeof ACTOR_SOURCES)[number];
/** Who did a human action (lib/actor.ts); `login` is null for the foreman and when nothing resolved. */
export interface EventActor {
  login: string | null;
  source: ActorSource;
}

/** One row of `forge job audit` / `forge audit` (lib/audit.ts); `job` is null for the repo-level log. */
export interface AuditRow {
  ts: string;
  job: string | null;
  actor: EventActor | null;
  /** The `human` event's action, else the event type, else `gate:<waitingOn>` / `gate-cleared:<waitingOn>`. */
  action: string;
  /** The human's note or the transition's reason. */
  note: string | null;
  /** A short per-type summary: budget keys, the PR and merge method, the linked ref, the permission tool. */
  detail: string | null;
}

/** `forge job audit <id> --json`. */
export interface JobAudit {
  id: string;
  title: string;
  pr: { number: number | null; mergeMethod: string | null; merged: boolean };
  rows: AuditRow[];
}

/** `forge audit --json`. */
export interface RepoAudit {
  since: string;
  until: string;
  rows: AuditRow[];
}
/** Who owns a waiting job's gate: gateOwner in lib/foreman.ts; null when the job waits on nothing. */
export type GateOwner = 'foreman' | 'human' | null;

/** Which credential a daemon session runs on: the Claude login (subscription) or an API key from the environment. */
export type DaemonAuth = (typeof DAEMON_AUTH)[number];

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

/** What setConfigValue in lib/config.ts returns: `forge config set` and POST /api/config. */
export interface PostConfigResponse {
  ok: true;
  key: string;
  value: ConfigValue;
  previous: unknown;
  changed: boolean;
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

// ---------- forge doctor --bundle ----------

/** How many spans of each class lib/redact.ts replaced. */
export interface RedactCounts {
  secrets: number;
  paths: number;
  emails: number;
  logins: number;
}

/** One zip entry and its uncompressed size. */
export interface BundleEntry {
  name: string;
  bytes: number;
}

/** A file the bundle left out instead of reading: a symlink, a FIFO, one outside its dir, or unreadable. */
export interface BundleSkip {
  name: string;
  reason: string;
}

/** The support bundle's manifest.json: buildBundle in lib/bundle.ts. Names are already redacted. */
export interface BundleManifest {
  createdAt: string;
  forgeVersion: string;
  includeText: boolean;
  jobs: string[];
  entries: BundleEntry[];
  skipped: BundleSkip[];
  redactions: RedactCounts;
}

/** `forge doctor --bundle`'s stdout. */
export interface BundleResult {
  file: string;
  bytes: number;
  entries: BundleEntry[];
  skipped: BundleSkip[];
  redactions: RedactCounts;
  includeText: boolean;
  jobs: string[];
}

// ---------- forge update ----------

/** How the running Forge was installed: detectInstall in lib/update.ts. */
export type InstallKind = 'plugin' | 'git' | 'unknown';

/** The running install as detectInstall in lib/update.ts sees it. */
export interface InstallInfo {
  kind: InstallKind;
  root: string;
  version: string;
  /** `<plugin>@<marketplace>`, plugin installs only. */
  plugin?: string;
  marketplace?: string;
  /** The Claude Code `plugins/` dir the install sits under. */
  pluginsDir?: string;
  /** Why a path that looked like a plugin install was not trusted. */
  reason?: string;
}

/** How `forge version --json` names the install: InstallKind with `git` read as a clone. */
export type InstalledAs = 'plugin' | 'clone' | 'unknown';

/** `forge version --json`: versionInfo in lib/version.ts. */
export interface VersionInfo {
  version: string;
  /** 40 lowercase hex, or null when no source could say. */
  commit: string | null;
  installedAs: InstalledAs;
  node: string;
}

/** What `forge update --check` prints: updateForge in lib/update.ts. */
export interface UpdateCheck {
  kind: InstallKind;
  root: string;
  version: string;
  plugin?: string;
  branch?: string;
  upstream?: string;
  commands: string[];
  blocked?: string;
  dashboard?: { running: true; url: string };
  warnings?: string[];
}

/** This repo's dashboard after an update: updateForge in lib/update.ts. */
export type UpdateDashboard = { restarted: true; url?: string } | { running: true; stale: true; url: string };

/** What `forge update` prints: updateForge in lib/update.ts. */
export interface UpdateResult {
  kind: InstallKind;
  root: string;
  from: string;
  to: string;
  updated: boolean;
  /** Only when the update moved the install to another directory. */
  newRoot?: string;
  /** Git installs: short shas before and after. */
  head?: { from: string; to: string };
  commands: string[];
  dashboard?: UpdateDashboard;
  warnings?: string[];
  next: string[];
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
  /** Marked needs-info by readiness triage (local `[?]`, GitHub `<prefix>needs-info`): ready lists leave it out. */
  needsInfo?: boolean;
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
  /**
   * Optional: open items matching a free-text query, best first, at most `opts.limit` of them
   * (bodies included, for local re-ranking). Without it, searchTracker in lib/tracker-link.ts scores
   * a capped list() instead.
   */
  search?: (ctx: TrackerCtx, query: string, opts: { limit: number }) => TrackerItem[];
  /**
   * Optional: readiness triage's mark (lib/triage.ts). A note (one line Forge renders from fixed
   * text) marks the item needs-info, so list({ready: true}) leaves it out; null clears the mark.
   */
  setNeedsInfo?: (ctx: TrackerCtx, ref: string, note: string | null) => void;
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
  /** foreman.enabled, from the latest read of config.yml: the dashboard shows the office only then. */
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

/** What a transcript's agent did last: lastActivity in lib/transcripts.ts. Plain text, at most 160 characters. */
export interface TranscriptActivity {
  kind: 'tool' | 'text';
  text: string;
  at: string | null;
}

/** One running agent of a job in /api/state: state() in lib/server.ts. `last` is null when no transcript is found. */
export interface AgentActivity {
  role: string;
  model: string | null;
  startedAt: string | null;
  last: TranscriptActivity | null;
}

/** One agent of the job's current round (or still running) in the job detail: jobDetail() in lib/server.ts. */
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

/** A job row in /api/state: state() in lib/server.ts. */
/** The last event that carries an actor: who last acted on a job (lastHuman in lib/server.ts). */
export interface LastHuman {
  ts: string;
  type: string;
  action: string | null;
  actor: EventActor;
}

export type StateJob = Job & { progress: Progress; lastEvent: JobEvent | null; eventCount: number; ownerStatus: OwnerStatus; activity: AgentActivity[]; gateOwner: GateOwner; lastHuman: LastHuman | null; endpoints: Endpoint[] };

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
  /** The focused job (forge focus), or null when none is focused or it is gone or finished. */
  focus: FocusFact | null;
  /** Repo spend against the day and month caps. */
  budget: RepoBudgetStatus;
  now: string;
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

/** One entry of `.forge/notes/learnings.md`: parseLearnings in lib/learnings.ts. Dates are valid or null. */
export interface LearningEntry {
  /** Unsanitised; callers pass it through safeText before writing it anywhere. */
  rule: string;
  experiment: string | null;
  reviewBy: string | null;
  added: string | null;
}

/** One line of `.forge/notes/experiments.md`: parseExperiments in lib/learnings.ts. */
export interface ExperimentEntry {
  id: string | null;
  date: string | null;
  change: string;
  metric: string | null;
  direction: 'up' | 'down' | null;
  baseline: number | null;
  status: string | null;
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
  kind: ComponentKind;
  path: string;
}

/** One dependsOn edge of GET /api/project, from the dependent to its dependency. */
export interface ProjectEdge {
  from: string;
  to: string;
  target: 'component' | 'backing';
  type: DependencyType;
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

/** One `checkout:` entry: a fixed path linked to the focused job's build, or a configured command (with an optional undo). */
export type CheckoutStep = { link: string; to: string } | { run: string; undo?: string | null };

/** How a backing service is shared: a container per job, one per project, or an address run elsewhere. */
export type BackingIsolation = (typeof BACKING_ISOLATIONS)[number];

/** One `backing:` entry (lib/backing-config.ts validates it). image, ports, env and volumes are for managed (per-job, shared) entries only. */
export interface BackingEntry {
  name: string;
  isolation: BackingIsolation;
  image?: string;
  ports?: number[];
  env?: Record<string, string | number | boolean>;
  volumes?: string[];
  url?: string;
}

/** `.forge/jobs/<job>/backing.json` and `.forge/runtime/backing.json`: host port per container port, per entry name. */
export interface BackingRecord {
  v: 1;
  ports: Record<string, Record<string, number>>;
}

/** One service in `forge worktree create` and `forge backing up`. */
export interface BackingUpEntry {
  name: string;
  isolation: BackingIsolation;
  /** What Forge did, or on a failure what it attempted: `none` when it failed before running or starting a container. */
  action: 'created' | 'started' | 'running' | 'external' | 'none';
  ok: boolean;
  error?: string;
}

/** `forge backing down <job>` and the `backing` key of `forge worktree remove`. */
export interface BackingDownResult {
  removed: string[];
  volumes: string[];
  ok: boolean;
  error?: string;
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

/**
 * JSON error body: jsonStatus for /api/daemon's and /api/config's 4xx and the catch-all 500 in lib/server.ts.
 * The POST guard failures (403/415/421) are text/plain, not this.
 */
export interface ApiError {
  error: string;
}

/** What a command runs against: mainRoot(), loadConfig() and whether `.forge/` exists. */
export interface CliContext {
  root: string;
  config: Config;
  initialized: boolean;
}

/** One command's outcome from `dispatch` in lib/cli.ts: `main` prints `data` unless the command `printed` itself. */
export interface Dispatched {
  data?: unknown;
  exitCode: number;
  pretty?: true;
  printed?: true;
}

/** The dispatcher, passed in so lib/commands/ never imports lib/cli.ts. */
export type Dispatch = (argv: string[], ctx: CliContext) => Promise<Dispatched>;

/** One command `forge job advance` ran: `result`/`error` are one line of at most 200 characters. */
export interface AdvanceRan {
  rule: string;
  command: string[];
  ok: boolean;
  result?: string;
  error?: string;
  tell?: string;
}

/** The `error` object `forge … --json` prints on stdout when a command fails: toCliError in lib/commands/help.ts. */
export interface CliError {
  /** One of ERROR_CODES in lib/util.ts. */
  code: string;
  message: string;
  /** The process exit code. */
  exit: number;
  /** A next command to run, or null. */
  hint: string | null;
}

/** One row of `forge status --json`: statusRows in lib/commands/status.ts. */
export interface StatusRow {
  id: string;
  stage: Stage;
  state: JobState;
  waitingOn: WaitingOn | null;
  round: number;
  tasks: { done: number; total: number };
  pr: number | null;
  /** The owner's full session id. */
  session: string | null;
}

/** One `forge <command>` in the help tables (`HELP` beside each command module). */
export interface CommandHelp {
  /** The words after `forge`: `job step`, or the group name for a one-command group (`verify`). */
  command: string;
  /** What follows the command on its usage line: `<id> [--session S]`. */
  args: string;
  summary: string;
  /** Every flag the command reads, beyond the global ones. */
  flags?: [flag: string, meaning: string][];
  /** Every exit other than 0 and 2 the command can produce. */
  exits?: [code: 1 | 3 | 4 | 5, when: string][];
  docs?: [label: string, href: string];
  /** A row of README's generated command table. */
  readme?: true;
}

/** A command group: `forge job …`, or a single command such as `forge verify`. */
export interface HelpGroup {
  name: string;
  summary: string;
  commands: CommandHelp[];
}

/** What archived a job: `forge job archive`, `forge job prune`, or the retention policy (lib/retention.ts). */
export type RetentionTrigger = 'cli' | 'prune' | 'policy';

/** The facts an archive record keeps beside the raw job and events, so readers need no job dir. */
export interface ArchiveSummary {
  title: string;
  kind: string;
  state: string;
  createdAt: string | null;
  finishedAt: string | null;
  rounds: number;
  pr: { number: number | null; state: string | null; url: string | null } | null;
  verdicts: Job['verdicts'];
  usage: { totalTokens: number; estCostUsd: number };
  /** jobFindings, read before the job dir (its review files and build.md) was deleted. */
  findings: JobFindings;
  bytesFreed: number;
}

/** `.forge/archive/<id>.json` as written. */
export interface ArchiveRecord {
  archiveVersion: number;
  id: string;
  archivedAt: string;
  trigger: RetentionTrigger;
  job: Job;
  events: JobEvent[];
  summary: ArchiveSummary;
}

/** An archive record as readers see it: the job normalised, events in the current shape. */
export interface ArchivedJob {
  id: string;
  archivedAt: string;
  trigger: RetentionTrigger;
  job: LoadedJob;
  events: JobEvent[];
  summary: ArchiveSummary;
}

/** `forge job archive` output. */
export interface ArchiveResult {
  archived: { id: string; file: string; bytes: number }[];
  refused: { id: string; reason: string }[];
}

/** `forge job prune` output; `file` is relative to the repo root. */
export interface PruneResult {
  dryRun: boolean;
  jobs: { id: string; bytes: number }[];
  refused: { id: string; reason: string }[];
  logs: { scope: string; file: string; bytes: number }[];
  freedBytes: number;
}
