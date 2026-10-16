// Versioned data shapes. Every persisted file carries `schemaVersion`; readers upgrade old
// shapes in memory (and `forge migrate` rewrites them on disk), so a plugin update never
// strands jobs or configs written by an older version. A file from a *newer* plugin is
// refused rather than guessed at.
import { servicesToComponents } from './components.ts';
import type { EventActor, Job, JobEvent, LoadedJob } from './types.ts';

export { COMPONENT_KINDS, DEPENDENCY_TYPES } from './components.ts';

export const CONFIG_SCHEMA_VERSION = 9;
export const JOB_SCHEMA_VERSION = 10;
export const EVENT_SCHEMA_VERSION = 2;
/** `.forge/archive/<id>.json` records (lib/archive.ts); a reader skips a record from a newer Forge. */
export const ARCHIVE_SCHEMA_VERSION = 1;
/**
 * Bumped when /api/state or another /api/* shape the dashboard reads changes; the dashboard is
 * served by the same plugin version.
 */
export const API_VERSION = 22;

/**
 * Where an event's `actor` came from: lib/actor.ts resolves env, gh, git, os and dashboard; the
 * foreman's decisions say `foreman`; anything Forge cannot vouch for reads as `unknown`.
 */
export const ACTOR_SOURCES = ['env', 'gh', 'git', 'os', 'dashboard', 'foreman', 'unknown'] as const;

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

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

/** daemon.auth: the credential a daemon session runs on. */
export const DAEMON_AUTH = ['subscription', 'api-key'] as const;

/** notify.webhooks[].events: what Forge can notify about, most specific first where two overlap. */
export const NOTIFY_EVENTS = ['gate', 'pr-opened', 'pr-merged', 'job-failed', 'daemon-stopped', 'budget-exceeded', 'secret-found'] as const;

/** notify.webhooks[].format: the body Forge posts. */
export const NOTIFY_FORMATS = ['json', 'slack'] as const;

/** The waitingOn values that are human gates; pr-review and external wait on someone outside Forge. */
export const NOTIFY_GATES = ['spec-approval', 'split-approval', 'issue-link', 'input', 'escalation', 'infra', 'conflicts', 'rounds-exhausted', 'budget', 'human'] as const;

/** Reasoning effort levels: runtime.effort and job.effort, passed to claude as --effort and to agents. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A spec's judged difficulty (its `Complexity:` header), which runtime.effortByComplexity maps to a level. */
export const COMPLEXITIES = ['low', 'medium', 'high'] as const;

/** The roles runtime.efforts sets, in runtime.models order. No orchestrator: sessions take runtime.effort. */
export const EFFORT_ROLES = ['planner', 'spec-writer', 'designer', 'builder', 'reviewer', 'approver', 'integrator', 'retro', 'judge', 'assistant'] as const;

/** The gate classes the foreman may decide (foreman.decides); `pr-feedback` is a job waiting on pr-review with feedback. */
export const OFFICE_GATES = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback'] as const;

/** foreman.ship: propose leaves merging as it was; merge counts as merge.auto for the approver and PR4. */
export const FOREMAN_SHIP = ['propose', 'merge'] as const;

/** Config migrations keyed by the version they upgrade *from*. */
const CONFIG_MIGRATIONS: Record<number, (c: any) => any> = {
  // v2 replaces the per-request `dashboard.launcher` shell template with the supervised `daemon:`
  // block. A launcher becomes `daemon.command` so its owner sees why validation rejects it, but
  // `enabled` is never set: an upgrade must not turn on an unattended, permission-skipping process.
  1: (c) => {
    if (!c.dashboard || typeof c.dashboard !== 'object') return c;
    const { launcher, ...dashboard } = c.dashboard;
    const out = { ...c, dashboard };
    if (typeof launcher === 'string' && launcher.trim() && !c.daemon?.command) out.daemon = { ...(c.daemon ?? {}), command: launcher };
    return out;
  },
  // v3 lets a `verify` entry be a list of steps that run at the same time. Every v2 list is a valid v3
  // list, so nothing changes; the bump is what lets this and later Forges refuse a config they cannot read.
  2: (c) => c,
  // v4 adds runtime.efforts, runtime.effortByComplexity and a review.panel entry's `effort`, all
  // defaulting to unset, so no v3 config changes; the bump lets older Forges refuse a config whose
  // effort they would ignore.
  3: (c) => c,
  // v5 adds the foreman block (off by default) and the assistant's model and effort, so no v4 config
  // changes; the bump lets older Forges refuse a config whose foreman policy they would ignore.
  4: (c) => c,
  // v6 adds policy.protectedPaths; defaults fill it, so no v5 config changes; the bump lets older
  // Forges refuse a config whose policy they would ignore.
  5: (c) => c,
  // v7 adds retention, whose defaults keep everything, so no v6 config changes; the bump lets older
  // Forges refuse a config whose retention policy they would ignore.
  6: (c) => c,
  // v8 adds notify, empty by default, so no v7 config changes; the bump lets older Forges refuse a
  // config whose notifications they would ignore.
  7: (c) => c,
  // v9 replaces `services` with `components`, which add a kind and dependencies. A service was a
  // part with its own commands, so each becomes a `service` component with no dependencies; its
  // name, path and commands are unchanged, so `forge run` and `forge verify` pick the same command.
  8: servicesToComponents,
};

const JOB_MIGRATIONS: Record<number, (j: any) => any> = {
  // v1 kept one PASS/FAIL per round; v2 keeps every attempt with the sha it ran against.
  1: (j) => ({
    ...j,
    verifyRuns: j.verifyRuns ?? Object.entries(j.verify ?? {}).map(([round, v]) => ({ round: Number(round), attempt: 1, sha: null, ok: v === 'PASS', at: null, file: `verify/round-${round}.md` })),
  }),
  // v3 adds per-job budgets and per-round failed-verify counts, recovered from the run history.
  2: (j) => ({
    ...j,
    verifyRetries: j.verifyRetries ?? failedVerifiesByRound(j.verifyRuns ?? []),
    budget: j.budget ?? { limits: {}, ack: {}, lastCheck: null },
  }),
  // v4 adds the human's "this job needs no issue" override (forge job link --none).
  3: (j) => ({ ...j, noIssue: j.noIssue ?? null }),
  // v5 adds each agent record's import cursor. An ended agent's usage is already recorded and its
  // transcript ends before its endedAt, so that is a safe cursor: resuming it counts only new work.
  4: (j) => ({
    ...j,
    agents: Object.fromEntries(
      Object.entries(j.agents ?? {}).map(([role, a]: [string, any]) => [
        role,
        a && !a.importedThrough && a.agentId && a.endedAt ? { ...a, importedThrough: { [a.agentId]: a.endedAt } } : a,
      ]),
    ),
  }),
  // v6 records whether a job's planner must never split it (from-ref, revise-split). A v5 job did
  // not record how it started, so it is not backfilled to "never": it keeps pipeline.split.
  5: (j) => ({ ...j, splitMode: j.splitMode ?? null }),
  // v7 adds the human's per-job reasoning effort. null inherits runtime.effort, which is what every
  // v6 job ran at, so the upgrade changes no job's effort.
  6: (j) => ({ ...j, effort: j.effort ?? null }),
  // v8 adds `waitingOn: human` (a CLI check, such as the secret scan, stopped the job). No v7 job
  // waits on it, so nothing changes; the bump makes an older Forge refuse a job parked on a gate it
  // can't explain.
  7: (j) => j,
  // v9 adds the spec's judged complexity, recorded when the spec is. A v8 job never had one.
  8: (j) => ({ ...j, complexity: j.complexity ?? null }),
  // v10 adds the protected-paths flag the CLI records. A v9 job has none; pr open recomputes anyway.
  9: (j) => ({ ...j, protectedPaths: j.protectedPaths ?? null }),
};

function failedVerifiesByRound(runs: any[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of runs) if (r && r.ok === false) out[String(r.round)] = (out[String(r.round)] ?? 0) + 1;
  return out;
}

export function migrateConfig(raw: any): { config: any; from: number | undefined } {
  let config = raw ?? {};
  const from = config.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  if (from > CONFIG_SCHEMA_VERSION) return { config, from };
  let v = from;
  while (v < CONFIG_SCHEMA_VERSION) {
    config = CONFIG_MIGRATIONS[v](config);
    v++;
  }
  // An unversioned or hand-written config may still use the old key; fold it the same way.
  if (from === CONFIG_SCHEMA_VERSION) config = servicesToComponents(config);
  config.schemaVersion = CONFIG_SCHEMA_VERSION;
  return { config, from: from === CONFIG_SCHEMA_VERSION ? undefined : from };
}

/**
 * Upgrades and fills defaults so every consumer can rely on the current shape.
 */
export function normalizeJob(raw: any): LoadedJob {
  let job = raw ?? {};
  const from = job.schemaVersion ?? 1;
  if (from > JOB_SCHEMA_VERSION) return { ...job, _unsupported: true };
  let v = from;
  while (v < JOB_SCHEMA_VERSION) {
    job = JOB_MIGRATIONS[v](job);
    v++;
  }
  return {
    ...job,
    schemaVersion: JOB_SCHEMA_VERSION,
    id: job.id,
    title: job.title ?? job.id,
    kind: job.kind ?? 'feature',
    size: job.size ?? null,
    source: job.source ?? null,
    noIssue: job.noIssue ?? null,
    parent: job.parent ?? null,
    children: job.children ?? [],
    dependsOn: job.dependsOn ?? [],
    services: job.services ?? [],
    stage: job.stage ?? 'backlog',
    state: job.state ?? 'queued',
    waitingOn: job.waitingOn ?? null,
    reason: job.reason ?? null,
    branch: job.branch ?? null,
    base: job.base ?? null,
    worktree: job.worktree ?? null,
    port: job.port ?? null,
    round: job.round ?? 0,
    maxRounds: job.maxRounds ?? 3,
    reviewers: job.reviewers ?? [],
    verdicts: job.verdicts ?? {},
    verify: job.verify ?? {},
    verifyRuns: job.verifyRuns ?? [],
    verifyRetries: job.verifyRetries ?? {},
    budget: { limits: {}, ack: {}, lastCheck: null, ...(job.budget ?? {}) },
    decision: job.decision ?? null,
    pr: job.pr ?? null,
    owner: job.owner ?? null,
    agents: job.agents ?? {},
    usage: job.usage ?? { totalTokens: 0, byRole: {}, byModel: {}, estCostUsd: 0, exact: false },
    runs: job.runs ?? [],
    createdAt: job.createdAt ?? null,
    updatedAt: job.updatedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    eval: job.eval ?? null,
    splitMode: job.splitMode ?? null,
    // A hand- or session-edited value outside the fixed list must never reach a daemon's argv.
    effort: (EFFORTS as readonly unknown[]).includes(job.effort) ? job.effort : null,
    complexity: (COMPLEXITIES as readonly unknown[]).includes(job.complexity) ? job.complexity : null,
    // Tolerant: anything but an object with a hits list reads as no flag. Safe, because verify and
    // pr open recompute the set from git rather than trusting this.
    protectedPaths: job.protectedPaths && typeof job.protectedPaths === 'object' && Array.isArray(job.protectedPaths.hits) ? job.protectedPaths : null,
  };
}

export function serializeJob(job: LoadedJob): Job {
  const { _unsupported, ...rest } = job;
  return { ...rest, schemaVersion: JOB_SCHEMA_VERSION };
}

/**
 * A login as Forge stores and prints it: only `[A-Za-z0-9 ._@+-]`, single spaces, at most 100
 * characters. It runs on every candidate and on every value read back, because a login ends up in
 * PR bodies, tracker comments and CSV, and the environment, the cache and events.jsonl are all
 * writable by whoever runs the repo. An empty result means "no login".
 */
export function sanitizeLogin(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/[^A-Za-z0-9 ._@+-]/g, '').replace(/ +/g, ' ').trim().slice(0, 100).trim();
}

const isActorSource = (v: unknown): v is EventActor['source'] => (ACTOR_SOURCES as readonly unknown[]).includes(v);

/**
 * Any stored actor as the v2 object. The legacy strings keep their v1 meaning whatever the event's
 * version says: `"foreman"` stays the foreman's, so a foreman decision can never read as a person's (protected paths).
 */
export function normalizeActor(raw: unknown): EventActor {
  if (raw === 'foreman') return { login: null, source: 'foreman' };
  if (raw === 'human') return { login: null, source: 'unknown' };
  if (typeof raw === 'string') return { login: sanitizeLogin(raw) || null, source: 'unknown' };
  if (!raw || typeof raw !== 'object') return { login: null, source: 'unknown' };
  const a = raw as { login?: unknown; source?: unknown };
  // Whatever its login says, a foreman entry stays the foreman's: a malformed one must not fall to
  // `unknown`, which protected paths would count as a person's approval.
  if (a.source === 'foreman') return { login: null, source: 'foreman' };
  const login = typeof a.login === 'string' ? sanitizeLogin(a.login) || null : null;
  const valid = (typeof a.login === 'string' || a.login === null) && isActorSource(a.source);
  return { login, source: valid ? (a.source as EventActor['source']) : 'unknown' };
}

/** Event migrations keyed by the version they upgrade *from*. Applied on read; files stay as written. */
const EVENT_MIGRATIONS: Record<number, (e: any) => any> = {
  // v2 makes `actor` an object `{ login, source }`. A v1 `human` event recorded only "human" or
  // "foreman" (or nothing, before the field existed); other v1 events had no actor at all.
  1: (e) => {
    if (e.type !== 'human') return e;
    if (e.actor === 'foreman') return { ...e, actor: { login: null, source: 'foreman' } };
    if (e.actor === undefined || e.actor === 'human') return { ...e, actor: { login: null, source: 'unknown' } };
    return e;
  },
};

/**
 * One parsed events.jsonl line in the current shape, or null when it is not an event at all. A
 * line from a newer Forge is kept as written except that its actor is still sanitised.
 */
export function normalizeEvent(raw: unknown): JobEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let e: any = raw;
  const from = typeof e.v === 'number' ? e.v : 1;
  if (from <= EVENT_SCHEMA_VERSION) {
    for (let v = Math.max(1, from); v < EVENT_SCHEMA_VERSION; v++) e = EVENT_MIGRATIONS[v](e);
    e = { ...e, v: EVENT_SCHEMA_VERSION };
  }
  if (e.actor !== undefined) e = { ...e, actor: normalizeActor(e.actor) };
  return e as JobEvent;
}
