// Versioned data shapes. Every persisted file carries `schemaVersion`; readers upgrade old
// shapes in memory (and `forge migrate` rewrites them on disk), so a plugin update never
// strands jobs or configs written by an older version. A file from a *newer* plugin is
// refused rather than guessed at. The version step lists live in lib/core/versions/.
import { isInterimStrategy, servicesToComponents } from '../config/components.ts';
import { isSha } from '#engine/pr/delta.ts';
import { isSafeUrl, isStoredRef, sameIssue } from './issue-ref.ts';
import { REPO_NAME, isSafeBranch } from '#engine/project/member-repos.ts';
import { ACTOR_SOURCES, COMPLEXITIES, EFFORTS, OFFICE_GATES, WAITING_ON } from '#api/constants.ts';
import { runSteps } from '../versions/steps.ts';
import { CONFIG_SCHEMA_VERSION, CONFIG_STEPS } from '../versions/config.ts';
import { JOB_SCHEMA_VERSION, JOB_STEPS, noLease, ownerToLease, sourceToIssues } from '../versions/job.ts';
import { EVENT_SCHEMA_VERSION, EVENT_STEPS } from '../versions/event.ts';
import { isMap } from '../shape.ts';
import { safeText } from '../text.ts';
import type { AgentRun, AgentRunEnd, AgentUsage, ContextComposition, ContextPart, EventActor, HumanGrant, Job, JobAgent, JobEvent, JobIssue, JobLease, JobOutcome, JobRepo, JobRepoPr, JobScore, JobShelf, LoadedJob, RunBilling } from '../types.ts';

export { ACTOR_SOURCES, BUDGET_KEYS, COMPLEXITIES, EFFORTS, HANDOFF_CLASSES, MANDATE_ON_UNFINISHABLE, MANDATE_ORDERS, MANDATE_SCORING, MANDATE_STATUSES, MANDATE_UNTIL, OFFICE_GATES, REPO_BUDGET_KEYS, REPO_BUDGET_MODES, STAGES, STATES, WAITING_ON } from '#api/constants.ts';
export { COMPONENT_KINDS, DEPENDENCY_TYPES, LINK_ECOSYSTEMS } from '../config/components.ts';
export { BACKING_DB_ENGINES, BACKING_ISOLATIONS } from '../config/validators/backing.ts';
export { CONFIG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION, noLease };
export { API_VERSION } from '#api/versions.ts';
export { MACHINE_INDEX_VERSION } from '../versions/machine.ts';

/** `.forge/archive/<id>.json` records (lib/core/job/archive.ts); a reader skips a record from a newer Forge. */
export const ARCHIVE_SCHEMA_VERSION = 1;

export const SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;

/** daemon.auth: the credential a daemon session runs on. */
export const DAEMON_AUTH = ['subscription', 'api-key'] as const;

/** daemon.keepAwake: whether this project's work in flight holds the machine's sleep assertion. */
export const KEEP_AWAKE_MODES = ['auto', 'never'] as const;

/** notify.webhooks[].events: what Forge can notify about, most specific first where two overlap. */
export const NOTIFY_EVENTS = ['gate', 'pr-opened', 'pr-merged', 'job-failed', 'daemon-stopped', 'budget-exceeded', 'secret-found', 'service-restarted', 'mandate-stalled', 'mandate-budget', 'mandate-closed'] as const;

/** notify.webhooks[].format: the body Forge posts. */
export const NOTIFY_FORMATS = ['json', 'slack'] as const;

/** The waitingOn values that are human gates; pr-review and external wait on someone outside Forge. */
export const NOTIFY_GATES = ['spec-approval', 'split-approval', 'issue-link', 'input', 'escalation', 'infra', 'conflicts', 'rounds-exhausted', 'budget', 'human'] as const;

/** A model alias or id as runtime.models and the builder overrides take it; here so config.ts and config-fields.ts share it without an import cycle. */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]*$/;

/**
 * The roles runtime.efforts sets, in runtime.models order. No orchestrator: sessions take runtime.effort.
 * No assistant: its effort is foreman.assistants.effort.
 */
export const EFFORT_ROLES = ['planner', 'spec-writer', 'designer', 'builder', 'reviewer', 'approver', 'integrator', 'retro', 'judge'] as const;

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

/**
 * foreman.ship, in order, each level including the one before (shipAllows in lib/core/config/load.ts):
 * propose leaves merging as it was; merge counts as merge.auto for the approver and PR4; release also
 * lets a mandate run until `released`. No level makes the Foreman decide a release: foreman.decides does.
 */
export const FOREMAN_SHIP = ['propose', 'merge', 'release'] as const;

const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length <= 64 && Number.isFinite(Date.parse(v)) ? v : null);

/**
 * A stored lease in its exact shape. job.json is writable outside the CLI, so a missing, partial or
 * malformed one reads field by field: a bad driver is none, a bad epoch 0, a bad time null (an
 * unreadable expiry reads as expired, never as live).
 */
function cleanLease(raw: unknown): JobLease {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return noLease();
  const l = raw as Record<string, unknown>;
  const driver = typeof l.driver === 'string' && l.driver && l.driver.length <= 200 ? l.driver : null;
  const epoch = Number.isSafeInteger(l.epoch) && (l.epoch as number) >= 0 ? (l.epoch as number) : 0;
  return { driver, epoch, since: isoOrNull(l.since), renewedAt: isoOrNull(l.renewedAt), expiresAt: isoOrNull(l.expiresAt) };
}

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

/** The longest shelve reason, in characters. */
export const SHELVE_REASON_MAX = 200;

/** A shelve reason as Forge stores and posts it: one line, no control characters or backticks, at most 200 characters; '' when nothing is left. */
export function cleanShelveReason(raw: unknown): string {
  return typeof raw === 'string' ? safeText(raw.trim(), SHELVE_REASON_MAX).trim() : '';
}

/** The states a job is shelved from, and so the states un-shelving restores. */
export const SHELF_FROM_STATES = ['waiting', 'queued', 'failed', 'blocked'] as const;

/**
 * A stored shelf record in the shape `forge job shelve` writes, or null. Kept only on a job waiting on
 * `shelved`. job.json is writable outside the CLI and `from` decides where un-shelving puts the job, so
 * a record whose `from` names a state shelve never takes (running) or the shelf itself is dropped, and
 * the job then un-shelves to a person's wait.
 */
export function cleanShelf(raw: unknown, job: { state?: unknown; waitingOn?: unknown }): JobShelf | null {
  if (job.state !== 'waiting' || job.waitingOn !== 'shelved' || !isMap(raw) || !isTime(raw.at)) return null;
  const reason = cleanShelveReason(raw.reason);
  const from = raw.from;
  if (!reason || !isMap(from) || !(SHELF_FROM_STATES as readonly unknown[]).includes(from.state)) return null;
  const waits = from.state === 'waiting';
  if (waits ? from.waitingOn === 'shelved' || !(WAITING_ON as readonly unknown[]).includes(from.waitingOn) : from.waitingOn !== null) return null;
  if (from.reason !== null && typeof from.reason !== 'string') return null;
  const a = raw.actor;
  const source = isMap(a) && isActorSource(a.source) ? a.source : 'unknown';
  // A foreman entry never carries a login, as normalizeActor reads it.
  const login = source !== 'unknown' && source !== 'foreman' && typeof a?.login === 'string' ? sanitizeLogin(a.login) || null : null;
  return { at: raw.at, reason, actor: { login, source }, from: { state: from.state as JobShelf['from']['state'], waitingOn: from.waitingOn as JobShelf['from']['waitingOn'], reason: from.reason as string | null } };
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

/** What openMemberPr and syncMemberPrs record (lib/engine/pr/members.ts). */
const REPO_PR_KEYS = ['number', 'url', 'state', 'isDraft', 'openedAt', 'lastSyncedAt', 'pushedSha', 'headOid', 'mergeable', 'mergeState', 'checks', 'changesRequested', 'mergedAt'] as const;

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

export function migrateConfig(raw: any): { config: any; from: number | undefined } {
  let config = raw ?? {};
  const from = config.schemaVersion ?? CONFIG_SCHEMA_VERSION;
  if (from > CONFIG_SCHEMA_VERSION) return { config, from };
  config = runSteps(CONFIG_STEPS, config, from);
  // An unversioned or hand-written config may still use the old key; fold it the same way.
  if (from === CONFIG_SCHEMA_VERSION) config = servicesToComponents(config);
  config.schemaVersion = CONFIG_SCHEMA_VERSION;
  return { config, from: from === CONFIG_SCHEMA_VERSION ? undefined : from };
}

/** The states a job never leaves on its own; isActive in lib/core/job/store.ts is false for exactly these. */
const FINISHED_STATES = ['done', 'cancelled'] as const;

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

/** The agent runs one agent record keeps in runHistory; the oldest drop first. */
export const MAX_AGENT_RUNS = 50;
/** A composition tool part's name as composeContext stores it: `mcp:` and a 64-char name, with room to spare. */
const MAX_PART_NAME = 70;
/** A token count as usage reports it: any finite number ≥ 0. */
const isTokens = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const countOf = (v: unknown): number => (isTokens(v) ? v : 0);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
/** A list's string entries, or null when it is not a list. */
const stringList = (v: unknown): string[] | null => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null);

/**
 * A run's billing split from the usage its end reported: counts that are not finite numbers ≥ 0 read as 0, and the
 * total is the reported one or, as addUsage computes it, their sum. Null without usage.
 */
export function runBilling(u?: AgentUsage | null): RunBilling | null {
  if (!u || typeof u !== 'object') return null;
  const b = { input: countOf(u.input), output: countOf(u.output), cacheRead: countOf(u.cacheRead), cacheWrite: countOf(u.cacheWrite) };
  return { ...b, totalTokens: isTokens(u.totalTokens) ? u.totalTokens : b.input + b.output + b.cacheRead + b.cacheWrite };
}

/** Adds `more`'s counts to `run`'s billing. */
export function addBilling(run: AgentRun, more: RunBilling): void {
  const u = run.usage;
  run.usage = u
    ? { input: u.input + more.input, output: u.output + more.output, cacheRead: u.cacheRead + more.cacheRead, cacheWrite: u.cacheWrite + more.cacheWrite, totalTokens: u.totalTokens + more.totalTokens }
    : more;
}

/**
 * Records an agent end on the agent's runHistory (recordAgent in ./store.ts). The end of a running agent is a new
 * agent run, usage or not (a lost run has none). A further end with usage on an ended agent adds its counts to the
 * last run and, when it has one, its composition; with no recorded run it is a run of its own unless legacy runs
 * exist, whose events fold it in. An end without usage on an ended agent records nothing. The newest MAX_AGENT_RUNS stay.
 */
export function recordRun(a: JobAgent, end: AgentRunEnd): void {
  if (!Array.isArray(a.runHistory)) a.runHistory = [];
  const list = a.runHistory;
  const usage = runBilling(end.usage);
  const last = list.at(-1);
  if (!end.wasRunning) {
    if (!usage) return;
    if (last) {
      addBilling(last, usage);
      if (end.composition) last.composition = end.composition;
      return;
    }
    if (countOf(a.legacyRuns) > 0) return;
  }
  list.push({ round: end.round, startedAt: end.wasRunning ? (a.startedAt ?? null) : null, endedAt: end.at, status: end.status, model: end.model, usage, composition: end.composition ?? null });
  if (list.length > MAX_AGENT_RUNS) list.splice(0, list.length - MAX_AGENT_RUNS);
}

/** A stored composition, or null unless every count is a finite number ≥ 0, every tool part is named, and the parts sum to the total. */
export function cleanComposition(v: unknown): ContextComposition | null {
  if (!v || typeof v !== 'object') return null;
  const c = v as Record<string, unknown>;
  const keys = ['total', 'forgePrompt', 'harness', 'carried', 'assistant', 'user'] as const;
  if (!keys.every((k) => isTokens(c[k])) || !Array.isArray(c.tools)) return null;
  const tools: ContextPart[] = [];
  for (const p of c.tools as unknown[]) {
    const part = p as { name?: unknown; tokens?: unknown } | null;
    if (!part || typeof part !== 'object' || typeof part.name !== 'string' || !part.name || part.name.length > MAX_PART_NAME || !isTokens(part.tokens)) return null;
    tools.push({ name: part.name, tokens: part.tokens });
  }
  const n = (k: (typeof keys)[number]) => c[k] as number;
  const sum = n('forgePrompt') + n('harness') + n('carried') + n('assistant') + n('user') + tools.reduce((s, p) => s + p.tokens, 0);
  if (sum !== n('total')) return null;
  return { total: n('total'), forgePrompt: n('forgePrompt'), harness: n('harness'), carried: n('carried'), tools, assistant: n('assistant'), user: n('user') };
}

/** A stored agent run, or null when it is not an object or its usage is malformed; a malformed composition reads as null. */
export function cleanRun(v: unknown): AgentRun | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const u = r.usage as Record<string, unknown> | null | undefined;
  const billing = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'] as const;
  if (u != null && (typeof u !== 'object' || !billing.every((k) => isTokens(u[k])))) return null;
  return {
    round: typeof r.round === 'number' && Number.isInteger(r.round) ? r.round : null,
    startedAt: strOrNull(r.startedAt),
    endedAt: strOrNull(r.endedAt),
    status: strOrNull(r.status),
    model: strOrNull(r.model),
    usage: u == null ? null : { input: u.input as number, output: u.output as number, cacheRead: u.cacheRead as number, cacheWrite: u.cacheWrite as number, totalTokens: u.totalTokens as number },
    composition: cleanComposition(r.composition),
  };
}

/**
 * Upgrades and fills defaults so every consumer can rely on the current shape.
 */
export function normalizeJob(raw: any): LoadedJob {
  let job = raw ?? {};
  const from = job.schemaVersion ?? 1;
  if (from > JOB_SCHEMA_VERSION) return { ...job, _unsupported: true };
  job = runSteps(JOB_STEPS, job, from);
  // A current-version file may still carry `source` (a hand edit, or a write that raced the
  // upgrade): folded the same way, then dropped, so no reader can see both.
  // `owner` likewise: a current-version file carrying one (and no lease) reads it as the migration would.
  // `services` likewise: a current-version file carrying one reads it as `components`.
  const { source: legacySource, owner: legacyOwner, services: legacyServices, ...rest } = job;
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
    components: stringList(job.components ?? legacyServices) ?? [],
    componentsDeclared: stringList(job.componentsDeclared),
    componentsFromDiff: stringList(job.componentsFromDiff),
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
    lease: job.lease === undefined && legacyOwner ? ownerToLease(legacyOwner) : cleanLease(job.lease),
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
    // Never dropped to null when malformed: null would widen what the Foreman decides. A bad value
    // stays a string, which then reads as an unreadable mandate and fails closed.
    mandate: job.mandate == null ? null : String(job.mandate),
    complexity: (COMPLEXITIES as readonly unknown[]).includes(job.complexity) ? job.complexity : null,
    // Tolerant: anything but an object with a hits list reads as no flag. Safe, because verify and
    // pr open recompute the set from git rather than trusting this.
    protectedPaths: job.protectedPaths && typeof job.protectedPaths === 'object' && Array.isArray(job.protectedPaths.hits) ? job.protectedPaths : null,
    interim: interimOrNull(job.interim),
    repos: cleanRepos({ branch: job.branch ?? null, base: job.base ?? null, worktree: job.worktree ?? null, pr: job.pr ?? null, interim: job.interim, repos: job.repos }),
    outcome: cleanOutcome(job.outcome),
    score,
    shelved: cleanShelf(job.shelved, { state: job.state ?? 'queued', waitingOn: job.waitingOn ?? null }),
    // Only true marks it, and only on a finished job: checkShelfMove sets and clears it with the state.
    finishedWhileShelved: job.finishedWhileShelved === true && (job.state === 'done' || job.state === 'cancelled'),
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
 * A HumanGrant, checked at runtime: the engine's human-only operations (mergePr's `now`, budgetCmd's
 * `grant`) refuse anything else, so a stray `true` from a caller that skipped the channel fails loudly.
 */
export function isHumanGrant(v: unknown): v is HumanGrant {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const g = v as { channel?: unknown; actor?: unknown };
  if (g.channel !== 'terminal' && g.channel !== 'dashboard') return false;
  if (!g.actor || typeof g.actor !== 'object' || Array.isArray(g.actor)) return false;
  return isActorSource((g.actor as { source?: unknown }).source);
}

/**
 * Any stored actor as the v2 object. The legacy strings keep their v1 meaning whatever the event's
 * version says: `"foreman"` stays the foreman's, so a foreman decision can never read as a person's (protected paths).
 */
function normalizeActor(raw: unknown): EventActor {
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

/**
 * One parsed events.jsonl line in the current shape, or null when it is not an event at all. A
 * line from a newer Forge is kept as written except that its actor is still sanitised.
 */
export function normalizeEvent(raw: unknown): JobEvent | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let e: any = raw;
  const from = typeof e.v === 'number' ? e.v : 1;
  if (from <= EVENT_SCHEMA_VERSION) {
    e = runSteps(EVENT_STEPS, e, from);
    e = { ...e, v: EVENT_SCHEMA_VERSION };
  }
  if (e.actor !== undefined) e = { ...e, actor: normalizeActor(e.actor) };
  return e as JobEvent;
}
