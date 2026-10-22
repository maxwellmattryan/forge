// One session log's data: the latest history page, then /api/events?session=<scope> for live lines,
// merged by offset, with older pages on demand. DOM-free so node:test can drive it with a fake
// EventSource and fetch. A hidden document, a closed drawer or an unshown tab never holds one of the
// server's few SSE slots.
import { MAX_ENTRIES, mergeEntry } from './session-log.ts';
import type { Entry } from './session-parse.ts';
import type { DaemonLogPage } from './types.ts';

/** localStorage key for whether the Daemon popover's Inbox session log is on (statusbar/DaemonPanel.svelte reads and writes it). */
export const LOG_KEY = 'forge.daemonLog';
export const CLOSED_NOTE = 'Log stream closed. Reopen the tab to retry.';
/** EventSource.CLOSED, as a literal because Node has no EventSource global. */
const CLOSED = 2;

/** The part of EventSource the controller uses. */
export interface LogSource {
  readyState: number;
  addEventListener(type: string, listener: (e: { data?: unknown; lastEventId?: string }) => void): void;
  close(): void;
}

export interface SessionLogOptions {
  /** `_inbox` or a job id. */
  scope: string;
  /** A `state` frame's parsed session state. */
  onState?: (st: unknown) => void;
  /** closed, entries, more, loading or error may have changed. */
  onChange: () => void;
  connect?: (url: string) => LogSource;
  fetchPage?: (scope: string, before?: number) => Promise<DaemonLogPage>;
  visible?: () => boolean;
  /**
   * Other endpoints in place of the session's /api/events and /api/daemons/log: a job's Claude Code transcript
   * (the drawer's Agents tab, an interactive owner's Log tab). `headers` go with each page fetch.
   */
  urls?: SessionLogUrls;
}

export interface SessionLogUrls {
  events: string;
  page: (before?: number) => string;
  headers?: Record<string, string>;
}

export interface SessionLog {
  readonly closed: boolean;
  readonly entries: readonly Entry[];
  readonly more: boolean;
  readonly note: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  sync(shown: boolean): void;
  loadOlder(): Promise<void>;
  visibilityChanged(): void;
  dispose(): void;
}

export const eventsUrl = (scope: string): string => `/api/events?session=${encodeURIComponent(scope)}`;

async function defaultFetchPage(scope: string, before?: number): Promise<DaemonLogPage> {
  const q = `session=${encodeURIComponent(scope)}${before === undefined ? '' : `&before=${before}`}`;
  return fetchPage(`/api/daemons/log?${q}`);
}

/** A log page from `url`; the transcript pages share DaemonLogPage's lines, start, end and more. */
async function fetchPage(url: string, headers?: Record<string, string>): Promise<DaemonLogPage> {
  const res = await fetch(url, headers ? { headers } : undefined);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : null;
    throw new Error(typeof e === 'string' ? e : text || res.statusText);
  }
  return body as DaemonLogPage;
}

const toEntry = (l: { offset: unknown; line: unknown }): Entry => ({ offset: Number(l.offset), line: String(l.line) });

export function createSessionLog({ scope, onState, onChange, connect, fetchPage: customPage, visible, urls }: SessionLogOptions): SessionLog {
  // Defaults resolve on use, so importing this module touches no DOM.
  const isVisible = (): boolean => {
    if (visible) return visible();
    try {
      return document.visibilityState !== 'hidden';
    } catch {
      return true;
    }
  };
  const dial = connect ?? ((u: string): LogSource => new EventSource(u));
  const page = customPage ?? (urls ? (_scope: string, before?: number) => fetchPage(urls.page(before), urls.headers) : defaultFetchPage);
  const streamUrl = urls ? urls.events : eventsUrl(scope);

  let closed = false;
  let shown = false;
  let buf: Entry[] = [];
  let more = false;
  /** `before` for the next older page. */
  let cursor: number | null = null;
  let loading = false;
  let olderLoading = false;
  let error: string | null = null;
  let es: LogSource | null = null;
  let started = false;
  /** Bumped whenever the stream is torn down, so a fetch that resolves late is dropped. */
  let gen = 0;

  /** Drops the oldest lines past MAX_ENTRIES; they stay reachable through Load older. */
  const cap = () => {
    const drop = buf.length - MAX_ENTRIES;
    if (drop > 0) {
      buf.splice(0, drop);
      more = true;
      cursor = buf[0].offset;
    }
  };

  /**
   * Takes in the latest page. On a fresh start, a reset log (the page ends before our newest line)
   * or a gap (it starts after it), the page replaces the buffer; otherwise it fills in by offset.
   */
  function absorb(p: DaemonLogPage, fresh: boolean): void {
    const lines = Array.isArray(p.lines) ? p.lines.map(toEntry) : [];
    const last = buf.length ? buf[buf.length - 1].offset : null;
    // A page that shares an offset with the buffer is the same file, just not flushed as far as
    // our newest live line; only a page that ends before that with no overlap means a reset.
    const held = new Set(buf.map((e) => e.offset));
    const reset = last !== null && Number(p.end) < last && !lines.some((l) => held.has(l.offset));
    if (fresh || last === null || reset || Number(p.start) > last) {
      buf = [];
      more = Boolean(p.more);
      cursor = Number.isFinite(p.start) ? p.start : null;
    }
    for (const l of lines) mergeEntry(buf, l);
    cap();
  }

  function connectStream(myGen: number): void {
    if (es || myGen !== gen) return;
    const src = dial(streamUrl);
    es = src;
    let opens = 0;
    src.addEventListener('open', () => {
      // A browser reconnect resumes with Last-Event-ID; refetch as well, in case the server's
      // ring didn't cover the gap or the log was reset.
      if (opens++ === 0 || es !== src) return;
      page(scope)
        .then((p) => {
          if (es !== src || myGen !== gen) return;
          absorb(p, false);
          onChange();
        })
        .catch(() => {});
    });
    src.addEventListener('line', (e) => {
      if (es !== src) return;
      if (mergeEntry(buf, { offset: Number(e.lastEventId), line: String(e.data) })) {
        cap();
        onChange();
      }
    });
    src.addEventListener('state', (e) => {
      try {
        onState?.(JSON.parse(String(e.data)));
      } catch {}
    });
    src.addEventListener('error', () => {
      // CONNECTING (0) is the browser's own reconnect; only a close is final.
      if (src.readyState !== CLOSED || es !== src) return;
      es = null;
      closed = true;
      onChange();
    });
  }

  function start(): void {
    if (started) return;
    started = true;
    error = null;
    loading = true;
    const myGen = gen;
    onChange();
    page(scope)
      .then((p) => {
        if (myGen !== gen) return;
        absorb(p, true);
        loading = false;
        connectStream(myGen);
        onChange();
      })
      .catch((e: unknown) => {
        if (myGen !== gen) return;
        loading = false;
        error = e instanceof Error ? e.message : String(e);
        onChange();
      });
  }

  function stop(): void {
    const had = started || es !== null;
    gen++;
    started = false;
    loading = false;
    es?.close();
    es = null;
    if (had) onChange();
  }

  function sync(isShown: boolean): void {
    shown = isShown;
    const vis = isVisible();
    if (!closed && shown && vis) start();
    else if (!vis || !shown) stop();
  }

  return {
    get closed() {
      return closed;
    },
    get entries() {
      return buf;
    },
    get more() {
      return more;
    },
    get note() {
      return closed ? CLOSED_NOTE : null;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    sync,
    async loadOlder() {
      if (!more || olderLoading || cursor === null) return;
      olderLoading = true;
      const myGen = gen;
      try {
        const p = await page(scope, cursor);
        if (myGen !== gen) return;
        const first = buf.length ? buf[0].offset : Infinity;
        const older = (Array.isArray(p.lines) ? p.lines.map(toEntry) : []).filter((l) => l.offset < first);
        // The window holds at most MAX_ENTRIES lines; past that the newest are kept.
        const room = Math.max(0, MAX_ENTRIES - buf.length);
        const kept = older.slice(Math.max(0, older.length - room));
        buf = [...kept, ...buf];
        const clipped = kept.length < older.length;
        more = Boolean(p.more) || clipped;
        cursor = clipped ? (buf[0]?.offset ?? null) : p.start;
        onChange();
      } catch (e) {
        if (myGen === gen) {
          error = e instanceof Error ? e.message : String(e);
          onChange();
        }
      } finally {
        olderLoading = false;
      }
    },
    visibilityChanged() {
      if (!isVisible()) stop();
      else if (closed) return;
      else sync(shown);
    },
    dispose() {
      stop();
    },
  };
}
