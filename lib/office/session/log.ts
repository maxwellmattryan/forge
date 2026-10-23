// A session's log: `<scope>.log` on disk, the replay ring the dashboard reads, and the byte-capped
// splitting and stamping of the child's output lines.
import fs from 'node:fs';
import { redactKnown } from '#engine/guard/known-secrets.ts';
import { now } from '#core/utils.ts';
import type { DaemonChild, LogSink, SessionCore } from './contract.ts';

const RING_SIZE = 200;
/** Lines kept in memory for replay are capped like SSE frames; the session log keeps them verbatim. */
const RING_LINE_BYTES = 64 * 1024;
export const STDERR_CAP = 4096;

/** A session's log and replay ring. Offsets keep growing across rotations: logBase plus the byte position in `<scope>.log`. */
export function createSessionLog(core: SessionCore) {
  const { root, scope, ctx, o, files: f } = core;
  let sink: LogSink | null = null;
  /** Offset of the next line: logBase plus its byte position in <scope>.log. */
  let pos = core.info.logBase;
  /** retention.logMaxBytes as of the last spawn: rotate mid-session at this size. null rotates only at spawn. */
  let rotateAt: number | null = null;
  /** Resumes stdout paused on a full sink; a rotation ends that sink, which then never drains. */
  let resumeStdout: (() => void) | null = null;
  const ring: { offset: number; line: string }[] = [];

  function logSink(): LogSink {
    if (!sink) {
      if (!fs.existsSync(root)) return { write: () => true };
      fs.mkdirSync(f.dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(f.log).size;
      } catch {}
      pos = core.info.logBase + size;
      try {
        sink = o.openLog(f.log);
      } catch {
        // A symlink or non-file planted as the log: keep supervising, just without the file.
        sink = { write: () => true };
      }
      sink.on?.('error', () => {});
    }
    return sink;
  }

  /** Appends one line to the session log and the replay ring; returns the sink's write() result. */
  function logLine(raw: string): boolean {
    // Before the offset is taken: the ring, the SSE frame and the file all carry the same redacted bytes.
    let line = raw;
    try {
      line = redactKnown(raw, o.redactor(root, scope, ctx.config()));
    } catch {}
    const s = logSink();
    const offset = pos;
    const ok = s.write(line + '\n');
    pos += Buffer.byteLength(line) + 1;
    ring.push({ offset, line: capLine(line) });
    if (ring.length > RING_SIZE) ring.shift();
    ctx.emit({ kind: 'line', scope, offset, line });
    // The ended sink flushes what it holds, so the caller has nothing to wait for.
    if (rotateAt !== null && pos - core.info.logBase >= rotateAt && rotate(rotateAt)) return true;
    return ok;
  }

  const logEvent = (event: string, extra: Record<string, unknown> = {}) => void logLine(JSON.stringify({ type: 'forge-daemon', at: now(), event, ...extra }));

  /**
   * Moves <scope>.log over <scope>.log.1 once it holds at least `limit` bytes (one older generation
   * is kept), and advances logBase by its size so offsets keep growing. Returns whether it rotated.
   */
  function rotate(limit: number): boolean {
    let size: number;
    try {
      size = fs.statSync(f.log).size;
    } catch {
      return false;
    }
    // An open sink may still hold writes the file doesn't show yet; offsets must count them. Those
    // writes land in .log.1: the open descriptor follows the renamed file.
    if (sink) size = Math.max(size, pos - core.info.logBase);
    if (size < limit) return false;
    if (sink) {
      sink.end?.();
      sink = null;
    }
    try {
      fs.renameSync(f.log, `${f.log}.1`);
    } catch {
      return false;
    }
    core.info = { ...core.info, logBase: core.info.logBase + size };
    pos = core.info.logBase;
    core.persist();
    if (resumeStdout) {
      const resume = resumeStdout;
      resumeStdout = null;
      resume();
    }
    return true;
  }

  /** At each spawn: takes retention.logMaxBytes as the mid-session limit and rotates a log already past it. */
  function armRotation(max: unknown): void {
    rotateAt = Number.isSafeInteger(max) && (max as number) > 0 ? (max as number) : null;
    // Without a limit, today's rule: past rotateBytes, and only here.
    rotate(rotateAt ?? o.rotateBytes + 1);
  }

  /** The sink is full: the child's stdout waits until it drains. */
  function backpressure(proc: DaemonChild): void {
    if (proc.stdout && !proc.stdout.isPaused()) {
      proc.stdout.pause();
      // write() returned false, so the sink is a real stream (the stand-in never does), and stdout was
      // checked just above, where the callback can't see the narrowing.
      const resume = () => {
        if (resumeStdout === resume) resumeStdout = null;
        proc.stdout!.resume();
      };
      resumeStdout = resume;
      logSink().once!('drain', resume);
    }
  }

  /** Buffered lines after `afterOffset`; all of them when it is missing or ahead of us (a restarted server). */
  function recent(afterOffset?: number): { offset: number; line: string }[] {
    const last = ring.length ? ring[ring.length - 1].offset : -1;
    if (afterOffset === undefined || !Number.isFinite(afterOffset) || afterOffset > last) return ring.slice();
    return ring.filter((r) => r.offset > afterOffset);
  }

  /** Ends the sink, once whatever it holds is flushed. */
  async function close(): Promise<void> {
    if (sink) {
      const s = sink;
      sink = null;
      await new Promise((resolve) => {
        if (typeof s.end !== 'function') return resolve(undefined);
        s.end(() => resolve(undefined));
      });
    }
  }

  return { logLine, logEvent, rotate, armRotation, backpressure, recent, close };
}

/**
 * claude stamps only its assistant and user lines (`timestamp`); its system, result and
 * progress events carry no time at all. Those get the receipt time as `at`, the key the
 * supervisor's own events use, so the dashboard can show a time on every line. A line that
 * already has either key is logged verbatim.
 */
export function stamped(ev: any, line: string): string {
  if (Array.isArray(ev) || typeof ev.timestamp === 'string' || typeof ev.at === 'string') return line;
  return JSON.stringify({ ...ev, at: now() });
}

function capLine(line: string): string {
  const bytes = Buffer.byteLength(line);
  if (bytes <= RING_LINE_BYTES) return line;
  let originalType: unknown = null;
  try {
    originalType = JSON.parse(line)?.type ?? null;
  } catch {}
  return JSON.stringify({ type: 'forge-truncated', originalType, bytes });
}

/**
 * Byte-capped line splitter, so one runaway line can't grow memory without bound. A line longer
 * than `max` is dropped up to its newline and reported through `onTooLong`; with no
 * `onTooLong` its first `max` bytes are kept instead.
 */
export function splitter(max: number, onLine: (line: string) => void, onTooLong: ((bytes: number) => void) | null): (data: Buffer | string) => void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  let dropped = 0;
  return (data: Buffer | string) => {
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (dropping) dropped += piece.length;
      else if (size + piece.length > max) {
        dropping = true;
        dropped = size + piece.length;
        if (onTooLong) parts = [];
        else parts.push(piece.subarray(0, max - size));
        size = 0;
      } else if (piece.length) {
        parts.push(piece);
        size += piece.length;
      }
      if (nl === -1) break;
      if (dropping && onTooLong) onTooLong(dropped);
      else {
        const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
        if (line.trim()) onLine(line);
      }
      parts = [];
      size = 0;
      dropping = false;
      dropped = 0;
      start = nl + 1;
    }
  };
}
