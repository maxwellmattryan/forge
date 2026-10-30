// `forge dash`'s activity log: one timestamped line per session transition, notable request and
// job event, printed in the foreground in human mode only (docs/CLI.md "Output mode").
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { parseEventLines } from '#core/job/store.ts';
import { validJobId } from '#core/job/requests.ts';
import { paint, sanitize, sgr } from '#core/format/ansi.ts';
import type { Paint, Style } from '#core/format/ansi.ts';
import type { SessionEvent } from '#office/session/contract.ts';
import type { DaemonSessionState, JobEvent } from '#core/types.ts';
import type { RequestInfo, RunningServer } from '../server/types.ts';

export type ActivityKind = 'session' | 'http' | 'job';
export type ActivityOpts = { color: boolean; now?: () => Date };

/**
 * How a piece of a line is painted. A `subject` (a session scope or job id) takes a colour of its
 * own, the same on its session and job lines, so one job can be followed down the log.
 */
export type Tone = 'subject' | 'strong' | 'muted' | 'ok' | 'warn' | 'error' | 'info';
/** A piece of a line: untrusted text, sanitised when the line is formatted. */
export type Part = { text: string; tone?: Tone };

/** The longest text one line carries, `…` included: a hostile session or event can't flood the terminal. */
export const MAX_TEXT = 300;
/** How much of one events.jsonl a tick reads at most. */
const READ_CAP = 1024 * 1024;

const two = (n: number) => String(n).padStart(2, '0');

/** The inbox and office keep blue and magenta; jobs share the rest. Red, green and yellow mean error, ok and warn. */
const FIXED_HUES = new Map([['_inbox', '1;34'], ['_office', '1;35']]);
const JOB_HUES = ['1;36', '1;96', '1;94', '1;95'];

const hues = new Map<string, string>();

/**
 * A subject's colour. Jobs take the next one in turn as they first appear, so the few that run at
 * once rarely share one, and a subject keeps its colour for as long as this `forge dash` runs.
 */
function subjectHue(subject: string): string {
  // A subject is `<project>/<scope or job>`: the colour follows the part after the project.
  const own = subject.slice(subject.lastIndexOf('/') + 1);
  const fixed = FIXED_HUES.get(own);
  if (fixed) return fixed;
  let hue = hues.get(own);
  if (!hue) hues.set(own, (hue = JOB_HUES[hues.size % JOB_HUES.length]));
  return hue;
}

function toneStyle(part: Part, p: Paint, on: boolean): Style | undefined {
  switch (part.tone) {
    case 'subject':
      return sgr(on, subjectHue(part.text));
    case 'strong':
      return p.bold;
    case 'muted':
      return p.dim;
    case 'ok':
      return p.green;
    case 'warn':
      return p.yellow;
    case 'error':
      return p.red;
    case 'info':
      return p.cyan;
    default:
      return undefined;
  }
}

/** Sanitises each part and caps their joined text at MAX_TEXT, so the cut never splits a closing code. */
function capParts(parts: Part[]): Part[] {
  const safe = parts.map((part) => ({ ...part, text: sanitize(part.text).replace(/\n/g, ' ') }));
  if (safe.reduce((n, x) => n + x.text.length, 0) <= MAX_TEXT) return safe;
  const out: Part[] = [];
  let left = MAX_TEXT;
  for (const part of safe) {
    const text = part.text;
    if (text.length < left) {
      out.push(part);
      left -= text.length;
      continue;
    }
    let cut = text.slice(0, left - 1);
    // Never leave half a surrogate pair before the ellipsis.
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    out.push({ ...part, text: `${cut}…` });
    break;
  }
  return out;
}

/**
 * `[HH:MM:SS] <kind> <text>`. The text comes from agents, events.jsonl and any local HTTP client, so
 * it is sanitised (controls and bidi overrides made visible, newlines turned into spaces) and capped
 * before it is painted, so only Forge's own codes reach the terminal. `error` paints all of it red.
 */
export function formatActivity(kind: ActivityKind, text: string | Part[], opts: { at: Date; color: boolean; error?: boolean }): string {
  const p = paint(opts.color);
  const at = opts.at;
  const parts = typeof text === 'string' ? [{ text: text || '-' }] : text.length ? text : [{ text: '-' }];
  const body = capParts(parts)
    .map((part) => {
      const style = opts.error ? p.red : toneStyle(part, p, opts.color);
      return style ? style(part.text) : part.text;
    })
    .join('');
  return `[${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}] ${p.bold(kind)} ${body}`;
}

/** The plain text of a line's parts, as a log without colour prints it. */
const plainText = (parts: Part[]): string => parts.map((x) => x.text).join('');

type Line = (kind: ActivityKind, text: string | Part[], error?: boolean) => void;
const liner = (write: (line: string) => void, opts: ActivityOpts): Line => (kind, text, error) =>
  write(formatActivity(kind, text, { at: (opts.now ?? (() => new Date()))(), color: opts.color, error }));

const subject = (text: string): Part => ({ text, tone: 'subject' });
const STATUS_TONE: Record<string, Tone | undefined> = { idle: 'muted', busy: undefined, stopping: 'warn' };

/**
 * The pool emits a state event on every small change, so this keeps each scope's last state and
 * prints only the transitions a person cares about. The first state of a scope is the baseline.
 */
export function sessionTracker(write: (line: string) => void, opts: ActivityOpts): (e: SessionEvent) => void {
  const line = liner(write, opts);
  const last = new Map<string, DaemonSessionState>();
  return (e) => {
    const scope = e.scope;
    const say = (tone: Tone | undefined, ...rest: Part[]) => line('session', [subject(scope), { text: ' ' }, ...rest.map((x) => (x.tone || !tone ? x : { ...x, tone }))]);
    if (e.kind === 'line') {
      let parsed: unknown;
      try {
        parsed = JSON.parse(e.line);
      } catch {
        return;
      }
      const o = parsed as { type?: unknown; text?: unknown } | null;
      if (o && typeof o === 'object' && o.type === 'forge-stderr') say('error', { text: `stderr: ${String(o.text ?? '')}` });
      return;
    }
    const cur = e.state;
    if (!cur || typeof cur !== 'object') return;
    const prev = last.get(scope);
    last.set(scope, cur);
    const spawned = () => say('ok', { text: 'spawned' }, ...(cur.pid != null ? [{ text: ` (pid ${cur.pid})`, tone: 'muted' as const }] : []));
    if (!prev) {
      if (cur.running) spawned();
      return;
    }
    if (!prev.running && cur.running) spawned();
    if (prev.running && !cur.running) say('muted', { text: 'ended' });
    if (prev.running && cur.running && cur.status !== prev.status && ['idle', 'busy', 'stopping'].includes(cur.status)) say(STATUS_TONE[cur.status], { text: cur.status });
    if (cur.held && cur.held !== prev.held) say('warn', { text: `held (${cur.held})` });
    if (cur.waiting && !prev.waiting) say('warn', { text: 'waiting for a slot' });
    if (cur.lastError && cur.lastError !== prev.lastError) say('error', { text: `error: ${cur.lastError}` });
    const n = cur.permissions?.length ?? 0;
    if (n > (prev.permissions?.length ?? 0)) say('warn', { text: `permission prompt waiting (${n})` });
  };
}

const TRANSCRIPT_EVENTS = /^\/jobs\/[^/]+\/transcript\/events$/;
/** A project route's path after `/api/p/<project>`. */
const PROJECT_PATH = /^\/api\/p\/[^/]+(\/.*)$/;

/** A status's tone by its class: 2xx ok, 3xx info, 4xx warn, 5xx error. */
function statusTone(status: unknown): Tone | undefined {
  if (typeof status !== 'number') return 'warn';
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'info';
  if (status >= 200) return 'ok';
  return undefined;
}

/** The http line for a request, or null when it is a quiet success: a static file, the state poll or a stream. */
export function requestLine(r: RequestInfo, opts: { at: Date; color: boolean }): string | null {
  const failed = typeof r.status === 'number' && r.status >= 400;
  if (!failed) {
    const rest = PROJECT_PATH.exec(r.path)?.[1];
    const stream = r.sse || r.path === '/api/projects/events' || rest === '/events' || (rest !== undefined && TRANSCRIPT_EVENTS.test(rest));
    const quiet = r.method === 'GET' && (r.path === '/' || r.path === '/index.html' || r.path.startsWith('/assets/') || r.path === '/forge.png' || r.path === '/api/projects' || r.path === '/api/projects/stats' || rest === '/state');
    if (stream || quiet) return null;
  }
  const ms = Number.isFinite(r.ms) && r.ms >= 0 ? Math.round(r.ms) : 0;
  const tone = statusTone(r.status);
  return formatActivity(
    'http',
    [
      { text: String(r.method), tone: 'strong' },
      { text: ` ${r.path} `, tone: tone === 'error' ? 'error' : undefined },
      { text: String(r.status), tone },
      { text: ` ${ms}ms`, tone: ms >= 1000 ? 'warn' : 'muted' },
    ],
    opts,
  );
}

/** startServer's onRequest for the log; it has to exist before the server does, so it is separate from attachActivityLog. */
export function requestLogger(write: (line: string) => void, opts: ActivityOpts): (r: RequestInfo) => void {
  return (r) => {
    const l = requestLine(r, { at: (opts.now ?? (() => new Date()))(), color: opts.color });
    if (l !== null) write(l);
  };
}

const STATE_TONE = new Map<string, Tone>([['running', 'ok'], ['done', 'ok'], ['waiting', 'warn'], ['blocked', 'warn'], ['failed', 'error'], ['cancelled', 'muted']]);

const side = (s: unknown): Part => {
  if (typeof s === 'string') return { text: s };
  if (s && typeof s === 'object') {
    const o = s as { stage?: unknown; state?: unknown };
    return { text: `${String(o.stage ?? '-')}/${String(o.state ?? '-')}`, tone: STATE_TONE.get(String(o.state)) };
  }
  return { text: '-' };
};

/** A job line's parts (without the timestamp and kind): the job id is its subject. */
export function jobEventParts(id: string, e: JobEvent): Part[] {
  const head = [subject(id), { text: ' ' }];
  if (e.type === 'transition') {
    const from = side(e.from);
    return [...head, { text: from.text, tone: 'muted' }, { text: ' → ', tone: 'muted' }, side(e.to), ...(e.reason ? [{ text: ` (${String(e.reason)})`, tone: 'muted' as const }] : [])];
  }
  if (e.type === 'agent-start') return [...head, { text: String(e.role ?? '-'), tone: 'strong' }, { text: ' started' }];
  if (e.type === 'agent-end') return [...head, { text: String(e.role ?? '-'), tone: 'strong' }, { text: ' ended' }, ...(e.summary ? [{ text: `: ${String(e.summary)}`, tone: 'muted' as const }] : [])];
  return [...head, { text: String(e.type) }];
}

/** The text of a job line (without the timestamp and kind). */
export function jobEventLine(id: string, e: JobEvent): string {
  return plainText(jobEventParts(id, e));
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

/**
 * Follows every loaded project, including ones loaded later: each one's session tracker on its pool and
 * its job tail, with scopes and job ids named `<project>/…`. Returns the detach.
 */
export function attachActivityLog(server: Pick<RunningServer, 'onProject'>, opts: { write?: (line: string) => void; color: boolean; intervalMs?: number; now?: () => Date }): () => void {
  const write = opts.write ?? stdoutWriter;
  // A closed pipe surfaces as an async 'error' on stdout, which would otherwise crash the server.
  const swallow = () => {};
  if (!opts.write) process.stdout.on('error', swallow);
  const line = liner(write, opts);
  const detaches = new Set<() => void>();
  const off = server.onProject(({ name, root, pool }) => {
    const track = sessionTracker(write, opts);
    const named = (e: SessionEvent): SessionEvent => ({ ...e, scope: `${name}/${e.scope}` });
    const unsubscribe = pool.subscribe((e) => {
      try {
        track(named(e));
      } catch {
        // Never let the log break the pool's emit loop.
      }
    });
    // The pool boots its sessions when its project loads, before this runs: seed the baseline from its
    // state now, so a session already running still prints its spawned line.
    try {
      const s = pool.state?.();
      if (s) for (const state of [s.inbox, ...Object.values(s.jobs ?? {})]) if (state?.scope) track(named({ kind: 'state', scope: state.scope, state }));
    } catch {
      // A pool without state only misses the baseline.
    }
    const tail = tailJobEvents(root, { intervalMs: opts.intervalMs, onEvent: (id, e) => line('job', jobEventParts(`${name}/${id}`, e)) });
    const detach = () => {
      unsubscribe();
      tail.stop();
      detaches.delete(detach);
    };
    detaches.add(detach);
    return detach;
  });
  return () => {
    off();
    for (const d of [...detaches]) d();
    if (!opts.write) process.stdout.off('error', swallow);
  };
}
