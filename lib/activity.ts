// `forge dash`'s activity log: one timestamped line per session transition, notable request and
// job event, printed in the foreground in human mode only (docs/CLI.md "Output mode").
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.ts';
import { parseEventLines } from './jobs.ts';
import { validJobId } from './requests.ts';
import { paint } from './commands/render.ts';
import { txt } from './commands/render/kit.ts';
import type { SessionEvent } from './daemon.ts';
import type { RunningServer } from './server.ts';
import type { DaemonSessionState, JobEvent, RequestInfo } from './types.ts';

export type ActivityKind = 'session' | 'http' | 'job';
export type ActivityOpts = { color: boolean; now?: () => Date };

/** The longest text one line carries, `…` included: a hostile session or event can't flood the terminal. */
export const MAX_TEXT = 300;
/** How much of one events.jsonl a tick reads at most. */
const READ_CAP = 1024 * 1024;

const two = (n: number) => String(n).padStart(2, '0');

function cap(s: string): string {
  if (s.length <= MAX_TEXT) return s;
  let cut = s.slice(0, MAX_TEXT - 1);
  // Never leave half a surrogate pair before the ellipsis.
  if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * `[HH:MM:SS] <kind> <text>`. The text comes from agents, events.jsonl and any local HTTP client, so
 * it is sanitised (controls and bidi overrides made visible, newlines turned into spaces) and capped
 * before it is painted, so only Forge's own codes reach the terminal.
 */
export function formatActivity(kind: ActivityKind, text: string, opts: { at: Date; color: boolean; error?: boolean }): string {
  const p = paint(opts.color);
  const at = opts.at;
  const body = cap(txt(text));
  return `[${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}] ${p.bold(kind)} ${opts.error ? p.red(body) : body}`;
}

type Line = (kind: ActivityKind, text: string, error?: boolean) => void;
const liner = (write: (line: string) => void, opts: ActivityOpts): Line => (kind, text, error) =>
  write(formatActivity(kind, text, { at: (opts.now ?? (() => new Date()))(), color: opts.color, error }));

/**
 * The pool emits a state event on every small change, so this keeps each scope's last state and
 * prints only the transitions a person cares about. The first state of a scope is the baseline.
 */
export function sessionTracker(write: (line: string) => void, opts: ActivityOpts): (e: SessionEvent) => void {
  const line = liner(write, opts);
  const last = new Map<string, DaemonSessionState>();
  return (e) => {
    const scope = e.scope;
    if (e.kind === 'line') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.line);
      } catch {
        return;
      }
      const o = parsed as { type?: unknown; text?: unknown } | null;
      if (o && typeof o === 'object' && o.type === 'forge-stderr') line('session', `${scope} stderr: ${String(o.text ?? '')}`, true);
      return;
    }
    const cur = e.state;
    if (!cur || typeof cur !== 'object') return;
    const prev = last.get(scope);
    last.set(scope, cur);
    const spawned = () => line('session', cur.pid != null ? `${scope} spawned (pid ${cur.pid})` : `${scope} spawned`);
    if (!prev) {
      if (cur.running) spawned();
      return;
    }
    if (!prev.running && cur.running) spawned();
    if (prev.running && !cur.running) line('session', `${scope} ended`);
    if (prev.running && cur.running && cur.status !== prev.status && ['idle', 'busy', 'stopping'].includes(cur.status)) line('session', `${scope} ${cur.status}`);
    if (cur.held && cur.held !== prev.held) line('session', `${scope} held (${cur.held})`);
    if (cur.waiting && !prev.waiting) line('session', `${scope} waiting for a slot`);
    if (cur.lastError && cur.lastError !== prev.lastError) line('session', `${scope} error: ${cur.lastError}`, true);
    const n = cur.permissions?.length ?? 0;
    if (n > (prev.permissions?.length ?? 0)) line('session', `${scope} permission prompt waiting (${n})`);
  };
}

const TRANSCRIPT_EVENTS = /^\/api\/jobs\/[^/]+\/transcript\/events$/;

/** The http line for a request, or null when it is a quiet success: a static file, the state poll or a stream. */
export function requestLine(r: RequestInfo, opts: { at: Date; color: boolean }): string | null {
  const failed = typeof r.status === 'number' && r.status >= 400;
  if (!failed) {
    const stream = r.sse || r.path === '/api/events' || TRANSCRIPT_EVENTS.test(r.path);
    const quiet = r.method === 'GET' && (r.path === '/' || r.path === '/index.html' || r.path.startsWith('/assets/') || r.path === '/forge.png' || r.path === '/api/state');
    if (stream || quiet) return null;
  }
  const ms = Number.isFinite(r.ms) && r.ms >= 0 ? Math.round(r.ms) : 0;
  return formatActivity('http', `${r.method} ${r.path} ${r.status} ${ms}ms`, { ...opts, error: failed });
}

/** startServer's onRequest for the log; it has to exist before the server does, so it is separate from attachActivityLog. */
export function requestLogger(write: (line: string) => void, opts: ActivityOpts): (r: RequestInfo) => void {
  return (r) => {
    const l = requestLine(r, { at: (opts.now ?? (() => new Date()))(), color: opts.color });
    if (l !== null) write(l);
  };
}

const side = (s: unknown): string => {
  if (typeof s === 'string') return s;
  if (s && typeof s === 'object') {
    const o = s as { stage?: unknown; state?: unknown };
    return `${String(o.stage ?? '-')}/${String(o.state ?? '-')}`;
  }
  return '-';
};

/** The text of a job line (without the timestamp and kind). */
export function jobEventLine(id: string, e: JobEvent): string {
  if (e.type === 'transition') return `${id} ${side(e.from)} → ${side(e.to)}${e.reason ? ` (${String(e.reason)})` : ''}`;
  if (e.type === 'agent-start') return `${id} ${String(e.role ?? '-')} started`;
  if (e.type === 'agent-end') return `${id} ${String(e.role ?? '-')} ended${e.summary ? `: ${String(e.summary)}` : ''}`;
  return `${id} ${String(e.type)}`;
}

type Tail = { offset: number; pending: Buffer };

/**
 * Polls every job's events.jsonl and reports what is appended while it runs. History is never
 * replayed: files present at start begin at their size, a job that appears later at its first
 * byte, and a file that shrank at its new end. A symlink or any other non-regular file is skipped.
 */
export function tailJobEvents(root: string, opts: { intervalMs?: number; onEvent: (id: string, e: JobEvent) => void }): { stop(): void } {
  const jobsDir = paths(root).jobs;
  const tails = new Map<string, Tail>();
  const files = (): [string, string][] => {
    let names: string[];
    try {
      names = fs.readdirSync(jobsDir);
    } catch {
      return [];
    }
    return names.filter(validJobId).map((id) => [id, path.join(jobsDir, id, 'events.jsonl')]);
  };
  const regularSize = (file: string): number | null => {
    try {
      const st = fs.lstatSync(file);
      return st.isFile() ? st.size : null;
    } catch {
      return null;
    }
  };
  for (const [id, file] of files()) {
    const size = regularSize(file);
    tails.set(id, { offset: size ?? 0, pending: Buffer.alloc(0) });
  }
  const read = (id: string, file: string, t: Tail, size: number) => {
    if (size < t.offset) {
      t.offset = size;
      t.pending = Buffer.alloc(0);
      return;
    }
    if (size === t.offset) return;
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    let chunk: Buffer;
    try {
      if (!fs.fstatSync(fd).isFile()) return;
      const want = Math.min(size - t.offset, READ_CAP);
      chunk = Buffer.alloc(want);
      const n = fs.readSync(fd, chunk, 0, want, t.offset);
      chunk = chunk.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
    t.offset += chunk.length;
    let buf = t.pending.length ? Buffer.concat([t.pending, chunk]) : chunk;
    const nl = buf.lastIndexOf(0x0a);
    if (nl < 0) {
      // A line longer than the read cap is never a real event: drop it rather than grow without bound.
      t.pending = buf.length > READ_CAP ? Buffer.alloc(0) : Buffer.from(buf);
      return;
    }
    t.pending = Buffer.from(buf.subarray(nl + 1));
    buf = buf.subarray(0, nl);
    for (const e of parseEventLines(buf.toString('utf8'))) {
      try {
        opts.onEvent(id, e);
      } catch {
        // A failing printer never stops the tail.
      }
    }
  };
  const tick = () => {
    try {
      const seen = new Set<string>();
      for (const [id, file] of files()) {
        seen.add(id);
        let t = tails.get(id);
        if (!t) tails.set(id, (t = { offset: 0, pending: Buffer.alloc(0) }));
        const size = regularSize(file);
        if (size === null) continue;
        try {
          read(id, file, t, size);
        } catch {
          // An unreadable file is skipped this tick.
        }
      }
      for (const id of tails.keys()) if (!seen.has(id)) tails.delete(id);
    } catch {
      // The log never stops the dashboard.
    }
  };
  const timer = setInterval(tick, opts.intervalMs ?? 1000);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** Writes one line to stdout; an EPIPE or a closed terminal is swallowed. */
export function stdoutWriter(line: string): void {
  try {
    process.stdout.write(`${line}\n`);
  } catch {
    // The log never stops the dashboard.
  }
}

/** Subscribes the session tracker to the pool and starts the job tail; returns the detach. */
export function attachActivityLog(root: string, server: Pick<RunningServer, 'pool'>, opts: { write?: (line: string) => void; color: boolean; intervalMs?: number; now?: () => Date }): () => void {
  const write = opts.write ?? stdoutWriter;
  // A closed pipe surfaces as an async 'error' on stdout, which would otherwise crash the server.
  const swallow = () => {};
  if (!opts.write) process.stdout.on('error', swallow);
  const track = sessionTracker(write, opts);
  const unsubscribe = server.pool.subscribe((e) => {
    try {
      track(e);
    } catch {
      // Never let the log break the pool's emit loop.
    }
  });
  // The pool boots its sessions inside startServer, before the log exists: seed the baseline from its
  // state now, so a session already running still prints its spawned line.
  try {
    const s = server.pool.state?.();
    if (s) for (const state of [s.inbox, s.office, ...Object.values(s.jobs ?? {})]) if (state?.scope) track({ kind: 'state', scope: state.scope, state });
  } catch {
    // A pool without state only misses the baseline.
  }
  const line = liner(write, opts);
  const tail = tailJobEvents(root, { intervalMs: opts.intervalMs, onEvent: (id, e) => line('job', jobEventLine(id, e)) });
  return () => {
    unsubscribe();
    tail.stop();
    if (!opts.write) process.stdout.off('error', swallow);
  };
}
