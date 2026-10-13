// The daemon bar's pure, DOM-free half: pill and bar models, log-line summaries, the client log buffer and POST /api/daemon.
// Log lines are session output, i.e. untrusted text: these return plain strings and DaemonBar.svelte renders them as text.
import { ago } from './util.ts';
import type { DaemonSessionState } from './types.ts';

type DaemonState = DaemonSessionState & { enabled: boolean };

export const MAX_LINES = 500;
export const MAX_TEXT = 400;
export const START_HINT = 'Set daemon.enabled: true in .forge/config.yml';
export const EMPTY_NOTE = 'No daemon output yet.';
export const CLOSED_NOTE = 'Log stream closed. Reopen the log to retry.';
const DAEMON_KEYS = ['message', 'pid', 'sessionId', 'requests', 'jobs', 'code', 'signal', 'reason', 'bytes'];

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
const cap = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/** The daemon as /api/state, SSE or a POST reply delivers it; any field may be missing. */
type DaemonInput = Partial<DaemonState> | null | undefined;

export interface Pill {
  label: string;
  tone: string;
  title: string;
}

export interface BarModel {
  pill: Pill;
  /** The held jobs, for the "held: budget" chip's title; null when nothing is held. */
  held: string | null;
  /** lastError, unless the pill already says error. */
  error: string | null;
  canStart: boolean;
  canStop: boolean;
  /** Why Start is disabled when the config, not a pending request, is the reason. */
  startHint: string | null;
}

export interface LineView {
  tone: string | null;
  tag: string;
  text: string;
}

export interface LogEntry {
  seq: number;
  line: string;
}

/** The pill for /api/state's `daemon`, or null when the bar is hidden. */
export function pillModel(daemon: DaemonInput): Pill | null {
  const d = obj(daemon);
  if (!daemon || (!d.enabled && !d.wanted && !d.running)) return null;
  let label = 'stopped';
  let tone = 'muted';
  if (d.status === 'busy') [label, tone] = ['busy', 'accent'];
  else if (d.status === 'idle') [label, tone] = ['idle', 'ok'];
  else if (d.status === 'stopping') [label, tone] = ['stopping', 'warn'];
  else if (d.status === 'off' && d.wanted) [label, tone] = ['standby', 'muted'];
  else if (d.status === 'off' && d.lastError) [label, tone] = ['error', 'bad'];
  const title = [
    d.sessionId ? `session ${String(d.sessionId).slice(0, 8)}` : 'no session',
    `${Number(d.turns) || 0} turns`,
    d.lastTurnAt ? `last turn ${ago(d.lastTurnAt)}` : 'no turns yet',
    ...(d.lastError ? [String(d.lastError)] : []),
  ].join('\n');
  return { label, tone, title };
}

/** Everything the bar header shows, or null exactly when the bar is hidden. */
export function barModel(daemon: DaemonInput, { pending }: { pending: boolean }): BarModel | null {
  const pill = pillModel(daemon);
  if (!pill) return null;
  const d = obj(daemon);
  const canStart = d.enabled === true && !d.wanted && !d.running && !pending;
  return {
    pill,
    held: d.held ? str(obj(d.held).jobs ?? []) : null,
    error: d.lastError && pill.label !== 'error' ? str(d.lastError) : null,
    canStart,
    canStop: Boolean(d.wanted || d.running) && !pending,
    startHint: !canStart && d.enabled !== true ? START_HINT : null,
  };
}

/** SSE and POST states carry no config read, so `enabled` stays whatever the last /api/state said. */
export function mergeDaemonState(prev: DaemonInput, st: unknown): Partial<DaemonState> {
  return { ...obj(prev), ...obj(st), enabled: prev ? obj(prev).enabled : obj(st).enabled };
}

function daemonText(ev: Record<string, any>): string {
  const parts = [str(ev.event)];
  for (const k of DAEMON_KEYS) if (ev[k] != null) parts.push(`${k}=${str(ev[k])}`);
  return parts.join(' ');
}

function assistantText(ev: Record<string, any>): string {
  const blocks: unknown[] = Array.isArray(obj(ev.message).content) ? obj(ev.message).content : [];
  const parts = [];
  for (const b of blocks.map(obj)) {
    if (b.type === 'text') parts.push(str(b.text));
    else if (b.type === 'tool_use') parts.push(`→ ${str(b.name)}${obj(b.input).subagent_type ? ` ${str(obj(b.input).subagent_type)}` : ''}`);
    else if (b.type === 'thinking') parts.push('(thinking)');
  }
  return parts.length ? parts.join(' · ') : '(empty)';
}

function toolText(ev: Record<string, any>): string {
  const blocks: unknown[] = Array.isArray(obj(ev.message).content) ? obj(ev.message).content : [];
  const parts = blocks.map(obj).filter((b) => b.type === 'tool_result').map((b) => (b.is_error ? 'result (error)' : 'result'));
  return parts.length ? parts.join(' · ') : '(empty)';
}

/** One raw daemon.log line summarised for display. Text is capped and unescaped: the renderer escapes it. */
export function lineView(raw: string): LineView {
  const line = String(raw ?? '');
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { tone: 'muted', tag: 'raw', text: cap(line) };
  const ev = parsed as Record<string, any>;
  let v: [string | null, string, string];
  switch (ev.type) {
    case 'forge-daemon': {
      const tone = ['error', 'resume-failed', 'line-truncated'].includes(ev.event) ? 'bad' : ev.event === 'held' ? 'warn' : 'muted';
      v = [tone, 'daemon', daemonText(ev)];
      break;
    }
    case 'forge-stderr':
      v = ['bad', 'stderr', str(ev.text)];
      break;
    case 'forge-raw':
      v = ['muted', 'raw', str(ev.text)];
      break;
    case 'forge-truncated':
      v = ['warn', 'truncated', `${str(ev.originalType ?? 'line')} · ${str(ev.bytes)} bytes`];
      break;
    case 'system':
      v = ['muted', 'system', `${str(ev.subtype)}${ev.subtype === 'init' && ev.session_id ? ` ${str(ev.session_id).slice(0, 8)}` : ''}`];
      break;
    case 'assistant':
      v = [null, 'assistant', assistantText(ev)];
      break;
    case 'user':
      v = ['muted', 'tool', toolText(ev)];
      break;
    case 'result':
      v = [ev.is_error ? 'bad' : 'ok', 'result', `${str(ev.subtype)} · ${str(ev.num_turns)} turns`];
      break;
    case 'rate_limit_event':
      v = ['warn', 'rate-limit', JSON.stringify(ev)];
      break;
    default:
      v = ['muted', str(ev.type ?? ev.event ?? 'json'), JSON.stringify(ev)];
  }
  return { tone: v[0], tag: v[1], text: cap(v[2]) };
}

/**
 * Adds a line to the client buffer. `added` is false for a duplicate seq; `reset` means the
 * server restarted (lower seq) and the buffer now holds only this line; `dropped` counts the
 * oldest lines removed to stay under `max`.
 */
export function appendLine(buf: LogEntry[], entry: LogEntry, max = MAX_LINES): { buf: LogEntry[]; added: boolean; reset: boolean; dropped: number } {
  if (buf.some((e) => e.seq === entry.seq)) return { buf, added: false, reset: false, dropped: 0 };
  const last = buf.length ? buf[buf.length - 1].seq : null;
  if (last !== null && entry.seq < last) {
    buf.length = 0;
    buf.push(entry);
    return { buf, added: true, reset: true, dropped: 0 };
  }
  buf.push(entry);
  const dropped = Math.max(0, buf.length - max);
  if (dropped) buf.splice(0, dropped);
  return { buf, added: true, reset: false, dropped };
}

/**
 * POST /api/daemon. Resolves with the daemon state; throws with the server's `error` field,
 * else its text, else the status text.
 */
export async function postDaemon(action: 'start' | 'stop', token: string, fetchImpl: typeof fetch = fetch): Promise<DaemonState> {
  const res = await fetchImpl('/api/daemon', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-token': token },
    body: JSON.stringify({ action }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error((body && typeof body.error === 'string' && body.error) || text || res.statusText);
  return body;
}
