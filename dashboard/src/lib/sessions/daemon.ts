// The status bar's Workers and Inbox popovers' and the session log's pure, DOM-free half: session pills, the pool summary and POST /api/daemon.
// Session state and errors come from session output, i.e. untrusted text: these return plain strings rendered as text.
import { ago } from '../core/util.ts';
import { projectApi } from '../core/project.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, sharedScope } from '../core/types.ts';
import type { DaemonBilling, DaemonPermissionMode, DaemonPoolState, DaemonSessionState } from '../core/types.ts';

export const START_HINT = 'Set daemon.enabled: true in .forge/config.yml';
const JOB_LABEL = 24;

export const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** A session as /api/state, SSE or a POST reply delivers it; any field may be missing. */
export type SessionInput = Partial<DaemonSessionState> | null | undefined;
/** The pool as /api/state or a POST reply delivers it. */
export type PoolInput = Partial<DaemonPoolState> | null | undefined;

export interface Pill {
  label: string;
  tone: string;
  title: string;
}

export interface JobChip {
  id: string;
  label: string;
  pill: Pill;
  /** The mode a human put this session in, when it isn't daemon.command's. */
  mode: DaemonPermissionMode | null;
  /** The running child's latest turn context in tokens; null without a finite reading >= 0. */
  context: number | null;
}

/** A session's contextTokens when it is a finite number >= 0 (it is claude's own report), else null. */
const contextOf = (s: Record<string, any>): number | null => (typeof s.contextTokens === 'number' && Number.isFinite(s.contextTokens) && s.contextTokens >= 0 ? s.contextTokens : null);

export interface PoolModel {
  pill: Pill;
  inbox: Pill;
  /** The office session's pill, or null while foreman.enabled is false. */
  office: Pill | null;
  live: number;
  cap: number;
  held: string[];
  waiting: string[];
  /** Job sessions kept by running agents of their job. */
  kept: string[];
  /** Listed job sessions, in status order. */
  jobs: JobChip[];
  /** lastError, unless the pill already says error. */
  error: string | null;
  /** The pool is off only until a human approves the project's trusted files: the panel says so in text, and Start approves them. */
  approval: boolean;
  canStart: boolean;
  canStop: boolean;
  /** Why Start is disabled when the config, not a pending request, is the reason. */
  startHint: string | null;
  /** The popover's one pool Start/Stop: Stop while the pool is wanted or anything runs, else Start; enabled by that action's flag. */
  toggle: { action: 'start' | 'stop'; enabled: boolean };
}

const running = (s: unknown) => obj(s).running === true;
/** A running session with a tool call waiting on a human: the status bar's and the board's "needs permission". */
export const asking = (s: unknown): boolean => running(s) && Array.isArray(obj(s).permissions) && obj(s).permissions.length > 0;

/** Status labels in the order the Workers popover lists job sessions. */
const ORDER = ['needs permission', 'busy', 'agents running', 'failing', 'idle', 'stopping', 'waiting for slot', 'held: repo budget', 'held: budget', 'error', 'stopped', 'standby', 'no session'];

/**
 * One session's status chip: needs permission (a tool call waits on a human), busy, stopping, waiting for slot, held: repo budget, held: budget,
 * failing (alive, but its last turn failed) or error, agents running (idle, but its job's agents keep it), idle, stopped, standby or no session.
 */
export function sessionPill(session: SessionInput): Pill {
  const s = obj(session);
  let label = 'no session';
  let tone = 'muted';
  if (!session) [label, tone] = ['no session', 'muted'];
  else if (asking(s)) [label, tone] = ['needs permission', 'warn'];
  else if (s.status === 'busy') [label, tone] = ['busy', 'live'];
  else if (s.status === 'stopping') [label, tone] = ['stopping', 'warn'];
  else if (s.waiting) [label, tone] = ['waiting for slot', 'warn'];
  else if (s.held === 'repo-budget') [label, tone] = ['held: repo budget', 'warn'];
  else if (s.held) [label, tone] = ['held: budget', 'warn'];
  else if (s.lastError) [label, tone] = s.status === 'idle' ? ['failing', 'bad'] : ['error', 'bad'];
  else if (s.kept === 'agents' && s.status === 'idle') [label, tone] = ['agents running', 'live'];
  else if (s.status === 'idle') [label, tone] = ['idle', 'ok'];
  else if (s.wanted === false) [label, tone] = ['stopped', 'muted'];
  else if (s.sessionId || Number(s.turns) > 0) [label, tone] = ['standby', 'muted'];
  const title = !session
    ? 'no session'
    : [
        s.sessionId ? `session ${String(s.sessionId).slice(0, 8)}` : 'no session',
        `${Number(s.turns) || 0} turns`,
        s.lastTurnAt ? `last turn ${ago(s.lastTurnAt)}` : 'no turns yet',
        ...(Number(s.failures) ? [`${Number(s.failures)} failed starts`] : []),
        ...(s.lastError ? [String(s.lastError)] : []),
        ...(label === 'agents running' ? ['kept: its job has agents running'] : []),
        ...(label === 'standby' || label === 'no session' ? ['starts on its next request'] : []),
      ].join('\n');
  return { label, tone, title };
}

/**
 * Several sessions as one chip: the most urgent of their pills by ORDER (needs permission first, the first session on a
 * tie), titled with one `name: label` line per session. One session keeps its own pill, as the Foreman's office session does.
 */
export function familyPill(sessions: readonly { name: string; session: SessionInput }[]): Pill {
  const pills = sessions.map(({ name, session }) => ({ name, pill: sessionPill(session) }));
  if (pills.length <= 1) return pills[0]?.pill ?? sessionPill(null);
  const top = pills.reduce((a, b) => (ORDER.indexOf(b.pill.label) < ORDER.indexOf(a.pill.label) ? b : a)).pill;
  return { label: top.label, tone: top.tone, title: pills.map(({ name, pill }) => `${name}: ${pill.label}`).join('\n') };
}

/** Everything the Workers popover shows, and the inbox pill the Inbox popover shows, or null exactly when the daemon is off (not enabled, not wanted, nothing running). */
export function poolModel(pool: PoolInput, { pending }: { pending: boolean }): PoolModel | null {
  const p = obj(pool);
  const jobs = Object.entries(obj(p.jobs)).map(([id, s]) => [id, obj(s)] as const);
  const foreman = p.foreman === true;
  const sessions = [obj(p.inbox), ...(foreman ? [obj(p.office)] : []), ...jobs.map(([, s]) => s)];
  const anyRunning = sessions.some(running);
  if (!pool || (!p.enabled && !p.wanted && !anyRunning)) return null;
  // Off because nobody has approved the files yet: an expected state a human acts on, never an error.
  const approval = p.needsApproval === true && !p.wanted && !anyRunning;
  let label = 'stopped';
  let tone = 'muted';
  if (sessions.some(asking)) [label, tone] = ['needs permission', 'warn'];
  else if (sessions.some((s) => s.status === 'busy')) [label, tone] = ['busy', 'live'];
  else if (p.wanted && sessions.some((s) => s.lastError)) [label, tone] = ['failing', 'bad'];
  else if (anyRunning) [label, tone] = ['idle', 'ok'];
  else if (sessions.some((s) => s.status === 'stopping')) [label, tone] = ['stopping', 'warn'];
  else if (p.wanted) [label, tone] = ['standby', 'muted'];
  else if (approval) [label, tone] = ['needs approval', 'warn'];
  else if (p.lastError) [label, tone] = ['error', 'bad'];
  const chips = jobs
    .map(([id, s]) => ({ id, label: id.length > JOB_LABEL ? `${id.slice(0, JOB_LABEL)}…` : id, pill: sessionPill(s), mode: chosenOverride(p, id), context: contextOf(s) }))
    .sort((a, b) => ORDER.indexOf(a.pill.label) - ORDER.indexOf(b.pill.label) || (a.id < b.id ? -1 : 1));
  const canStart = p.enabled === true && !p.wanted && !anyRunning && !pending;
  const canStop = Boolean(p.wanted || anyRunning) && !pending;
  // canStart and canStop are never both true, so the one toggle never hides an action that could run.
  const action = p.wanted || anyRunning ? 'stop' : 'start';
  return {
    pill: {
      label,
      tone,
      title: p.lastError ? String(p.lastError) : [`${jobs.filter(([, s]) => running(s)).length} job sessions running`, ...sessions.filter((s) => s.lastError).map((s) => `${String(s.scope ?? '')}: ${String(s.lastError)}`)].join('\n'),
    },
    inbox: sessionPill(p.inbox ?? null),
    office: foreman ? sessionPill(p.office ?? null) : null,
    live: Number(p.live) || 0,
    cap: Number(p.maxConcurrent) || 0,
    held: jobs.filter(([, s]) => s.held).map(([id]) => id),
    waiting: jobs.filter(([, s]) => s.waiting).map(([id]) => id),
    kept: jobs.filter(([, s]) => s.kept === 'agents').map(([id]) => id),
    jobs: chips,
    error: p.lastError && label !== 'error' ? String(p.lastError) : null,
    approval,
    canStart,
    canStop,
    startHint: !canStart && p.enabled !== true ? START_HINT : null,
    toggle: { action, enabled: action === 'stop' ? canStop : canStart },
  };
}

/** One row of the Workers popover: a job session, its pill, its job's title (null when the job is unknown), its own mode and its context. */
export type DaemonRow = { id: string; title: string | null; pill: Pill; mode: DaemonPermissionMode | null; context: number | null };

/**
 * The Workers popover's session rows: one per job session, in the model's status order. The inbox session has its own
 * Inbox popover, and the Foreman leads the Workers popover in its own row, so neither is among these. A title comes from
 * `jobs` (the /api/state list); it is untrusted text.
 */
export function daemonRows(model: PoolModel, jobs: readonly { id: string; title?: string | null }[]): DaemonRow[] {
  const titles = new Map(jobs.map((j) => [j.id, typeof j.title === 'string' ? j.title : null]));
  return model.jobs.map((j) => ({ id: j.id, title: titles.get(j.id) ?? null, pill: j.pill, mode: j.mode, context: j.context }));
}

/**
 * The Thread session log's Start/Stop: Start once the pool runs and this session is stopped or failed;
 * Stop while it runs, or while the pool runs and it would spawn on demand (stopping it then keeps it off).
 */
export function sessionControls(session: SessionInput, poolWanted: boolean, pending: boolean): { canStart: boolean; canStop: boolean } {
  const s = obj(session);
  const wanted = session ? s.wanted !== false : true;
  return {
    canStart: poolWanted && (!wanted || Boolean(s.lastError)) && !pending,
    canStop: (running(session) || (wanted && poolWanted)) && !pending,
  };
}

/**
 * The session log's one Start/Stop button: Stop while the session runs; otherwise Start when it can start, a disabled
 * Start when a human stopped it (it stays off until Start), and Stop (enabled or not) for one that would spawn on demand.
 * A failed session that isn't running shows Start, which retries.
 */
export function sessionToggle(controls: { canStart: boolean; canStop: boolean }, session: SessionInput): { action: 'start' | 'stop'; enabled: boolean } {
  if (running(session)) return { action: 'stop', enabled: controls.canStop };
  if (controls.canStart) return { action: 'start', enabled: true };
  if (session && obj(session).wanted === false) return { action: 'start', enabled: false };
  return { action: 'stop', enabled: controls.canStop };
}

/** The pool's session for a scope (the inbox's, the office's or a job's; own keys only, so a job id never reads Object.prototype), or null. */
export function scopeSession(pool: PoolInput, scope: string): Partial<DaemonSessionState> | null {
  const p = obj(pool);
  if (scope === INBOX_SCOPE) return p.inbox ?? null;
  if (scope === OFFICE_SCOPE) return p.office ?? null;
  const jobs = obj(p.jobs);
  return Object.hasOwn(jobs, scope) ? (jobs[scope] ?? null) : null;
}

/** The modes a session can be switched to: lib/integrations/claude/argv.ts PERMISSION_MODES. */
export const PERMISSION_MODES: readonly DaemonPermissionMode[] = ['default', 'auto', 'dontAsk'];

function chosenOverride(p: Record<string, any>, scope: string): DaemonPermissionMode | null {
  const m = obj(p.permissionModes)[scope];
  return PERMISSION_MODES.find((x) => x === m) ?? null;
}

/** The job sessions' default the human chose, or null when they follow daemon.command's mode. */
export function jobDefaultMode(pool: PoolInput): DaemonPermissionMode | null {
  const m = obj(pool).jobPermissionMode;
  return PERMISSION_MODES.find((x) => x === m) ?? null;
}

/**
 * The run's launch mode (`forge dash --permission-mode`) from a pool state or ProjectsResponse['machine'], or null
 * without one; anything but the three modes reads as null.
 */
export function launchMode(v: unknown): DaemonPermissionMode | null {
  const m = obj(v).launchPermissionMode;
  return PERMISSION_MODES.find((x) => x === m) ?? null;
}

/** The mode a job session without its own choice runs in: the job default, else daemon.command's. */
export function jobFallbackMode(pool: PoolInput): string {
  const p = obj(pool);
  return jobDefaultMode(p) ?? (typeof p.permissionMode === 'string' && p.permissionMode ? p.permissionMode : 'default');
}

export interface SessionMode {
  /** The mode the session runs in, or starts in next: the human's choice for it, else the job default for a job, else the launch mode for the inbox and office, else daemon.command's. */
  chosen: string;
  /** The running child reports another mode: a switch claude hasn't confirmed yet. */
  live: string | null;
  /** Whether a human chose it for this session (as opposed to the job default or daemon.command). */
  overridden: boolean;
}

/** One session's permission mode for the selector, from the pool (the choice) and the session (what claude reports). */
export function sessionMode(pool: PoolInput, scope: string, session: SessionInput): SessionMode {
  const p = obj(pool);
  const override = chosenOverride(p, scope);
  const shared = sharedScope(scope);
  const command = typeof p.permissionMode === 'string' && p.permissionMode ? p.permissionMode : 'default';
  // The launch mode reaches the inbox and office; a chat keeps its own branch.
  const launched = scope === INBOX_SCOPE || scope === OFFICE_SCOPE ? launchMode(p) : null;
  const chosen = override ?? (shared ? (launched ?? command) : jobFallbackMode(p));
  const s = obj(session);
  const reported = s.running === true && typeof s.permissionMode === 'string' && s.permissionMode ? s.permissionMode : null;
  return { chosen, live: reported !== null && reported !== chosen ? reported : null, overridden: override !== null };
}

/** A POST reply carries no config read, so `enabled` stays whatever the last /api/state said. */
export function mergePoolState(prev: PoolInput, next: unknown): Partial<DaemonPoolState> {
  return { ...obj(prev), ...obj(next), enabled: prev ? obj(prev).enabled : obj(next).enabled };
}

/** An SSE state frame replaces the session's fields it carries. */
export function mergeSessionState(prev: SessionInput, next: unknown): Partial<DaemonSessionState> {
  return { ...obj(prev), ...obj(next) };
}

/** POST /api/daemon/mode: puts one session (or, as JOBS_SCOPE, the job sessions' default) in a permission mode. Resolves with the pool state; throws like postDaemon. */
export async function postDaemonMode(scope: string, mode: DaemonPermissionMode, fetchImpl: typeof fetch = fetch): Promise<DaemonPoolState> {
  return postJson('/api/daemon/mode', { scope, mode }, fetchImpl);
}

/**
 * POST /api/daemon, for the pool or (with `scope`) one session. Resolves with the pool state;
 * throws with the server's `error` field, else its text, else the status text.
 */
export async function postDaemon(action: 'start' | 'stop', scope?: string, fetchImpl: typeof fetch = fetch): Promise<DaemonPoolState> {
  return postJson('/api/daemon', scope === undefined ? { action } : { action, scope }, fetchImpl);
}

/**
 * The Workers popover's billing line: whether sessions get the variables, their names joined, and whether it is a warning
 * (a provider switch or ANTHROPIC_BASE_URL is set, doctor's rule; else it is muted); null when none is set.
 */
export function billingNote(b: DaemonBilling | null | undefined): { passed: boolean; vars: string; warn: boolean } | null {
  if (!b || !Array.isArray(b.vars) || !b.vars.length) return null;
  return { passed: b.passed === true, vars: b.vars.join(', '), warn: b.warn === true };
}

async function postJson(url: string, payload: unknown, fetchImpl: typeof fetch): Promise<DaemonPoolState> {
  const res = await fetchImpl(projectApi(url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error((body && typeof body.error === 'string' && body.error) || text || res.statusText);
  return body;
}
