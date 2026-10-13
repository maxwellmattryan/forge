// @ts-check
// Daemon bar mount: owns the bar element, the /api/events EventSource and the visibility listener.
// The pure half (pill, bar and line HTML, buffer, POST) lives in src/lib/daemon.ts so node:test and
// tsc can check it. Log lines are untrusted session output; that module escapes every value.
import { CLOSED_NOTE, EMPTY_NOTE, appendLine, daemonBar, lineHtml, noteHtml, postDaemon } from './src/lib/daemon.ts';

const LOG_KEY = 'forge.daemonLog';

/** @param {unknown} v @returns {Record<string, any>} */
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? /** @type {Record<string, any>} */ (v) : {});

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
