// The runtime lists the /api shapes in types.ts derive from, plus the daemon scopes the
// dashboard pins. This file imports nothing, so the dashboard can type-check types.ts without
// Node's types. schema.ts, requests.ts and components.ts re-export what they used to define here.

/**
 * Where an event's `actor` came from: lib/integrations/github/actor.ts resolves env, gh, git, os, dashboard and
 * daemon (a daemon session's own action); the foreman's decisions say `foreman`; anything Forge cannot vouch for
 * reads as `unknown`.
 */
export const ACTOR_SOURCES = ['env', 'gh', 'git', 'os', 'dashboard', 'daemon', 'foreman', 'unknown'] as const;

export const STAGES = [
  'backlog',
  'plan',
  'spec',
  'design',
  'build',
  'verify',
  'review',
  'integrate',
  'decide',
  'pr',
  'done',
] as const;

export const STATES = ['queued', 'running', 'waiting', 'blocked', 'failed', 'cancelled', 'done'] as const;

export const WAITING_ON = [
  'spec-approval',
  'split-approval',
  'issue-link',
  'input',
  'escalation',
  'infra',
  'conflicts',
  'rounds-exhausted',
  'pr-review',
  'external',
  'budget',
  // A CLI check stopped the job and only a human can clear it; the reason names the check.
  'human',
] as const;

/** Budget keys in the fixed order reasons and reports list them. */
export const BUDGET_KEYS = ['tokens', 'usd', 'minutes', 'changedLines', 'verifyRetries'] as const;

/** Repo budget caps (config `budget:`) in the order checks and reasons list them. */
export const REPO_BUDGET_KEYS = ['usdPerMonth', 'tokensPerMonth', 'usdPerDay'] as const;

/** budget.onExceeded: hold parks and refuses new work; warn only reports it. */
export const REPO_BUDGET_MODES = ['hold', 'warn'] as const;

/** Reasoning effort levels: runtime.effort and job.effort, passed to claude as --effort and to agents. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A spec's judged difficulty (its `Complexity:` header), which runtime.effortByComplexity maps to a level. */
export const COMPLEXITIES = ['low', 'medium', 'high'] as const;

/**
 * The gate classes the foreman may decide (foreman.decides); `pr-feedback` is a pr-review wait with
 * feedback, `repo-proposal` a `human` wait with pending repo proposals, and `release` a job's release
 * plan awaiting approval (lib/engine/release/approval.ts), which no job waits on.
 */
export const OFFICE_GATES = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback', 'repo-proposal', 'release'] as const;

/** A mandate's status (`.forge/runtime/mandates/<id>.md`): only `forge mandate pause|resume|close` moves it. */
export const MANDATE_STATUSES = ['active', 'paused', 'closed'] as const;
/** Where a mandate's work stops: a merge-ready PR, or a merged one (which needs foreman.ship: merge). */
export const MANDATE_UNTIL = ['merge-ready', 'merged'] as const;
/** How a mandate orders its work: the dependency graph, tracker priority, or scope.issues as listed. */
export const MANDATE_ORDERS = ['graph', 'priority', 'listed'] as const;
/** What a mandate does with a job it can't finish. */
export const MANDATE_ON_UNFINISHABLE = ['park', 'cancel'] as const;

/** Why the Foreman left a gate for a person (`forge job handoff --class`): a reserved topic or class, the assistant escalated, or the CLI refused its decision. */
export const HANDOFF_CLASSES = ['reserved', 'escalated', 'refused'] as const;

export const REQUEST_TYPES = ['next', 'run', 'approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume', 'sync', 'eval-run', 'retro', 'gate'] as const;

/**
 * The daemon session for requests without a (valid, existing) job. Job ids start with an
 * alphanumeric, so it can never be one.
 */
export const INBOX_SCOPE = '_inbox';
/** The Foreman's daemon session, which no request routes to in this version (the director loop gives it work); it never drives a job. */
export const OFFICE_SCOPE = '_office';
/** Not a session: the request group every `gate` request routes to, which any assistant foreman session may claim from. */
export const ASSISTANTS_SCOPE = '_assistants';
/** An assistant foreman session's scope is this prefix and its number, 1 to MAX_ASSISTANTS, with no leading zero. */
export const ASSISTANT_SCOPE_PREFIX = '_assistant-';
/** The most assistant foreman sessions a pool runs (foreman.assistants.sessions). */
export const MAX_ASSISTANTS = 16;
/** Not a session: POST /api/daemon/mode's name for the default of every job session without its own choice. */
export const JOBS_SCOPE = '_jobs';

/**
 * A registered project's name (the machine index, lib/engine/project/machine-index.ts), which is the
 * `/api/p/<project>/` URL segment: no `/`, no leading `.` or `-`, at most 64 characters.
 */
export const PROJECT_NAME_SOURCE = '^[a-z0-9][a-z0-9._-]{0,63}$';

export const COMPONENT_KINDS =['library', 'service', 'app'] as const;
export const DEPENDENCY_TYPES = ['build', 'runtime'] as const;
/** What a consumer's PR points at while its dependency is unmerged (lib/engine/release/interim.ts, docs/CONFIG.md "Interim strategies"). */
export const INTERIM_STRATEGIES = ['canary', 'git-ref', 'local', 'sequential'] as const;
