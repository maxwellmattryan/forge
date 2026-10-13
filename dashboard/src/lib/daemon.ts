// The daemon bar's pure, DOM-free half: pill model, bar and log-line HTML, the client log buffer and POST /api/daemon.
// Log lines are session output, i.e. untrusted text, so every value is escaped before it reaches the DOM.
import { esc, ago, TONE_CLASS, toneChip } from './util.ts';
import type { DaemonState } from './types.ts';

export const MAX_LINES = 500;
export const MAX_TEXT = 400;
const START_HINT = 'Set daemon.enabled: true in .forge/config.yml';
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

export interface BarUi {
  open: boolean;
  pending: boolean;
  closed?: boolean;
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

/**
 * The whole bar's HTML, or '' exactly (so `#daemon:empty` hides it) when the daemon is unused.
 * The header and the log pane are separate nodes so the mount can refresh one without the other.
 */
export function daemonBar(daemon: DaemonInput, ui: BarUi): string {
  const pill = pillModel(daemon);
  if (!pill) return '';
  const d = obj(daemon);
  const canStart = d.enabled === true && !d.wanted && !d.running;
  const canStop = Boolean(d.wanted || d.running);
  const held = d.held
    ? `<span class="chip ${TONE_CLASS.warn}" title="${esc(str(obj(d.held).jobs ?? []))}">held: budget</span>`
    : '';
  const err = d.lastError && pill.label !== 'error'
    ? `<span class="truncate min-w-0 flex-1 text-xs text-muted" title="${esc(d.lastError)}">${esc(d.lastError)}</span>`
    : '<span class="flex-1"></span>';
  const startAttrs = canStart && !ui.pending ? '' : ` disabled${d.enabled === true ? '' : ` title="${esc(START_HINT)}"`}`;
  const head =
    `<div data-daemon-head class="flex flex-wrap items-center gap-2">` +
    `<span class="chip ${TONE_CLASS[pill.tone]}" title="${esc(pill.title)}">Daemon ${esc(pill.label)}</span>${held}${err}` +
    `<span class="flex items-center gap-2">` +
    `<button class="btn text-xs" data-daemon="start"${startAttrs}>Start</button>` +
    `<button class="btn text-xs" data-daemon="stop"${canStop && !ui.pending ? '' : ' disabled'}>Stop</button>` +
    `<button class="btn text-xs" data-daemon="log" aria-expanded="${ui.open ? 'true' : 'false'}">Log</button>` +
    `</span></div>`;
  const pane = ui.open
    ? `<div data-daemon-log class="mt-2 max-h-72 overflow-y-auto rounded-lg bg-raised p-2 font-mono text-[11px] leading-5 whitespace-pre-wrap break-words">${noteHtml(ui.closed ? CLOSED_NOTE : EMPTY_NOTE)}</div>`
    : '';
  return `<div class="card px-4 py-2.5">${head}${pane}</div>`;
}

export const noteHtml = (text: string): string => `<div data-daemon-note class="text-muted">${esc(text)}</div>`;

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

/** One raw daemon.log line summarised for display. Text is capped; escaping happens in lineHtml. */
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

export function lineHtml(seq: number | string, raw: string): string {
  const v = lineView(raw);
  const tag = v.tone && TONE_CLASS[v.tone]
    ? toneChip(v.tone, v.tag).replace('class="chip ', 'class="chip shrink-0 ')
    : `<span class="chip shrink-0 text-muted">${esc(v.tag)}</span>`;
  return `<div data-seq="${esc(seq)}" class="flex items-start gap-2">${tag}<span class="min-w-0">${esc(v.text)}</span></div>`;
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
