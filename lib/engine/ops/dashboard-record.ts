// The running dashboard's record (`.forge/runtime/dashboard.json`), proven before anyone signals its
// pid or shows its URL.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { pidAlive, processStartMs, run, START_SLACK_MS } from '#core/os/process.ts';

/** A proven record: `url` is the loopback origin, with no trailing slash. */
export interface DashboardRecord {
  pid: number;
  url: string;
  startedAt: string;
}

/** What provenDashboard asks of the OS: `systemProbe` in production, a plain object in tests. */
export interface DashboardProbe {
  platform: NodeJS.Platform;
  alive(pid: number): boolean;
  /** When the process started, in ms; null when it can't be read. */
  startMs(pid: number): number | null;
  /** The process's command line; null when it can't be read. */
  command(pid: number): string | null;
}

const RECORD_MAX_BYTES = 4096;
const PROBE_TIMEOUT_MS = 5000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export const systemProbe: DashboardProbe = {
  platform: process.platform,
  alive: pidAlive,
  startMs: processStartMs,
  command(pid) {
    if (process.platform === 'win32') return null;
    // -ww: never cut the line to a terminal or COLUMNS width, which could drop the `dash` word.
    const ps = run('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { allowFail: true, env: { ...process.env, LC_ALL: 'C' }, timeoutMs: PROBE_TIMEOUT_MS });
    return ps.ok ? ps.stdout.trim() : null;
  },
};

export function dashboardRecordFile(root: string): string {
  return path.join(paths(root).runtime, 'dashboard.json');
}

/**
 * The record as a plain object, or null for anything but a regular file of at most 4 KiB holding a
 * JSON object. The runtime dir is writable by sessions, so a symlink is never followed and a FIFO
 * never blocks the read.
 */
export function readDashboardRecord(root: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dashboardRecordFile(root), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > RECORD_MAX_BYTES) return null;
    const buf = Buffer.alloc(RECORD_MAX_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > RECORD_MAX_BYTES) return null;
    const value: unknown = JSON.parse(buf.subarray(0, n).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * The origin of an http loopback URL with an explicit port and nothing else (no userinfo, path,
 * query or hash), else null. The parsed hostname is compared, never a prefix of the string, so
 * `http://127.0.0.1:7400@evil.example/` and `http://localhost.evil.example:7400` are refused.
 */
export function loopbackOrigin(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' || !LOOPBACK.has(u.hostname) || !u.port) return null;
  // Equal only when userinfo, path, query and hash are all absent (even an empty `?` or `#`).
  return u.href === `${u.origin}/` ? u.origin : null;
}

/**
 * Whether the command line runs `forge dash`: a word whose basename is `forge`, then `dash`. That
 * covers `node …/bin/forge dash`, the --background child and npm run dev's `bin/forge dash --dev`.
 */
function isForgeDash(command: string): boolean {
  const words = command.trim().split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    if (path.posix.basename(words[i].replace(/\\/g, '/')) === 'forge' && words[i + 1] === 'dash') return true;
  }
  return false;
}

/**
 * The dashboard record, only when it is proven to name the `forge dash` process serving this repo:
 * a readable record, a live pid that is not 1 or ours, a process start within START_SLACK_MS of
 * `startedAt` (so a reused pid fails), a `forge dash` command line (start times are public, so a
 * forged `startedAt` alone could name any process), and a loopback url. Anything else is stale:
 * never signalled, its url never shown. Always null on Windows, which has no start-time probe.
 */
export function provenDashboard(root: string, probe: DashboardProbe = systemProbe): DashboardRecord | null {
  if (probe.platform === 'win32') return null;
  const rec = readDashboardRecord(root);
  if (!rec) return null;
  const { pid, startedAt } = rec;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  const url = loopbackOrigin(rec.url);
  if (!url) return null;
  const recorded = typeof startedAt === 'string' ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(recorded)) return null;
  if (!probe.alive(pid)) return null;
  const started = probe.startMs(pid);
  if (started === null || Math.abs(started - recorded) > START_SLACK_MS) return null;
  const command = probe.command(pid);
  if (command === null || !isForgeDash(command)) return null;
  return { pid, url, startedAt: startedAt as string };
}
