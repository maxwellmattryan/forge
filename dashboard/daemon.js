// @ts-check
// Daemon bar: status pill, Start/Stop, and a live log pane fed by /api/events. Everything above
// mountDaemon is pure and DOM-free, so node:test can import it. Log lines are session output,
// i.e. untrusted text, so every value is escaped before it reaches the DOM.
import { esc, ago, TONE_CLASS, toneChip } from './util.js';

export const MAX_LINES = 500;
export const MAX_TEXT = 400;
const LOG_KEY = 'forge.daemonLog';
const START_HINT = 'Set daemon.enabled: true in .forge/config.yml';
const EMPTY_NOTE = 'No daemon output yet.';
const CLOSED_NOTE = 'Log stream closed. Reopen the log to retry.';
const DAEMON_KEYS = ['message', 'pid', 'sessionId', 'requests', 'jobs', 'code', 'signal', 'reason', 'bytes'];

/** @param {unknown} v @returns {Record<string, any>} */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {});
/** @param {unknown} v */
const str = (v) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));
/** @param {string} s */
const cap = (s) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/**
 * The pill for /api/state's `daemon`, or null when the bar is hidden.
 * @param {any} daemon @returns {{label:string, tone:string, title:string}|null}
 */
export function pillModel(daemon) {
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
 * @param {any} daemon @param {{open:boolean, pending:boolean, closed?:boolean}} ui
 */
export function daemonBar(daemon, ui) {
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

/** @param {string} text */
const noteHtml = (text) => `<div data-daemon-note class="text-muted">${esc(text)}</div>`;

/** @param {Record<string, any>} ev */
function daemonText(ev) {
  const parts = [str(ev.event)];
  for (const k of DAEMON_KEYS) if (ev[k] != null) parts.push(`${k}=${str(ev[k])}`);
  return parts.join(' ');
}

/** @param {Record<string, any>} ev */
function assistantText(ev) {
  const blocks = Array.isArray(obj(ev.message).content) ? obj(ev.message).content : [];
  const parts = [];
  for (const b of blocks.map(obj)) {
    if (b.type === 'text') parts.push(str(b.text));
    else if (b.type === 'tool_use') parts.push(`→ ${str(b.name)}${obj(b.input).subagent_type ? ` ${str(obj(b.input).subagent_type)}` : ''}`);
    else if (b.type === 'thinking') parts.push('(thinking)');
  }
  return parts.length ? parts.join(' · ') : '(empty)';
}

/** @param {Record<string, any>} ev */
function toolText(ev) {
  const blocks = Array.isArray(obj(ev.message).content) ? obj(ev.message).content : [];
  const parts = blocks.map(obj).filter((b) => b.type === 'tool_result').map((b) => (b.is_error ? 'result (error)' : 'result'));
  return parts.length ? parts.join(' · ') : '(empty)';
}

/**
 * One raw daemon.log line summarised for display. Text is capped; escaping happens in lineHtml.
 * @param {string} raw @returns {{tone:string|null, tag:string, text:string}}
 */
export function lineView(raw) {
  const line = String(raw ?? '');
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { tone: 'muted', tag: 'raw', text: cap(line) };
  const ev = /** @type {Record<string, any>} */ (parsed);
  /** @type {[string|null, string, string]} */
  let v;
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

/** @param {number|string} seq @param {string} raw */
export function lineHtml(seq, raw) {
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
 * @param {{seq:number, line:string}[]} buf @param {{seq:number, line:string}} entry @param {number} [max]
 * @returns {{buf:{seq:number, line:string}[], added:boolean, reset:boolean, dropped:number}}
 */
export function appendLine(buf, entry, max = MAX_LINES) {
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
 * @param {'start'|'stop'} action @param {string} token @param {typeof fetch} [fetchImpl]
 */
export async function postDaemon(action, token, fetchImpl = fetch) {
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

/**
 * The only DOM code: owns the bar, the EventSource and the visibility listener.
 * @param {HTMLElement} el @param {{token:string, toast:(msg:string, bad?:boolean)=>void, refresh:()=>any}} opts
 */
export function mountDaemon(el, { token, toast, refresh }) {
  /** @type {any} */
  let daemon = null;
  const ui = { open: readOpen(), pending: false, closed: false };
  /** @type {{seq:number, line:string}[]} */
  let buf = [];
  /** @type {EventSource|null} */
  let es = null;
  let html = '';

  const paneEl = () => /** @type {HTMLElement|null} */ (el.querySelector('[data-daemon-log]'));

  function render() {
    const next = daemonBar(daemon, ui);
    if (next === html) return;
    html = next;
    const head = el.querySelector('[data-daemon-head]');
    const pane = paneEl();
    // Swap only the header while the pane is up, so its lines and scroll position survive a refresh.
    if (ui.open && head && pane && next) {
      const tpl = document.createElement('template');
      tpl.innerHTML = next;
      const fresh = tpl.content.querySelector('[data-daemon-head]');
      if (fresh) head.replaceWith(fresh);
    } else {
      el.innerHTML = next;
      fillPane();
    }
    sync();
  }

  function fillPane() {
    const pane = paneEl();
    if (!pane || !buf.length) return;
    pane.innerHTML = buf.map((e) => lineHtml(e.seq, e.line)).join('') + (ui.closed ? noteHtml(CLOSED_NOTE) : '');
    pane.scrollTop = pane.scrollHeight;
  }

  /** @param {number} seq @param {string} line */
  function onLine(seq, line) {
    const r = appendLine(buf, { seq, line });
    if (!r.added) return;
    const pane = paneEl();
    if (!pane) return;
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 24;
    if (r.reset) pane.innerHTML = '';
    pane.querySelectorAll('[data-daemon-note]').forEach((n) => n.remove());
    for (let i = 0; i < r.dropped; i++) pane.firstElementChild?.remove();
    // lineHtml escapes every value, so its output is safe markup.
    pane.insertAdjacentHTML('beforeend', lineHtml(seq, line));
    if (atBottom) pane.scrollTop = pane.scrollHeight;
  }

  function openStream() {
    if (es) return;
    buf = [];
    ui.closed = false;
    const pane = paneEl();
    if (pane) pane.innerHTML = noteHtml(EMPTY_NOTE);
    const src = new EventSource('/api/events');
    es = src;
    src.addEventListener('line', (e) => onLine(Number(/** @type {MessageEvent} */ (e).lastEventId), String(/** @type {MessageEvent} */ (e).data)));
    src.addEventListener('state', (e) => {
      try {
        setState(JSON.parse(/** @type {MessageEvent} */ (e).data));
      } catch {}
    });
    src.addEventListener('error', () => {
      if (src.readyState !== EventSource.CLOSED || es !== src) return;
      es = null;
      ui.closed = true;
      const p = paneEl();
      if (p) {
        p.querySelectorAll('[data-daemon-note]').forEach((n) => n.remove());
        p.insertAdjacentHTML('beforeend', noteHtml(CLOSED_NOTE));
      }
    });
  }

  function closeStream() {
    es?.close();
    es = null;
    buf = [];
  }

  // A hidden tab or a collapsed pane never holds one of the server's few SSE slots.
  function sync() {
    const want = ui.open && !ui.closed && Boolean(html) && document.visibilityState !== 'hidden';
    if (want) openStream();
    else if (!ui.open || document.visibilityState === 'hidden' || !html) closeStream();
  }

  /** SSE and POST states carry no config read, so `enabled` comes from the last /api/state. @param {any} st */
  function setState(st) {
    daemon = { ...obj(daemon), ...obj(st), enabled: daemon ? obj(daemon).enabled : obj(st).enabled };
    render();
  }

  el.addEventListener('click', async (e) => {
    const btn = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-daemon]'));
    if (!btn || !el.contains(btn) || /** @type {HTMLButtonElement} */ (btn).disabled) return;
    const action = btn.dataset.daemon;
    if (action === 'log') {
      ui.open = !ui.open;
      ui.closed = false;
      writeOpen(ui.open);
      if (!ui.open) closeStream();
      render();
      return;
    }
    if (action !== 'start' && action !== 'stop') return;
    ui.pending = true;
    render();
    try {
      const st = await postDaemon(action, token);
      ui.pending = false;
      setState(st);
      refresh();
    } catch (err) {
      ui.pending = false;
      render();
      toast(`Daemon ${action} failed: ${/** @type {Error} */ (err).message}`, true);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') closeStream();
    else if (ui.closed) return;
    else sync();
  });

  return {
    /** @param {any} data */
    update(data) {
      daemon = data?.daemon ?? null;
      render();
    },
  };
}

function readOpen() {
  try {
    return localStorage.getItem(LOG_KEY) === '1';
  } catch {
    return false;
  }
}

/** @param {boolean} open */
function writeOpen(open) {
  try {
    localStorage.setItem(LOG_KEY, open ? '1' : '0');
  } catch {}
}
