// A session's log: `<scope>.log` on disk, the replay ring the dashboard reads, and the byte-capped
// splitting and stamping of the child's output lines.
import { now } from '#core/utils.ts';

export const RING_SIZE = 200;
/** Lines kept in memory for replay are capped like SSE frames; the session log keeps them verbatim. */
const RING_LINE_BYTES = 64 * 1024;
export const STDERR_CAP = 4096;

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

export function capLine(line: string): string {
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
