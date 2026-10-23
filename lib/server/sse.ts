// Server-sent events: the stream head, state, line and text frames, following a file through one
// descriptor, the broadcast to open streams and the keep-alive ping.
import fs from 'node:fs';
import type http from 'node:http';
import { redactDeep } from '#engine/guard/known-secrets.ts';
import type { DaemonSessionState, ForgeTruncatedLine } from '#core/types.ts';
import type { ServerCtx } from './types.ts';

export const MAX_SSE_CLIENTS = 8;
export const SSE_SLOW_CLIENT_BYTES = 1024 * 1024;
export const SSE_MAX_LINE = 64 * 1024;
const SSE_PING_MS = 15_000;
// Streams are recycled (EventSource reconnects with Last-Event-ID), so an idle tab can't hold one
// of the few slots forever.
export const SSE_MAX_AGE_MS = 5 * 60_000;
/** A transcript stream starts with at most this much of the file's end. */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
/** How much of a transcript one poll (or a Last-Event-ID resume) reads at most. */
const TRANSCRIPT_READ_BYTES = 1024 * 1024;
const TRANSCRIPT_POLL_MS = 1000;
/** An environment log frame carries at most this many characters of one line. */
const TEXT_FRAME_MAX = 16384;

/**
 * An event stream's head. Set through setHeader rather than writeHead's object, so getHeader still
 * reads the Content-Type afterwards and the activity log can tell a stream from a request.
 */
export function sseHead(res: http.ServerResponse): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.writeHead(200);
}

/** A session's state as an SSE frame; its permission inputs and errors can quote a known value, so they are redacted like /api/state. */
export function stateFrame(st: DaemonSessionState, known: readonly string[]): string {
  return `event: state\ndata: ${JSON.stringify(redactDeep(st, known))}\n\n`;
}

/**
 * Lines are single-line JSON already; a stray CR would still end an SSE field, so it goes.
 */
export function lineFrame(offset: number, line: string): string {
  let data = line.replace(/\r/g, '');
  const bytes = Buffer.byteLength(data);
  if (bytes > SSE_MAX_LINE) {
    let originalType: string | null = null;
    try {
      originalType = JSON.parse(data)?.type ?? null;
    } catch {}
    data = JSON.stringify({ type: 'forge-truncated', originalType, bytes } satisfies ForgeTruncatedLine);
  }
  return `event: line\nid: ${offset}\ndata: ${data}\n\n`;
}

/**
 * One line of a text log as an SSE frame: the data is a JSON string, so a CR, a `<script>` or text that
 * looks like SSE stays inside one frame and reaches the page as text. Never lineFrame, which assumes JSON lines.
 */
export function textFrame(offset: number | null, line: string): string {
  const text = line.length > TEXT_FRAME_MAX ? `${line.slice(0, TEXT_FRAME_MAX)}…` : line;
  return `${offset === null ? '' : `id: ${offset}\n`}data: ${JSON.stringify(text)}\n\n`;
}

/**
 * Follows a file through one open descriptor: its last ≤64 KiB of complete lines (or what follows
 * Last-Event-ID), then each line appended later, polled every second. `emit` gets each complete line
 * at its offset; `oversize` a line over the read cap, which is skipped. A truncated file starts over.
 * Ends the response on a read error or a slow client. Returns the function that stops the polling.
 */
export function followFd(
  res: http.ServerResponse,
  fd: number,
  initialSize: number,
  lastEventId: string | string[] | undefined,
  emit: (offset: number, line: string) => void,
  oversize: (offset: number, bytes: number) => void,
): () => void {
  const last = Number(lastEventId);
  const resume = lastEventId !== undefined && Number.isSafeInteger(last) && last >= 0 && last < initialSize && initialSize - last <= TRANSCRIPT_READ_BYTES;
  // From Last-Event-ID, the line at that offset is the one the client has: skip it.
  let pos = resume ? last : Math.max(0, initialSize - TRANSCRIPT_TAIL_BYTES);
  let skipPartial = resume || pos > 0;
  if (pos > 0 && !resume) pos -= 1;
  let size = initialSize;
  let closed = false;
  const pump = (): void => {
    if (closed) return;
    try {
      const now = fs.fstatSync(fd).size;
      if (now < size) {
        // Truncated or rewritten: start over.
        pos = 0;
        skipPartial = false;
      }
      size = now;
      while (pos < size) {
        const len = Math.min(size - pos, TRANSCRIPT_READ_BYTES);
        const buf = Buffer.alloc(len);
        const n = fs.readSync(fd, buf, 0, len, pos);
        if (n <= 0) break;
        const chunk = buf.subarray(0, n);
        const lastNl = chunk.lastIndexOf(0x0a);
        if (lastNl === -1) {
          // No complete line yet: wait for it, unless one line is over the read cap.
          if (n < TRANSCRIPT_READ_BYTES) break;
          if (!skipPartial) oversize(pos, n);
          skipPartial = true;
          pos += n;
          continue;
        }
        let at = 0;
        while (at <= lastNl) {
          const nl = chunk.indexOf(0x0a, at);
          if (skipPartial) skipPartial = false;
          else emit(pos + at, chunk.subarray(at, nl).toString('utf8'));
          at = nl + 1;
        }
        pos += lastNl + 1;
        if (res.writableLength > SSE_SLOW_CLIENT_BYTES) return void res.end();
      }
    } catch {
      res.end();
    }
  };
  pump();
  const poll = setInterval(pump, TRANSCRIPT_POLL_MS);
  poll.unref();
  return () => {
    closed = true;
    clearInterval(poll);
  };
}

type SseClient = { write: (s: string) => unknown; end: () => unknown; writableLength: number };

/**
 * Writes a frame to every client (in a Map, only those following `scope`) and ends any whose
 * unsent buffer is over the cap, so one stalled browser tab can't grow the server's memory; it
 * reconnects with Last-Event-ID.
 */
export function broadcast<C extends SseClient>(clients: Set<C> | Map<C, string>, frame: string, capBytes = SSE_SLOW_CLIENT_BYTES, scope?: string): void {
  for (const res of [...clients.keys()]) {
    if (scope !== undefined && clients instanceof Map && clients.get(res) !== scope) continue;
    res.write(frame);
    if (res.writableLength > capBytes) {
      clients.delete(res);
      res.end();
    }
  }
}

export function startPing(ctx: ServerCtx): void {
  if (ctx.ping) return;
  ctx.ping = setInterval(() => broadcast(ctx.clients, ': ping\n\n'), ctx.opts.ssePingMs ?? SSE_PING_MS);
  ctx.ping.unref();
}
