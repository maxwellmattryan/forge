// The daemon log pane's /api/events stream, ported one-to-one from the old daemon.js mount so node:test can drive it
// with a fake EventSource. A hidden tab or a collapsed pane never holds one of the server's few SSE slots.
import { CLOSED_NOTE, EMPTY_NOTE, appendLine } from './daemon.ts';
import type { LogEntry } from './daemon.ts';

export const LOG_KEY = 'forge.daemonLog';
/** EventSource.CLOSED, as a literal because Node has no EventSource global. */
const CLOSED = 2;

/** The part of EventSource the controller uses. */
export interface LogSource {
  readyState: number;
  addEventListener(type: string, listener: (e: { data?: unknown; lastEventId?: string }) => void): void;
  close(): void;
}

type LogStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface DaemonLogOptions {
  /** A `state` frame's parsed daemon state. */
  onState: (st: unknown) => void;
  /** open, closed, lines or note may have changed. */
  onChange: () => void;
  connect?: (url: string) => LogSource;
  visible?: () => boolean;
  storage?: LogStorage | null;
}

export interface DaemonLog {
  readonly open: boolean;
  readonly closed: boolean;
  readonly lines: readonly LogEntry[];
  readonly note: string | null;
  toggle(): void;
  sync(shown: boolean): void;
  visibilityChanged(): void;
  dispose(): void;
}

export function createDaemonLog({ onState, onChange, connect, visible, storage }: DaemonLogOptions): DaemonLog {
  // Defaults resolve on use, so importing this module touches no DOM.
  const store = (): LogStorage | null => {
    if (storage !== undefined) return storage;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  };
  const isVisible = (): boolean => {
    if (visible) return visible();
    try {
      return document.visibilityState !== 'hidden';
    } catch {
      return true;
    }
  };
  const dial = connect ?? ((u: string): LogSource => new EventSource(u));

  let open = false;
  try {
    open = store()?.getItem(LOG_KEY) === '1';
  } catch {}
  let closed = false;
  let shown = false;
  let buf: LogEntry[] = [];
  let es: LogSource | null = null;

  function openStream(): void {
    if (es) return;
    buf = [];
    closed = false;
    const src = dial('/api/events');
    es = src;
    src.addEventListener('line', (e) => {
      if (appendLine(buf, { seq: Number(e.lastEventId), line: String(e.data) }).added) onChange();
    });
    src.addEventListener('state', (e) => {
      try {
        onState(JSON.parse(String(e.data)));
      } catch {}
    });
    src.addEventListener('error', () => {
      // CONNECTING (0) is the browser's own reconnect, which resumes with Last-Event-ID; only a close is final.
      if (src.readyState !== CLOSED || es !== src) return;
      es = null;
      closed = true;
      onChange();
    });
    onChange();
  }

  function closeStream(): void {
    const had = es !== null || buf.length > 0;
    es?.close();
    es = null;
    buf = [];
    if (had) onChange();
  }

  function sync(isShown: boolean): void {
    shown = isShown;
    const vis = isVisible();
    if (open && !closed && shown && vis) openStream();
    else if (!open || !vis || !shown) closeStream();
  }

  return {
    get open() {
      return open;
    },
    get closed() {
      return closed;
    },
    get lines() {
      return buf;
    },
    get note() {
      return closed ? CLOSED_NOTE : buf.length ? null : EMPTY_NOTE;
    },
    toggle() {
      open = !open;
      closed = false;
      try {
        store()?.setItem(LOG_KEY, open ? '1' : '0');
      } catch {}
      if (!open) closeStream();
      onChange();
      sync(shown);
    },
    sync,
    visibilityChanged() {
      if (!isVisible()) closeStream();
      else if (closed) return;
      else sync(shown);
    },
    dispose() {
      closeStream();
    },
  };
}
