// Shared data shapes of the engine, type-only: engine modules import these with `import type`, so
// this file never runs. The /api/* and SSE shapes live in api-types.ts, re-exported here, and the
// dashboard imports those. Unions that have a runtime list are derived from that list, never retyped.
import type { BACKING_DB_ENGINES, BACKING_ISOLATIONS, DAEMON_AUTH, EFFORT_ROLES, FOREMAN_SHIP, NOTIFY_EVENTS, NOTIFY_FORMATS, SEVERITIES } from './schema.ts';
import type { LINK_ECOSYSTEMS } from './components.ts';
import type { SINK_FORMATS, SINK_MODES } from './config-sinks.ts';
import type { AcCoverage } from './acs.ts';
import type { RELEASE_CADENCES, RELEASE_MECHANISMS, RELEASE_PUBLISH, RELEASE_REGISTRIES, RELEASE_VERSIONINGS } from './release-strategy.ts';
import type { SECRET_KINDS } from './secrets.ts';
import type { JobFindings } from './findings.ts';
import type { Complexity, ComponentKind, DaemonJobBudget, DependencyType, Effort, EventActor, ForemanHandoff, GateClass, InstalledAs, InterimStrategy, Job, JobEvent, JobState, PipelineConfig, RepoBudgetMode, Stage, Stats, TrackerItem, WaitingOn } from './api-types.ts';

export type * from './api-types.ts';

// ---------- enumerations ----------

/** A review finding's severity: SEVERITIES in lib/schema.ts. */
export type Severity = (typeof SEVERITIES)[number];
/** A role with its own runtime.efforts entry: EFFORT_ROLES in lib/schema.ts. */
export type EffortRole = (typeof EFFORT_ROLES)[number];
/** What the secret scanner reports: SECRET_KINDS in lib/secrets.ts. */
export type SecretKind = (typeof SECRET_KINDS)[number];

// ---------- job data ----------

/** One `policy.protectedPaths` rule: docs/CONFIG.md "Protected paths". */
export interface ProtectedRule {
  paths: string[];
  action: 'escalate' | 'refuse';
  reason: string;
}

/** A job as loadJob and normalizeJob return it: normalizeJob marks one written by a newer Forge. */
export type LoadedJob = Job & { _unsupported?: true };

// ---------- forge job step (lib/step/; not /api shapes) ----------

/** What a `wait` waits on: a gate, or the agents still running. */
export type StepWaitingOn = WaitingOn | 'agents';

interface StepBase {
  id: string;
  /** The rule in lib/step/rules.ts RULES that chose this action. */
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

/** Everything `step` decides from, read once by loadStepInput in lib/step/input.ts. */
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
  /** The job's entry in the environment record (lib/environment-record.ts); null when it has none. */
  environment: EnvironmentState | null;
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
  /**
   * The decide gate's recall eval (lib/step/input.ts loadRecall): whether the committed diff touches
   * evals.recall.paths, and the worktree's pluginHash a recorded run must match. `invalidFixtures`
   * when the gate is required but a main-checkout fixture does not load, so `start` cannot run and
   * RC2 parks at once. Null outside decide, for an eval job, without a worktree, or when the main
   * checkout has no recall fixture.
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
}

/** The job files StepInput.files records. */
export type StepFile = 'request' | 'plan' | 'spec' | 'design' | 'mockup' | 'build' | 'tasks' | 'questions' | 'feedback' | 'prFeedback' | 'runbook' | 'decision' | 'scope' | 'issueCandidates' | 'evalJudge' | 'score';

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
  /** `sha256:` + 64 hex of the full value; for a `known-secret`, `known:` + 12 hex keyed per process, never the value's hash. */
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
  /** Re-run on every rework round under review.onRework: narrow; absent means the name default in lensAlwaysOnRework. */
  alwaysOnRework?: boolean;
}

/** Something agents should know exists: an entry of `resources` (docs/CONFIG.md). */
export interface ResourceConfig {
  name: string;
  kind?: string;
  url?: string;
  path?: string;
  use?: string;
}
export type LinkEcosystem = (typeof LINK_ECOSYSTEMS)[number];
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

/** Where one declared secret's value comes from: exactly one source key (lib/secret-refs-config.ts). */
export type SecretSource =
  | { env: string }
  | { keychain: { service: string; account?: string } }
  | { op: string }
  | { file: string; key?: string };

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
    /** Consecutive CI reworks forge sync starts before a red head waits for a person. */
    maxCiReworks: number;
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
  /** Named credentials config sinks reach as `{secret.NAME}`: lib/secret-refs.ts, docs/CONFIG.md "Secret references". */
  secrets: Record<string, SecretSource>;
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
  /** experiments: how many after-jobs `forge experiment evaluate` needs to decide an entry (minJobs) and when it closes one undecided (maxJobs). */
  improve: { retroEvery: number; maxLearnings: number; experiments: { minJobs: number; maxJobs: number } };
  /** recall.paths: committed paths (inSpec tokens) that make the decide gate ask for a recall eval. */
  evals: { testPattern: string | null; recall: { paths: string[] } };
  dashboard: { port: number };
  daemon: {
    enabled: boolean;
    command: string;
    allowedTools: string[];
    maxConcurrent: number;
    idleStopMinutes: number | null;
    /** A turn busy past this is stopped and its work requeued; null: no limit. */
    turnTimeoutMinutes: number | null;
    auth: DaemonAuth;
    jobBudget: DaemonJobBudget;
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
  /** Job environments running at once; null means no cap (lib/environment-lifecycle.ts eviction). */
  environments: { maxRunning: number | null };
  /** How long after a merge `forge sync` watches a job's outcome: docs/CONFIG.md "Outcomes". */
  outcomes: { windowDays: number };
  /** The share of merged jobs that get one post-merge judge run, and its model: docs/CONFIG.md "Scoring". */
  scoring: { sample: number; model: string | null };
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
/** foreman.ship: FOREMAN_SHIP in lib/schema.ts. */
export type ForemanShip = (typeof FOREMAN_SHIP)[number];

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

/** Which credential a daemon session runs on: the Claude login (subscription) or an API key from the environment. */
export type DaemonAuth = (typeof DAEMON_AUTH)[number];

/** What loadConfig in lib/config.ts returns. */
export interface LoadedConfig {
  config: Config;
  initialized: boolean;
  path: string;
  migratedFrom?: number;
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

// ---------- tracker contract ----------

/** What every tracker method receives: loadTracker's callers (lib/trackers/index.ts). */
export interface TrackerCtx {
  root: string;
  config: Config;
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

/** One finished (or aborted) dashboard request, as startServer's onRequest hook reports it: lib/activity.ts. */
export interface RequestInfo {
  method: string;
  /** The pathname only: a query string can carry the dashboard token. */
  path: string;
  status: number | 'aborted';
  ms: number;
  /** The response was a server-sent-event stream. */
  sse: boolean;
}

/** One prompt cohort of `forge stats --by prompt` (statsByPrompt in lib/stats.ts). */
export interface PromptCohort {
  promptHash: string;
  jobs: number;
  /** The first 20, oldest keyed start first. */
  jobIds: string[];
  /** The earliest and latest keyed start of the cohort's jobs. */
  firstAt: string;
  lastAt: string;
  /** At most 5 each, in run order. */
  pluginHashes: string[];
  configHashes: string[];
  /** The full metrics over this cohort's jobs only. */
  stats: Stats;
}

/** `forge stats --by prompt`: jobs keyed by the promptHash on their role's last hashed agent-start. */
export interface PromptStats {
  by: 'prompt';
  role: string;
  since: string | null;
  /** Oldest firstAt first. */
  cohorts: PromptCohort[];
  /** Jobs with no hashed start for the role. */
  unrecorded: number;
  /** Jobs whose starts for the role carry more than one hash. */
  mixed: number;
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
  /** The baseline's sample size: the denominator of a `0.344 (11/32)` baseline, else null. */
  baselineN: number | null;
  status: string | null;
}

/** One `forge experiment evaluate` result (lib/experiments.ts). */
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

// ---------- POST bodies and replies ----------

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
  /** Shared entries only: a job database per job on this server, cloned from a template database (lib/backing-db.ts). */
  database?: BackingDatabase;
}

/** A shared entry's `database`: the engine, and the commands and files that build its template database. */
export interface BackingDatabase {
  engine: (typeof BACKING_DB_ENGINES)[number];
  migrate?: string;
  seed?: string;
  inputs?: string[];
}

/** One `docker` call's outcome: lib/backing.ts and lib/backing-db.ts. */
export interface DockerResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
  /** The docker binary is not on PATH. */
  missing?: boolean;
}

/** Runs `docker <args>`, with `input` on stdin (psql's SQL); tests inject an in-memory fake. */
export type DockerRunner = (args: string[], opts?: { timeoutMs?: number; input?: string }) => DockerResult;

/** `.forge/jobs/<job>/backing.json` and `.forge/runtime/backing.json`: host port per container port, per entry name. */
export interface BackingRecord {
  v: 1;
  ports: Record<string, Record<string, number>>;
}

/** `.forge/jobs/<job>/backing-db.json` (mode 0600): per entry name, the template the job database came from and the job role's password. */
export interface BackingDbRecord {
  v: 1;
  databases: Record<string, { template: string; password: string }>;
}

/** One command that built a template database; `tail` has every generated password redacted. */
export interface BackingBuildStep {
  cmd: string;
  ok: boolean;
  tail: string;
}

/** One service in `forge worktree create` and `forge backing up`. */
export interface BackingUpEntry {
  name: string;
  isolation: BackingIsolation;
  /** What Forge did, or on a failure what it attempted: `none` when it failed before running or starting a container. */
  action: 'created' | 'started' | 'running' | 'external' | 'none';
  ok: boolean;
  error?: string;
  /** Entries with `database`: the job database, its template and what Forge did with each. Never a password or a url. */
  database?: { name: string; template: string | null; action: 'created' | 'kept' | 'none'; template_action: 'built' | 'reused' | 'none' };
  /** Only when Forge built the template: its migrate and seed runs. */
  build?: BackingBuildStep[];
}

/** `forge backing down <job>` and the `backing` key of `forge worktree remove`. */
export interface BackingDownResult {
  removed: string[];
  volumes: string[];
  /** The job databases dropped; only when the config has an entry with `database` or a record was left. */
  databases?: string[];
  ok: boolean;
  error?: string;
}

/** What Forge last did to a job's environment: lib/environment-record.ts. */
export type EnvironmentState = 'running' | 'stopped';

export interface EnvironmentEntry {
  state: EnvironmentState;
  usedAt: string;
}

/** `.forge/runtime/environments.json`, written only by the CLI under `.forge/locks/environments`. */
export interface EnvironmentRecord {
  v: 1;
  jobs: Record<string, EnvironmentEntry>;
}

/** Which path started, stopped or tore down an environment; the trigger of its event. */
export type EnvironmentUpTrigger = 'verify' | 'run' | 'focus' | 'worktree' | 'step' | 'cli';
export type EnvironmentStopTrigger = 'park' | 'evict' | 'cli' | 'done' | 'cancelled';
export type EnvironmentDownTrigger = 'done' | 'cancelled' | 'archive' | 'cli';

/** Ensure up: lib/environment-lifecycle.ts ensureEnvironment. `backing` lists each service as `forge backing up` does. */
export interface EnvironmentUpResult {
  ok: boolean;
  backing: BackingUpEntry[];
  evicted: string[];
  error?: string;
}

/** Stop: the background commands signalled and the per-job containers stopped. */
export interface EnvironmentStopResult {
  ok: boolean;
  processes: string[];
  stopped: string[];
  error?: string;
}

/** A job finished from the inbox or office session: only a stop, and archive or `forge environment down` tears it down. */
export interface EnvironmentFinishStopResult extends EnvironmentStopResult {
  teardown: 'deferred';
}

/** Teardown: the background commands stopped, then what `forge backing down` removed. */
export interface EnvironmentDownResult {
  ok: boolean;
  processes: string[];
  removed: string[];
  volumes: string[];
  databases?: string[];
  error?: string;
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
  /** The Foreman left the gate the job waits at for a person; null otherwise. */
  foremanHandoff: ForemanHandoff | null;
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
