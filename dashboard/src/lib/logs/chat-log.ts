// One chat's log data: GET /api/chats/<id>/log paged forward from the start, then /api/events?session=_chat-<id> for
// live updates. The engine writes each session line into the chat's log.jsonl before it broadcasts it, so a `line`
// event only says "fetch after the newest n", and that fetch finds the line. DOM-free so node:test can drive it with a
// fake EventSource and fetch. A hidden document or an unshown chat never holds one of the server's few SSE slots.
import { fetchChatLog, type ChatEntry } from '../office/chats.ts';
import { eventsUrl, type LogSource } from './daemon-log.ts';
import { MAX_ENTRIES } from './session-log.ts';
import { isLiveLine } from './station.ts';
import { chatScope } from '../core/types.ts';
import type { ChatLogPage } from '../core/types.ts';

/** EventSource.CLOSED, as a literal because Node has no EventSource global. */
const CLOSED = 2;

export interface ChatLogOptions {
  id: string;
  /** entries, loading, error, closed, trimmed or lastLiveAt may have changed. */
  onChange: () => void;
  /** A `state` frame's parsed session state. */
  onState?: (st: unknown) => void;
  connect?: (url: string) => LogSource;
  /** The page after index `after` (-1 for the start). */
  fetchPage?: (after: number) => Promise<ChatLogPage>;
  visible?: () => boolean;
  /** The clock live entries are stamped with (epoch ms). */
  now?: () => number;
}

export interface ChatLog {
  readonly entries: readonly ChatEntry[];
  /** The first load (or a catch-up after the stream reopens) is running. */
  readonly loading: boolean;
  readonly error: string | null;
  /** The stream closed for good; the session log's closed note shows. */
  readonly closed: boolean;
  /** Entries older than the newest MAX_ENTRIES were dropped: `forge chat show <id>` has them. */
  readonly trimmed: boolean;
  /** When the newest live entry arrived (epoch ms), or null: page loads and a (re)open's replay are never live. */
  readonly lastLiveAt: number | null;
  /** When entry `n` arrived live, or null for backlog. */
  arrivedAt(n: number): number | null;
  /** Fetches the entries after the newest held; one runs at a time, plus one more if asked again during it. */
  refresh(): void;
  sync(shown: boolean): void;
  visibilityChanged(): void;
  dispose(): void;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createChatLog({ id, onChange, onState, connect, fetchPage, visible, now = Date.now }: ChatLogOptions): ChatLog {
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
  const page = fetchPage ?? ((after: number) => fetchChatLog(id, after));

  let buf: ChatEntry[] = [];
  /** The newest `n` ever held; a trim keeps it, so a catch-up never refetches what was dropped. */
  let newest = -1;
  let loading = false;
  let error: string | null = null;
  let closed = false;
  let trimmed = false;
  let shown = false;
  let started = false;
  let disposed = false;
  let es: LogSource | null = null;
  /** Bumped whenever the stream is torn down, so a fetch that resolves late is dropped. */
  let gen = 0;
  let inflight = false;
  let again = false;
  /** When the stream was dialled or last (re)opened: entries within SETTLE_MS of it are replayed backlog. */
  let openedAt: number | null = null;
  let lastLiveAt: number | null = null;
  const arrivals = new Map<number, number>();

  /** Appends the entries newer than the newest held, in `n` order, then drops the oldest past MAX_ENTRIES. */
  function absorb(entries: unknown): void {
    const list = Array.isArray(entries) ? (entries as ChatEntry[]) : [];
    const t = now();
    const live = es !== null && isLiveLine(openedAt, t);
    for (const e of list) {
      if (!e || !Number.isInteger(e.n) || e.n <= newest) continue;
      buf.push(e);
      newest = e.n;
      if (live) {
        lastLiveAt = t;
        arrivals.set(e.n, t);
      }
    }
    const drop = buf.length - MAX_ENTRIES;
    if (drop > 0) {
      buf = buf.slice(drop);
      trimmed = true;
      const first = buf[0]!.n;
      for (const n of arrivals.keys()) if (n < first) arrivals.delete(n);
    }
  }

  /** Pages forward from the newest `n` while the server has more or a refresh was asked for meanwhile. */
  async function pump(myGen: number): Promise<boolean> {
    inflight = true;
    try {
      for (;;) {
        again = false;
        const p = await page(newest);
        if (myGen !== gen) return false;
        absorb(p?.entries);
        error = null;
        onChange();
        const more = Boolean(p?.more) && Array.isArray(p?.entries) && p.entries.length > 0;
        if (!more && !again) return true;
      }
    } catch (e) {
      if (myGen === gen) {
        error = message(e);
        onChange();
      }
      return false;
    } finally {
      if (myGen === gen) inflight = false;
    }
  }

  function refresh(): void {
    if (disposed) return;
    // Stopped after a failed load: a refresh (a send, a retry) starts it again while it is shown.
    if (!started) {
      if (shown && !closed && isVisible()) start();
      return;
    }
    if (inflight) {
      again = true;
      return;
    }
    void pump(gen);
  }

  function connectStream(myGen: number): void {
    if (es || myGen !== gen) return;
    const src = dial(eventsUrl(chatScope(id)));
    es = src;
    openedAt = now();
    let opens = 0;
    src.addEventListener('open', () => {
      if (es !== src) return;
      openedAt = now();
      // A browser reconnect may have missed lines: catch up from the newest n.
      if (opens++ > 0) refresh();
    });
    src.addEventListener('line', () => {
      if (es === src) refresh();
    });
    src.addEventListener('state', (e) => {
      if (es !== src) return;
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

  /** The first load, or a catch-up from the newest n after a stop; then the stream. A failure leaves it stopped. */
  function start(): void {
    if (started) return;
    started = true;
    loading = true;
    const myGen = gen;
    onChange();
    void pump(myGen).then((ok) => {
      if (myGen !== gen) return;
      loading = false;
      if (ok) connectStream(myGen);
      else started = false;
      onChange();
    });
  }

  function stop(): void {
    const had = started || es !== null;
    gen++;
    started = false;
    loading = false;
    inflight = false;
    again = false;
    es?.close();
    es = null;
    openedAt = null;
    lastLiveAt = null;
    arrivals.clear();
    if (had) onChange();
  }

  function sync(isShown: boolean): void {
    if (disposed) return;
    shown = isShown;
    if (!closed && shown && isVisible()) start();
    else if (!shown || !isVisible()) stop();
  }

  return {
    get entries() {
      return buf;
    },
    get loading() {
      return loading;
    },
    get error() {
      return error;
    },
    get closed() {
      return closed;
    },
    get trimmed() {
      return trimmed;
    },
    get lastLiveAt() {
      return lastLiveAt;
    },
    arrivedAt: (n: number): number | null => arrivals.get(n) ?? null,
    refresh,
    sync,
    visibilityChanged() {
      if (disposed) return;
      if (!isVisible()) stop();
      else if (!closed) sync(shown);
    },
    dispose() {
      stop();
      disposed = true;
    },
  };
}
