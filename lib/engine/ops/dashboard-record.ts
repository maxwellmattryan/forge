// The running dashboard's record, proven before anyone signals its pid or shows its URL: the machine
// dashboard's `<FORGE_HOME>/dashboard.json`, or a legacy per-repo `forge dash`'s
// `.forge/runtime/dashboard.json`. Every function takes the record's file path.
import fs from 'node:fs';
import path from 'node:path';
import { machinePaths, paths, PLUGIN_ROOT } from '#core/paths.ts';
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
const FORGE_BIN = path.join(PLUGIN_ROOT, 'bin', 'forge');

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

/** The machine dashboard's record: one per FORGE_HOME, outside every repo and session write root. */
export function machineDashboardFile(home: string): string {
  return machinePaths(home).dashboard;
}

/** An older per-repo `forge dash`'s record, read only to stop or report one still running. */
export function legacyDashboardFile(root: string): string {
  return path.join(paths(root).runtime, 'dashboard.json');
}

/**
 * The record at `file` as a plain object, or null for anything but a regular file of at most 4 KiB
 * holding a JSON object. A legacy record sits in a runtime dir sessions can write, so a symlink is
 * never followed and a FIFO never blocks the read.
 */
export function readDashboardRecord(file: string): Record<string, unknown> | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
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

const wordBasename = (w: string): string => path.posix.basename(w.replace(/\\/g, '/'));

/**
 * Whether the command line has `forge` in the script position, then `dash`: the first word is the
 * forge script (basename `forge`, or this install's `bin/forge`), or it is a node executable
 * (basename `node`/`node.exe`, or Node's own `execPath`) and the forge script is the very next
 * word. That covers a human's `forge dash` (shebang: `node …/bin/forge dash`), the --background
 * child (`<execPath> <PLUGIN_ROOT>/bin/forge dash --foreground …`) and npm run dev's
 * `<execPath> <PLUGIN_ROOT>/bin/forge dash --dev`. A pair anywhere else in the line would let a
 * forged record name an unrelated process such as `claude /forge dash` or the words after a
 * `node -e` script. Forge never puts node options before the script, so none is skipped: such a
 * launch, or one with whitespace in any path but `execPath` and `forgeBin`, fails closed (stale).
 */
export function isForgeDash(command: string, execPath: string = process.execPath, forgeBin: string = FORGE_BIN): boolean {
  const scriptThenDash = (s: string): boolean => {
    if (forgeBin && s.startsWith(forgeBin) && /^\s+dash(\s|$)/.test(s.slice(forgeBin.length))) return true;
    const [w, next] = s.split(/\s+/, 2);
    return next === 'dash' && wordBasename(w) === 'forge';
  };
  const line = command.trim();
  if (scriptThenDash(line)) return true;
  // execPath first and as a prefix, since it may contain spaces that splitting would break.
  if (execPath && line.startsWith(execPath) && /^\s/.test(line.slice(execPath.length))) return scriptThenDash(line.slice(execPath.length).trimStart());
  const w0 = line.split(/\s+/, 1)[0];
  const node = wordBasename(w0).toLowerCase();
  if (node === 'node' || node === 'node.exe') return scriptThenDash(line.slice(w0.length).trimStart());
  return false;
}

/**
 * The record at `file`, only when it is proven to name a running `forge dash` process:
 * a readable record, a live pid that is not 1 or ours, a process start within START_SLACK_MS of
 * `startedAt` (so a reused pid fails), a command line with `forge` in the script position, then
 * `dash` (isForgeDash: start times are public, so a forged `startedAt` alone could name any
 * process), and a loopback url. Anything else is stale: never signalled, its url never shown.
 * Always null on Windows, which has no start-time probe. The url is not bound to the pid: a record
 * copying the live dashboard's pid and startedAt may name any loopback port.
 */
export function provenDashboard(file: string, probe: DashboardProbe = systemProbe): DashboardRecord | null {
  if (probe.platform === 'win32') return null;
  const rec = readDashboardRecord(file);
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
