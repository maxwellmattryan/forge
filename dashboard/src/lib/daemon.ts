// The daemon bar's and the Thread session log's pure, DOM-free half: session pills, the pool summary and POST /api/daemon.
// Session state and errors come from session output, i.e. untrusted text: these return plain strings rendered as text.
import { ago } from './util.ts';
import type { DaemonPermissionMode, DaemonPoolState, DaemonSessionState } from './types.ts';

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
}

export interface PoolModel {
  pill: Pill;
  inbox: Pill;
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
  canStart: boolean;
  canStop: boolean;
  /** Why Start is disabled when the config, not a pending request, is the reason. */
  startHint: string | null;
}

const running = (s: unknown) => obj(s).running === true;
/** A running session with a tool call waiting on a human: the bar's and the board's "needs permission". */
export const asking = (s: unknown): boolean => running(s) && Array.isArray(obj(s).permissions) && obj(s).permissions.length > 0;

/** Status labels in the order the bar lists job chips. */
const ORDER = ['needs permission', 'busy', 'agents running', 'failing', 'idle', 'stopping', 'waiting for slot', 'held: budget', 'error', 'stopped', 'standby', 'no session'];

/**
 * One session's status chip: needs permission (a tool call waits on a human), busy, stopping, waiting for slot, held: budget,
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

/** Everything the daemon bar shows, or null exactly when it is hidden. */
export function poolModel(pool: PoolInput, { pending }: { pending: boolean }): PoolModel | null {
  const p = obj(pool);
  const jobs = Object.entries(obj(p.jobs)).map(([id, s]) => [id, obj(s)] as const);
  const sessions = [obj(p.inbox), ...jobs.map(([, s]) => s)];
  const anyRunning = sessions.some(running);
  if (!pool || (!p.enabled && !p.wanted && !anyRunning)) return null;
  let label = 'stopped';
  let tone = 'muted';
  if (sessions.some(asking)) [label, tone] = ['needs permission', 'warn'];
  else if (sessions.some((s) => s.status === 'busy')) [label, tone] = ['busy', 'live'];
  else if (p.wanted && sessions.some((s) => s.lastError)) [label, tone] = ['failing', 'bad'];
  else if (anyRunning) [label, tone] = ['idle', 'ok'];
  else if (sessions.some((s) => s.status === 'stopping')) [label, tone] = ['stopping', 'warn'];
  else if (p.wanted) [label, tone] = ['standby', 'muted'];
  else if (p.lastError) [label, tone] = ['error', 'bad'];
  const chips = jobs
    .map(([id, s]) => ({ id, label: id.length > JOB_LABEL ? `${id.slice(0, JOB_LABEL)}…` : id, pill: sessionPill(s), mode: chosenOverride(p, id) }))
    .sort((a, b) => ORDER.indexOf(a.pill.label) - ORDER.indexOf(b.pill.label) || (a.id < b.id ? -1 : 1));
  const canStart = p.enabled === true && !p.wanted && !anyRunning && !pending;
  return {
    pill: {
      label,
      tone,
      title: p.lastError ? String(p.lastError) : [`${jobs.filter(([, s]) => running(s)).length} job sessions running`, ...sessions.filter((s) => s.lastError).map((s) => `${String(s.scope ?? '')}: ${String(s.lastError)}`)].join('\n'),
    },
    inbox: sessionPill(p.inbox ?? null),
    live: Number(p.live) || 0,
    cap: Number(p.maxConcurrent) || 0,
    held: jobs.filter(([, s]) => s.held).map(([id]) => id),
    waiting: jobs.filter(([, s]) => s.waiting).map(([id]) => id),
    kept: jobs.filter(([, s]) => s.kept === 'agents').map(([id]) => id),
    jobs: chips,
    error: p.lastError && label !== 'error' ? String(p.lastError) : null,
    canStart,
    canStop: Boolean(p.wanted || anyRunning) && !pending,
    startHint: !canStart && p.enabled !== true ? START_HINT : null,
  };
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

/** The modes a session can be switched to: lib/daemon.ts PERMISSION_MODES. */
export const PERMISSION_MODES: readonly DaemonPermissionMode[] = ['default', 'auto', 'dontAsk'];

function chosenOverride(p: Record<string, any>, scope: string): DaemonPermissionMode | null {
  const m = obj(p.permissionModes)[scope];
  return PERMISSION_MODES.find((x) => x === m) ?? null;
}

export interface SessionMode {
  /** The mode the session runs in, or starts in next: the human's choice, else daemon.command's. */
  chosen: string;
  /** The running child reports another mode: a switch claude hasn't confirmed yet. */
  live: string | null;
  /** Whether a human chose it (as opposed to daemon.command). */
  overridden: boolean;
}

/** One session's permission mode for the selector, from the pool (the choice) and the session (what claude reports). */
export function sessionMode(pool: PoolInput, scope: string, session: SessionInput): SessionMode {
  const p = obj(pool);
  const override = chosenOverride(p, scope);
  const chosen = override ?? (typeof p.permissionMode === 'string' && p.permissionMode ? p.permissionMode : 'default');
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

/** POST /api/daemon/mode: puts one session in a permission mode. Resolves with the pool state; throws like postDaemon. */
export async function postDaemonMode(scope: string, mode: DaemonPermissionMode, token: string, fetchImpl: typeof fetch = fetch): Promise<DaemonPoolState> {
  return postJson('/api/daemon/mode', { scope, mode }, token, fetchImpl);
}

/**
 * POST /api/daemon, for the pool or (with `scope`) one session. Resolves with the pool state;
 * throws with the server's `error` field, else its text, else the status text.
 */
export async function postDaemon(action: 'start' | 'stop', token: string, scope?: string, fetchImpl: typeof fetch = fetch): Promise<DaemonPoolState> {
  return postJson('/api/daemon', scope === undefined ? { action } : { action, scope }, token, fetchImpl);
}

async function postJson(url: string, payload: unknown, token: string, fetchImpl: typeof fetch): Promise<DaemonPoolState> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-token': token },
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
