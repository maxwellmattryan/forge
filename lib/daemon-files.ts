// The daemon's session records and logs under .forge/runtime/daemons/, opened without following
// links or blocking on a FIFO. A leaf, so the modules that read a session's files (notify,
// transcripts, retention, the server) don't load the supervisor in daemon.ts.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.ts';
import { validScope } from './requests.ts';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A scope's runtime files. The scope is checked first, so no path is ever built from an
 * unvalidated one.
 */
export function sessionFiles(root: string, scope: string): { dir: string; info: string; log: string } {
  if (!validScope(scope)) throw new Error(`invalid daemon scope ${JSON.stringify(String(scope).slice(0, 80))}`);
  const dir = daemonsDir(root);
  return { dir, info: path.join(dir, `${scope}.json`), log: path.join(dir, `${scope}.log`) };
}

export function daemonsDir(root: string): string {
  return path.join(paths(root).runtime, 'daemons');
}

const MAX_RECORD = 64 * 1024;
/** Open flags for runtime files something else may have planted: never follow a link, never block on a FIFO. */
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;

/**
 * A session record, or {} for anything else: a missing, corrupt, oversized or non-regular file
 * (a FIFO or symlink planted in the runtime dir must not hang or redirect the server). Read
 * through one descriptor opened without following links or blocking.
 */
export function readInfo(file: string): any {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_RECORD) return {};
    const v = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Opens a log for appending without following a planted symlink or blocking on a planted FIFO
 * (a write-only open of a FIFO with no reader would wait forever on the server's event loop; with
 * O_NONBLOCK it fails with ENXIO). Anything but a regular file is closed and refused.
 */
export function openAppend(file: string): number {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW | NONBLOCK, 0o644);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** Opens a log for reading without following a planted symlink or blocking on a FIFO; refuses non-files. */
export function openRead(file: string): number {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${file} is not a regular file`);
  } catch (e) {
    fs.closeSync(fd);
    throw e;
  }
  return fd;
}

/** The record is a local file anyone with repo access can edit: logBase must be a sane byte count. */
export function logBaseOf(info: any): number {
  const n = info?.logBase;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/**
 * Every session record `forge dash` may have left: `daemons/<scope>.json` for valid scopes,
 * regular files only (a planted symlink is skipped), sorted by scope.
 */
export function sessionRecords(root: string): { scope: string; info: string; log: string }[] {
  const dir = daemonsDir(root);
  let names: fs.Dirent[] = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return names
    .filter((e) => e.isFile() && e.name.endsWith('.json') && validScope(e.name.slice(0, -5)))
    .map((e) => e.name.slice(0, -5))
    .sort()
    .map((scope) => ({ scope, ...sessionFiles(root, scope) }));
}

/**
 * Reads complete lines of a session log backwards from `before` (an offset; default and
 * maximum: the end of the file), newest last, through an already-open descriptor. A page stops
 * at `maxBytes` of file or `maxLines` lines (always at least one line), a line over `lineCap`
 * bytes comes back as a forge-truncated marker at its real offset, and at most `scanBytes` are
 * read, so a huge file can't make one request expensive.
 */
export function readLogPage(
  fd: number,
  size: number,
  logBase: number,
  opts: { before?: number | null; maxBytes?: number; maxLines?: number; lineCap?: number; scanBytes?: number } = {},
): { lines: { offset: number; line: string }[]; start: number; end: number; more: boolean } {
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const maxLines = opts.maxLines ?? 1000;
  const lineCap = opts.lineCap ?? 64 * 1024;
  let budget = opts.scanBytes ?? 16 * 1024 * 1024;
  let limit = size;
  if (opts.before !== undefined && opts.before !== null) limit = Math.max(0, Math.min(size, opts.before - logBase));
  const CHUNK = 64 * 1024;
  let chunkStart = 0;
  let chunk = Buffer.alloc(0);
  const load = (i: number): boolean => {
    const startAt = Math.max(0, i + 1 - CHUNK);
    const len = i + 1 - startAt;
    if (len > budget) return false;
    budget -= len;
    chunk = Buffer.alloc(len);
    fs.readSync(fd, chunk, 0, len, startAt);
    chunkStart = startAt;
    return true;
  };
  const byteAt = (i: number): number | null => {
    if (i < chunkStart || i >= chunkStart + chunk.length) if (!load(i)) return null;
    return chunk[i - chunkStart];
  };
  /** Position of the last newline at or before i, -1 at the start of the file, null when out of budget. */
  const prevNewline = (i: number): number | null => {
    for (let j = i; j >= 0; j--) {
      const b = byteAt(j);
      if (b === null) return null;
      if (b === 10) return j;
    }
    return -1;
  };
  // A trailing line still being written (no newline yet) is not complete.
  let cursor = 0;
  if (limit > 0) {
    const nl = prevNewline(limit - 1);
    cursor = nl === null ? 0 : nl + 1;
  }
  const end = logBase + cursor;
  const lines: { offset: number; line: string }[] = [];
  let covered = 0;
  while (cursor > 0 && lines.length < maxLines) {
    const nl = cursor >= 2 ? prevNewline(cursor - 2) : -1;
    if (nl === null) break;
    const lineStart = nl + 1;
    const len = cursor - lineStart;
    if (lines.length && covered + len > maxBytes) break;
    const bytes = len - 1;
    let text: string;
    if (bytes > lineCap) {
      const head = Buffer.alloc(Math.min(bytes, 256));
      fs.readSync(fd, head, 0, head.length, lineStart);
      const m = /^\{"type":"([^"\\]{1,64})"/.exec(head.toString('utf8'));
      text = JSON.stringify({ type: 'forge-truncated', originalType: m ? m[1] : null, bytes });
    } else {
      const buf = Buffer.alloc(bytes);
      if (bytes) fs.readSync(fd, buf, 0, bytes, lineStart);
      text = buf.toString('utf8').replace(/\r$/, '');
    }
    if (text.trim()) lines.unshift({ offset: logBase + lineStart, line: text });
    covered += len;
    cursor = lineStart;
  }
  return { lines, start: logBase + cursor, end, more: cursor > 0 && lines.length > 0 };
}

/**
 * The last `n` complete lines behind an open descriptor, raw, and the byte position just after them.
 * Callers open the file themselves (openRead), so a path is never reopened between check and read.
 * `maxBytes` stops a page early (at least one line still comes back); a line over `lineCap` bytes
 * comes back as a forge-truncated marker.
 */
export function tailLines(fd: number, n: number, opts: { maxBytes?: number; lineCap?: number } = {}): { lines: string[]; end: number } {
  const size = fs.fstatSync(fd).size;
  const page = readLogPage(fd, size, 0, { maxLines: n, maxBytes: opts.maxBytes ?? Infinity, lineCap: opts.lineCap ?? Infinity, scanBytes: 256 * 1024 * 1024 });
  return { lines: page.lines.map((l) => l.line), end: page.end };
}
