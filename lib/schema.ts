// Versioned data shapes. Every persisted file carries `schemaVersion`; readers upgrade old
// shapes in memory (and `forge migrate` rewrites them on disk), so a plugin update never
// strands jobs or configs written by an older version. A file from a *newer* plugin is
// refused rather than guessed at.
import type { Job, LoadedJob } from './types.ts';

export const CONFIG_SCHEMA_VERSION = 2;
export const JOB_SCHEMA_VERSION = 4;
export const EVENT_SCHEMA_VERSION = 1;
/**
 * Bumped when /api/state or another /api/* shape the dashboard reads changes; the dashboard is
 * served by the same plugin version.
 */
export const API_VERSION = 8;

export const STAGES = [
  'backlog',
  'plan',
  'spec',
  'design',
  'build',
  'verify',
  'review',
  'decide',
  'integrate',
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
] as const;

/** Budget keys in the fixed order reasons and reports list them. */
export const BUDGET_KEYS = ['tokens', 'usd', 'minutes', 'changedLines', 'verifyRetries'] as const;

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

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
  };
}

export function serializeJob(job: LoadedJob): Job {
  const { _unsupported, ...rest } = job;
  return { ...rest, schemaVersion: JOB_SCHEMA_VERSION };
}
