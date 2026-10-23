// The effective config and its sections' shapes, type-only: re-exported by lib/core/types.ts; unions with a runtime list derive from it.
import type { BACKING_DB_ENGINES, BACKING_ISOLATIONS, DAEMON_AUTH, EFFORT_ROLES, FOREMAN_SHIP, NOTIFY_EVENTS, NOTIFY_FORMATS } from '../job/schema.ts';
import type { LINK_ECOSYSTEMS } from './components.ts';
import type { SINK_FORMATS, SINK_MODES } from './sinks.ts';
import type { RELEASE_CADENCES, RELEASE_MECHANISMS, RELEASE_PUBLISH, RELEASE_REGISTRIES, RELEASE_VERSIONINGS } from './release-strategy.ts';
import type { Severity } from '../job/types.ts';
import type { Complexity, ComponentKind, DaemonJobBudget, DependencyType, Effort, GateClass, InterimStrategy, PipelineConfig, RepoBudgetMode } from '#api/types.ts';

/** A role with its own runtime.efforts entry: EFFORT_ROLES in lib/core/job/schema.ts. */
export type EffortRole = (typeof EFFORT_ROLES)[number];

/** One `policy.protectedPaths` rule: docs/CONFIG.md "Protected paths". */
export interface ProtectedRule {
  paths: string[];
  action: 'escalate' | 'refuse';
  reason: string;
}

/** One review lens: an entry of review.panel in defaults() (lib/core/config/defaults.ts). */
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

/** One config sink: a map with exactly one kind key (lib/core/config/sinks.ts). */
export type ConfigSink =
  | { env: Record<string, string> }
  | { 'env-file': string; values?: Record<string, string> }
  | { file: { path: string; format: SinkFormat; mode: SinkMode; from?: string | null }; values?: SinkValues }
  | { command: string; values?: Record<string, string> };

/** Where one declared secret's value comes from: exactly one source key (lib/core/config/validators/secret-refs.ts). */
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

/** What `forge run <job> <name>` executes: defaults().commands in lib/core/config/defaults.ts. */
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

/** The effective config: defaults() in lib/core/config/defaults.ts merged with .forge/config.yml by loadConfig. docs/CONFIG.md documents each key. */
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
  /** Steps `forge focus` applies to the focused job and undoes on the next change: lib/engine/workspace/checkout.ts. */
  checkout: CheckoutStep[];
  /** Databases, caches and queues jobs run against: lib/engine/environment/backing.ts, docs/CONFIG.md "Backing services". */
  backing: BackingEntry[];
  /** Named credentials config sinks reach as `{secret.NAME}`: lib/engine/guard/secret-refs.ts, docs/CONFIG.md "Secret references". */
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
    /** Overrides for lib/integrations/claude/pricing.json: { models: { <id>: {input, output, cacheRead, cacheWrite} }, aliases: {…} }. */
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
  /** Job environments running at once; null means no cap (lib/engine/environment/lifecycle.ts eviction). */
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

/** A notify event: NOTIFY_EVENTS in lib/core/job/schema.ts. */
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];
/** notify.webhooks[].format: NOTIFY_FORMATS in lib/core/job/schema.ts. */
export type NotifyFormat = (typeof NOTIFY_FORMATS)[number];
/** One notify.webhooks entry; `events` omitted subscribes to every event, `format` defaults to json. */
export interface NotifyWebhook {
  url: string;
  events?: NotifyEvent[];
  format?: NotifyFormat;
}
/** foreman.ship: FOREMAN_SHIP in lib/core/job/schema.ts. */
export type ForemanShip = (typeof FOREMAN_SHIP)[number];

/** Which credential a daemon session runs on: the Claude login (subscription) or an API key from the environment. */
export type DaemonAuth = (typeof DAEMON_AUTH)[number];

/** What loadConfig in lib/core/config/load.ts returns. */
export interface LoadedConfig {
  config: Config;
  initialized: boolean;
  path: string;
  migratedFrom?: number;
}

/** One `checkout:` entry: a fixed path linked to the focused job's build, or a configured command (with an optional undo). */
export type CheckoutStep = { link: string; to: string } | { run: string; undo?: string | null };

/** How a backing service is shared: a container per job, one per project, or an address run elsewhere. */
export type BackingIsolation = (typeof BACKING_ISOLATIONS)[number];

/** One `backing:` entry (lib/core/config/validators/backing.ts validates it). image, ports, env and volumes are for managed (per-job, shared) entries only. */
export interface BackingEntry {
  name: string;
  isolation: BackingIsolation;
  image?: string;
  ports?: number[];
  env?: Record<string, string | number | boolean>;
  volumes?: string[];
  url?: string;
  /** Shared entries only: a job database per job on this server, cloned from a template database (lib/engine/environment/backing-db.ts). */
  database?: BackingDatabase;
}

/** A shared entry's `database`: the engine, and the commands and files that build its template database. */
export interface BackingDatabase {
  engine: (typeof BACKING_DB_ENGINES)[number];
  migrate?: string;
  seed?: string;
  inputs?: string[];
}
