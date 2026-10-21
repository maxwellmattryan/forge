// Versioned data shapes. Every persisted file carries `schemaVersion`; readers upgrade old
// shapes in memory (and `forge migrate` rewrites them on disk), so a plugin update never
// strands jobs or configs written by an older version. A file from a *newer* plugin is
// refused rather than guessed at.
import { isInterimStrategy, servicesToComponents } from './components.ts';
import { isSha } from './delta.ts';
import { isSafeUrl, isStoredRef, sameIssue } from './issue-ref.ts';
import { REPO_NAME, isSafeBranch } from './member-repos.ts';
import type { EventActor, Job, JobAgent, JobEvent, JobIssue, JobOutcome, JobRepo, JobRepoPr, JobScore, LoadedJob } from './types.ts';

export { COMPONENT_KINDS, DEPENDENCY_TYPES, LINK_ECOSYSTEMS } from './components.ts';
export { BACKING_DB_ENGINES, BACKING_ISOLATIONS } from './backing-config.ts';

export const CONFIG_SCHEMA_VERSION = 26;
export const JOB_SCHEMA_VERSION = 16;
export const EVENT_SCHEMA_VERSION = 2;
/** `.forge/archive/<id>.json` records (lib/archive.ts); a reader skips a record from a newer Forge. */
export const ARCHIVE_SCHEMA_VERSION = 1;
/**
 * Bumped when /api/state or another /api/* shape the dashboard reads changes; the dashboard is
 * served by the same plugin version.
 */
export const API_VERSION = 31;

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

/** Repo budget caps (config `budget:`) in the order checks and reasons list them. */
export const REPO_BUDGET_KEYS = ['usdPerMonth', 'tokensPerMonth', 'usdPerDay'] as const;

/** budget.onExceeded: hold parks and refuses new work; warn only reports it. */
export const REPO_BUDGET_MODES = ['hold', 'warn'] as const;

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

/** A model alias or id as runtime.models and the builder overrides take it; here so config.ts and config-fields.ts share it without an import cycle. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

/** The roles runtime.efforts sets, in runtime.models order. No orchestrator: sessions take runtime.effort. */
export const EFFORT_ROLES = ['planner', 'spec-writer', 'designer', 'builder', 'reviewer', 'approver', 'integrator', 'retro', 'judge', 'assistant'] as const;

/**
 * The gate classes the foreman may decide (foreman.decides); `pr-feedback` is a pr-review wait with
 * feedback, `repo-proposal` a `human` wait with pending repo proposals, and `release` a job's release
 * plan awaiting approval (lib/release-approval.ts), which no job waits on.
 */
export const OFFICE_GATES = ['spec-approval', 'split-approval', 'escalation', 'rounds-exhausted', 'conflicts', 'pr-feedback', 'repo-proposal', 'release'] as const;

/**
 * A foreman.reserved entry read as a class reservation: the class for exactly `gate:<class>`
 * (whitespace around the entry trimmed), 'invalid' for anything else shaped like one
 * (`Gate:release`, `gate: release`, `gate:Release`, an unknown class), null for a text pattern.
 * A mis-written reservation must fail closed, never fall through to a text pattern that leaves
 * the class open.
 */
export function reservedGateEntry(p: string): (typeof OFFICE_GATES)[number] | 'invalid' | null {
  const t = p.trim();
  if (!/^gate\s*:/i.test(t)) return null;
  const c = t.startsWith('gate:') ? t.slice(5) : '';
  return (OFFICE_GATES as readonly string[]).includes(c) ? (c as (typeof OFFICE_GATES)[number]) : 'invalid';
}

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
  // v9 adds the repo-wide budget block, unlimited by default, so no v8 config changes; the bump lets
  // older Forges refuse a config whose spend caps they would ignore.
  8: (c) => c,
  // v10 replaces `services` with `components`, which add a kind and dependencies. A service was a
  // part with its own commands, so each becomes a `service` component with no dependencies; its
  // name, path and commands are unchanged, so `forge run` and `forge verify` pick the same command.
  9: servicesToComponents,
  // v11 adds member repos, empty by default, so a v10 config gains `repos: []` (an existing value is
  // kept for validation to judge); the bump lets older Forges refuse a config whose member repos they
  // would ignore. A v10 config may still carry `services`, which migrateConfig folded while 10 was
  // current, so fold it here first.
  10: (c) => {
    const f = servicesToComponents(c);
    return f && typeof f === 'object' && 'repos' in f ? f : { ...f, repos: [] };
  },
  // v12 adds dependsOn links, absent by default, so no v11 config changes; the bump lets older Forges
  // refuse a config whose links they would ignore.
  11: (c) => c,
  // v13 adds release.interim and link.manifest, absent by default, so no v12 config changes; the bump
  // lets older Forges refuse a config whose interim strategy they would ignore.
  12: (c) => c,
  // v14 adds downstream verification, on by default, so a v13 config gains the default `downstream`
  // map (an existing value is kept for validation to judge); the bump lets older Forges refuse a
  // config whose downstream settings they would ignore.
  13: (c) => (c && typeof c === 'object' && 'downstream' in c ? c : { ...c, downstream: { enabled: true, max: 5, skip: [] } }),
  // v15 adds checkout, empty by default, so no v14 config changes; the bump lets older Forges
  // refuse a config whose checkout steps they would ignore.
  14: (c) => c,
  // v16 adds the release strategy keys, unset by default, so no v15 config changes; the bump lets
  // older Forges refuse a config whose release strategy they would ignore.
  15: (c) => c,
  // v17 adds release.publish (whether forge release run asks before a publish step), unset by
  // default, so no v16 config changes; the bump lets older Forges refuse a config whose publish
  // policy they would ignore.
  16: (c) => c,
  // v18 adds the `release` gate class and `gate:<class>` entries in foreman.reserved, with
  // `gate:release` in the default list. deepMerge replaces arrays, so a config that wrote out its own
  // `reserved` would never get the new default: append it there. A v17 `decides` can't name
  // `release` (it was invalid), so this never takes a delegation away, and the bump lets older
  // Forges refuse a config whose `decides` names a class they would ignore.
  17: (c) => {
    const r = c?.foreman?.reserved;
    if (!Array.isArray(r) || r.includes('gate:release')) return c;
    return { ...c, foreman: { ...c.foreman, reserved: [...r, 'gate:release'] } };
  },
  // v19 adds backing, empty by default, so no v18 config changes; the bump lets older Forges refuse
  // a config whose backing services they would ignore.
  18: (c) => c,
  // v20 adds components[].config (config sinks), absent by default, so no v19 config changes; the
  // bump lets older Forges refuse a config whose sinks they would ignore.
  19: (c) => c,
  // v21 adds runtime.modelByComplexity, runtime.reworkModel, review.onRework and a panel entry's
  // `pathsOnly`; defaults fill them, so no v20 config changes. onRework defaults to `narrow`, so an
  // upgraded repo's rework rounds re-run only the rework panel, while round 1 is unchanged. The bump
  // lets older Forges refuse a config whose builder models and rework panel they would ignore.
  20: (c) => c,
  // v22 adds a shared backing entry's `database` (a job database cloned from a template database),
  // absent by default, so no v21 config changes; the bump lets older Forges refuse a config whose
  // job databases they would ignore.
  21: (c) => c,
  // v23 adds `secrets` (named secret references for config sinks), `{}` by default, so no v22 config
  // changes; the bump lets older Forges refuse a config whose {secret.NAME} references they would
  // reject at render or, worse, leave unredacted.
  22: (c) => c,
  // v24 adds outcomes.windowDays (14 by default), so no v23 config changes; the bump lets older
  // Forges refuse a config whose outcome window they would ignore.
  23: (c) => c,
  // v25 adds environments.maxRunning, null by default, so no v24 config changes; the bump lets older
  // Forges refuse a config whose cap they would ignore.
  24: (c) => c,
  // v26 adds scoring (sample 0 and model null by default, so off), so no v25 config changes; the
  // bump lets older Forges refuse a config whose score sampling they would ignore.
  25: (c) => c,
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
  // v11 gives a job a list of issues instead of one `source`, so a job can carry issues from several
  // repos and an issue can sit on several jobs. A GitHub source whose url names its repo is
  // qualified (`owner/repo#12`); one without stays a bare number, which still reads as this repo.
  10: (j) => {
    const { source, ...rest } = j;
    return { ...rest, issues: j.issues ?? sourceToIssues(source) };
  },
  // v12 lets a job change member repos too: `repos[0]` mirrors the root repo's top-level fields
  // (normalizeJob rebuilds it), so a v11 job becomes a one-repo job and nothing it did changes.
  11: (j) => ({ ...j, repos: Array.isArray(j.repos) ? j.repos : [] }),
  // v13 adds the human's per-job interim strategy override (forge job repo interim): null inherits
  // config, which is what every v12 job did. Members get theirs in cleanRepos.
  12: (j) => ({ ...j, interim: j.interim ?? null }),
  // v14 adds one port per port-bearing component. A v13 job keeps its `port`, which the next
  // `worktree create` reconciles into `ports` (lib/ports.ts), so nothing it runs changes.
  13: (j) => ({ ...j, ports: {} }),
  // v15 adds the merged PR's post-merge outcome, which forge sync measures. A v14 job has none yet,
  // and the next sync measures it, so a long-merged job gets a final outcome straight away.
  14: (j) => ({ ...j, outcome: j.outcome ?? null }),
  // v16 adds the post-merge score (lib/scoring.ts). A v15 job has none; the next sync queues one
  // only when the job is sampled and merged inside the lookback.
  15: (j) => ({ ...j, score: j.score ?? null }),
};

const SCORE_STATUSES = ['queued', 'held', 'scored', 'failed'] as const;
const SCORE_REASONS = ['budget exceeded', 'repo budget', 'no score.md', 'malformed score.md'] as const;
const isScoreModel = (v: unknown): v is string => typeof v === 'string' && v.length <= 200 && MODEL_RE.test(v);

/**
 * A stored score, or null when any field is malformed. job.json is writable outside the CLI and
 * the score feeds stats and the retro: only the keys Forge writes are kept, in the shapes it writes.
 */
export function cleanScore(raw: unknown): JobScore | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (!(SCORE_STATUSES as readonly unknown[]).includes(s.status)) return null;
  if (s.outOf !== 5) return null;
  const timeOrNull = (v: unknown) => v === null || isTime(v);
  if (!timeOrNull(s.queuedAt) || !timeOrNull(s.recordedAt)) return null;
  if (s.value !== null) {
    const v = s.value;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 5 || Math.round(v * 10) !== v * 10) return null;
  }
  if (s.judgeModel !== null && !isScoreModel(s.judgeModel)) return null;
  if (s.builderModel !== null && !isScoreModel(s.builderModel)) return null;
  if (s.reason !== undefined && !(SCORE_REASONS as readonly unknown[]).includes(s.reason)) return null;
  const status = s.status as JobScore['status'];
  // Each status carries what Forge writes for it: a value only when scored, a queue time unless held.
  if ((status === 'scored') !== (s.value !== null)) return null;
  if (status !== 'held' && s.queuedAt === null) return null;
  if (status !== 'queued' && s.recordedAt === null) return null;
  return {
    status,
    queuedAt: s.queuedAt as string | null,
    value: s.value as number | null,
    outOf: 5,
    recordedAt: s.recordedAt as string | null,
    judgeModel: s.judgeModel as string | null,
    builderModel: s.builderModel as string | null,
    ...(s.reason !== undefined ? { reason: s.reason as NonNullable<JobScore['reason']> } : {}),
  };
}

const MAX_FOLLOW_UP_REFS = 20;
/** A follow-up ref as an outcome stores it: `owner/repo#n`. */
export const OUTCOME_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+$/;
const OUTCOME_REASON = /^[A-Za-z0-9 ,.:()-]{1,200}$/;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isTime = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));

/**
 * A stored outcome, or null when any field is malformed, so the next sync measures it again.
 * job.json is writable outside the CLI and the outcome feeds stats and the retro: only the keys
 * Forge writes are kept, and only in the shapes it writes. Bad follow-up refs are dropped alone.
 */
export function cleanOutcome(raw: unknown): JobOutcome | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.status !== 'open' && o.status !== 'final') return null;
  if (!Number.isInteger(o.windowDays) || (o.windowDays as number) < 1 || (o.windowDays as number) > 365) return null;
  if (!isTime(o.mergedAt) || !isTime(o.closesAt) || !isTime(o.measuredAt)) return null;
  if (o.mergeSha !== null && !isSha(o.mergeSha)) return null;
  if (o.reverted !== null && typeof o.reverted !== 'boolean') return null;
  let revertedBy: JobOutcome['revertedBy'] = null;
  if (o.revertedBy !== null) {
    const r = o.revertedBy as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') return null;
    if (r.kind === 'commit' && isSha(r.sha)) revertedBy = { kind: 'commit', sha: r.sha };
    else if (r.kind === 'pr' && isCount(r.number) && r.number > 0) revertedBy = { kind: 'pr', number: r.number };
    else return null;
  }
  if (o.followUps !== null && o.followUps !== 'unsupported' && !isCount(o.followUps)) return null;
  let churn: JobOutcome['churn'] = null;
  if (o.churn !== null) {
    const c = o.churn as Record<string, unknown> | undefined;
    if (!c || typeof c !== 'object' || !isCount(c.commits) || !isCount(c.lines) || !isCount(c.files)) return null;
    churn = { commits: c.commits, lines: c.lines, files: c.files };
  }
  if (!isCount(o.attempts)) return null;
  // Forge writes only short fixed phrases here.
  if (o.reason !== undefined && (typeof o.reason !== 'string' || !OUTCOME_REASON.test(o.reason))) return null;
  const refs = Array.isArray(o.followUpRefs) ? o.followUpRefs.filter((r): r is string => typeof r === 'string' && r.length <= 200 && OUTCOME_REF.test(r)).slice(0, MAX_FOLLOW_UP_REFS) : [];
  return {
    status: o.status,
    windowDays: o.windowDays as number,
    mergedAt: o.mergedAt,
    closesAt: o.closesAt,
    mergeSha: (o.mergeSha as string | null) ?? null,
    reverted: o.reverted as boolean | null,
    revertedBy,
    followUps: o.followUps as JobOutcome['followUps'],
    followUpRefs: refs,
    churn,
    measuredAt: o.measuredAt,
    attempts: o.attempts,
    ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
  };
}

/**
 * `ports` as stored, or `{}` for anything that is not a map of distinct integer ports from 1 to
 * 65535. job.json is agent-writable, and a port reaches command lines and URLs, so a crafted value
 * reads as "not allocated yet" rather than being filled.
 */
export function cleanPorts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const seen = new Set<number>();
  for (const v of Object.values(raw)) {
    if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 65535 || seen.has(v as number)) return {};
    seen.add(v as number);
  }
  return { ...(raw as Record<string, number>) };
}

const MAX_TRACKER = 40;
const MAX_URL = 2000;
const ISSUE_URL = /^https:\/\/[A-Za-z0-9.-]{1,253}(?::\d{1,5})?\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/issues\/(\d{1,10})$/;

/** A v10 `source` as the v11 list: one entry, or none for a null source. */
export function sourceToIssues(source: unknown): unknown[] {
  if (!source || typeof source !== 'object') return [];
  const s = source as { tracker?: unknown; ref?: unknown; url?: unknown };
  let ref = typeof s.ref === 'number' ? String(s.ref) : s.ref ?? null;
  const url = s.url ?? null;
  if (s.tracker === 'github' && typeof ref === 'string' && /^\d+$/.test(ref) && typeof url === 'string') {
    const m = ISSUE_URL.exec(url);
    if (m && m[3] === ref && !m[1].includes('..') && !m[2].includes('..')) ref = `${m[1]}/${m[2]}#${ref}`;
  }
  // `forge job new --ref` stored refs unchecked before v11, so an old ref may fail the grammar
  // (`ends done`). Dropping it would unlink the job and park it again at the issue-link gate, so it
  // is kept in the nearest form the grammar accepts.
  if (typeof ref === 'string' && typeof s.tracker === 'string' && !isStoredRef(ref, s.tracker)) ref = legacyRef(ref, s.tracker);
  return [{ tracker: s.tracker, ref, url }];
}

function legacyRef(raw: string, tracker: string): string | null {
  const ref = raw.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[^A-Za-z0-9]+/, '').slice(0, 100).replace(/[-.]+$/, '');
  return isStoredRef(ref, tracker) ? ref : null;
}

/**
 * A stored issue list, every entry checked: hand edits and older Forges write job.json, and refs
 * reach PR bodies and the dashboard. A malformed entry or a duplicate is dropped; nothing throws.
 */
export function cleanIssues(raw: unknown): JobIssue[] {
  if (!Array.isArray(raw)) return [];
  const out: JobIssue[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const { tracker, ref, url } = e as Record<string, unknown>;
    if (typeof tracker !== 'string' || !tracker || tracker.length > MAX_TRACKER) continue;
    if (ref != null && !isStoredRef(ref, tracker)) continue;
    if (url != null && (typeof url !== 'string' || url.length > MAX_URL)) continue;
    // The url is written raw into the PR body, so a newline in it could append markdown there.
    const issue: JobIssue = { tracker, ref: (ref as string | null | undefined) ?? null, url: isSafeUrl(url) ? url : null };
    if (!issue.ref && !issue.url) continue;
    const dup = out.some((o) => (issue.ref ? sameIssue(o, issue) : !o.ref && o.url === issue.url));
    if (!dup) out.push(issue);
  }
  return out;
}

/** An https url Forge may store from `gh` output: isSafeUrl, https only. */
export const isHttpsUrl = (u: unknown): u is string => isSafeUrl(u) && u.startsWith('https://');

function cleanRepoPr(raw: unknown): JobRepoPr | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pr = raw as Record<string, unknown>;
  if (typeof pr.number !== 'number' || !Number.isSafeInteger(pr.number) || pr.number <= 0) return null;
  // Only the keys Forge writes for a member PR, so a hand-edited key never reaches /api/state.
  const out: Record<string, unknown> = {};
  for (const k of REPO_PR_KEYS) if (pr[k] !== undefined) out[k] = pr[k];
  return { ...(out as unknown as JobRepoPr), url: isHttpsUrl(pr.url) ? pr.url : null };
}

/** What openMemberPr and syncMemberPrs record (lib/pr.ts). */
const REPO_PR_KEYS = ['number', 'url', 'state', 'isDraft', 'openedAt', 'lastSyncedAt', 'pushedSha', 'headOid', 'mergeable', 'mergeState', 'checks', 'mergedAt'] as const;

/**
 * `repos` as readers see it: the root mirror rebuilt from the top-level fields, then every member
 * entry that passes the checks. job.json is writable outside the CLI, so a member's name, base,
 * worktree and PR are checked here and its branch is never read back: it is always the job's.
 */
export function cleanRepos(job: Pick<Job, 'branch' | 'base' | 'worktree' | 'pr'> & { repos?: unknown; interim?: unknown }): JobRepo[] {
  const root: JobRepo = { repo: null, worktree: job.worktree ?? null, branch: job.branch ?? null, base: job.base ?? null, pr: job.pr ?? null, verifyOnly: false, interim: interimOrNull(job.interim) };
  const out: JobRepo[] = [root];
  if (!Array.isArray(job.repos)) return out;
  const seen = new Set<string>();
  for (const e of job.repos.slice(1)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    const m = e as Record<string, unknown>;
    if (typeof m.repo !== 'string' || !REPO_NAME.test(m.repo) || seen.has(m.repo)) continue;
    seen.add(m.repo);
    const verifyOnly = m.verifyOnly === true;
    out.push({
      repo: m.repo,
      // Control characters never: the path is printed one per line in agent briefs.
      worktree: typeof m.worktree === 'string' && m.worktree !== '' && !/[\u0000-\u001f\u007f]/.test(m.worktree) ? m.worktree : null,
      branch: verifyOnly ? null : (job.branch ?? null),
      base: isSafeBranch(m.base) ? m.base : null,
      pr: cleanRepoPr(m.pr),
      verifyOnly,
      interim: interimOrNull(m.interim),
    });
  }
  return out;
}

// A hand-edited value outside the four strategies reads as no override, never as one Forge guesses at.
const interimOrNull = (v: unknown) => (isInterimStrategy(v) ? v : null);

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

/** The states a job never leaves on its own; isActive in lib/jobs.ts is false for exactly these. */
export const FINISHED_STATES = ['done', 'cancelled'] as const;

/**
 * A job's agents with every one still marked running ended as `lost` when the job has finished, and
 * the roles it ended. A job can finish while an agent runs (cancelled mid-build, merged during a
 * rework), and nothing records that agent's end afterwards, so without this the dashboard shows it
 * running forever and the claim and daemon slot wait on it.
 */
export function endFinishedJobAgents(agents: Record<string, JobAgent>, state: string, at: string | null, keep: readonly string[] = []): { agents: Record<string, JobAgent>; roles: string[] } {
  if (!(FINISHED_STATES as readonly string[]).includes(state)) return { agents, roles: [] };
  const roles = Object.keys(agents).filter((role) => agents[role]?.status === 'running' && !keep.includes(role));
  if (!roles.length) return { agents, roles };
  const out = { ...agents };
  for (const role of roles) out[role] = { ...out[role], status: 'lost', endedAt: at, summary: `lost: the job was ${state} while it ran` };
  return { agents: out, roles };
}

/** The roles a finished job may still run: the judge of a done job's queued post-merge score run (JS1-JS3). */
export function finishedJobRoles(job: { state?: unknown; kind?: unknown; score?: unknown }): string[] {
  return job.state === 'done' && job.kind !== 'eval' && (job.score as JobScore | null | undefined)?.status === 'queued' ? ['judge'] : [];
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
  // A current-version file may still carry `source` (a hand edit, or a write that raced the
  // upgrade): folded the same way, then dropped, so no reader can see both.
  const { source: legacySource, ...rest } = job;
  const score = cleanScore(job.score);
  return {
    ...rest,
    schemaVersion: JOB_SCHEMA_VERSION,
    id: job.id,
    title: job.title ?? job.id,
    kind: job.kind ?? 'feature',
    size: job.size ?? null,
    issues: cleanIssues(job.issues ?? (legacySource !== undefined ? sourceToIssues(legacySource) : [])),
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
    ports: cleanPorts(job.ports),
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
    // Repairs jobs a Forge before endFinishedJobAgents finished with an agent still marked running.
    agents: endFinishedJobAgents(job.agents ?? {}, job.state ?? 'queued', job.finishedAt ?? job.updatedAt ?? null, finishedJobRoles({ state: job.state, kind: job.kind ?? 'feature', score })).agents,
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
    interim: interimOrNull(job.interim),
    repos: cleanRepos({ branch: job.branch ?? null, base: job.base ?? null, worktree: job.worktree ?? null, pr: job.pr ?? null, interim: job.interim, repos: job.repos }),
    outcome: cleanOutcome(job.outcome),
    score,
  };
}

export function serializeJob(job: LoadedJob): Job {
  const { _unsupported, ...rest } = job;
  // Rebuilt from the final top-level fields, so a write through them can never leave repos[0] behind.
  return { ...rest, repos: cleanRepos(rest), schemaVersion: JOB_SCHEMA_VERSION };
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
