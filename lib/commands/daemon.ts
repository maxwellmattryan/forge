// `forge daemon status|log`: the terminal's view of the session pool. Both read runtime files only,
// so they work with or without a running `forge dash` and never talk to its server.
import fs from 'node:fs';
import path from 'node:path';
import { openRead, readInfo, readLogPage, sessionAgents, sessionFiles, sessionRecords } from '../daemon.ts';
import { paths } from '../paths.ts';
import { INBOX_SCOPE, validJobId } from '../requests.ts';
import { ForgeError, readJson } from '../util.ts';
import { pidAlive } from '../worktree.ts';

const USAGE = 'usage: forge daemon status | forge daemon log <job>|--inbox [--lines N] [--follow]';
const MAX_LINES = 5000;
const FOLLOW_MS = 250;

export interface DaemonStatusOut {
  dashboard: { pid: number; url: string | null; alive: boolean } | null;
  sessions: {
    scope: string;
    job: string | null;
    pid: number | null;
    alive: boolean;
    sessionId: string | null;
    startedAt: string | null;
    lastTurnAt: string | null;
    logBytes: number;
    /** 'agents' while a fresh running agent of the job this session owns keeps it from slot eviction and idle stop. */
    kept: 'agents' | null;
    /** Roles of the running agents of the job this session owns, sorted. */
    agents: string[];
  }[];
}

/**
 * Session output is untrusted: every C0 and C1 control character (ESC and CSI included) is
 * printed as its \\uXXXX escape, so a log line can't drive the terminal.
 */
export function escapeControls(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export async function daemonCmd(root: string, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<DaemonStatusOut | string | undefined> {
  if (sub === 'status') return status(root);
  if (sub === 'log') return log(root, rest[0], flags);
  throw new ForgeError(USAGE);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function status(root: string): DaemonStatusOut {
  const dash = readJson(path.join(paths(root).runtime, 'dashboard.json'), null);
  const dashboard = dash && Number.isInteger(dash.pid) ? { pid: dash.pid, url: str(dash.url), alive: pidAlive(dash.pid) } : null;
  // _inbox sorts before every job id ('_' > 'Z' in code points, so it is placed first explicitly).
  const records = sessionRecords(root).sort((a, b) => (a.scope === INBOX_SCOPE ? -1 : b.scope === INBOX_SCOPE ? 1 : a.scope < b.scope ? -1 : 1));
  const sessions = records.map((r) => {
    const info = readInfo(r.info);
    const pid = Number.isInteger(info.pid) ? info.pid : null;
    let logBytes = 0;
    try {
      logBytes = fs.statSync(r.log).size;
    } catch {}
    const alive = pid !== null && pidAlive(pid);
    const owned = alive && r.scope !== INBOX_SCOPE ? sessionAgents(root, r.scope, str(info.sessionId)) : null;
    return {
      scope: r.scope,
      job: r.scope === INBOX_SCOPE ? null : r.scope,
      pid,
      alive,
      sessionId: str(info.sessionId),
      startedAt: str(info.startedAt),
      lastTurnAt: str(info.lastTurnAt),
      logBytes,
      kept: owned?.keeps ? ('agents' as const) : null,
      agents: owned?.running ?? [],
    };
  });
  return { dashboard, sessions };
}

async function log(root: string, job: string | undefined, flags: Record<string, any>): Promise<string | undefined> {
  let scope: string;
  if (flags.inbox) scope = INBOX_SCOPE;
  else {
    // Refused before any path is built from it.
    if (!validJobId(job)) throw new ForgeError(job === undefined ? USAGE : `invalid job id ${JSON.stringify(String(job).slice(0, 80))}`);
    scope = job;
  }
  const n = flags.lines === undefined ? 100 : Number(flags.lines);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LINES) throw new ForgeError(`--lines must be an integer from 1 to ${MAX_LINES}`);
  const file = sessionFiles(root, scope).log;
  if (!flags.follow) {
    if (!fs.existsSync(file)) throw new ForgeError(`no session log for ${scope}`);
    return tail(file, n).lines.map(escapeControls).join('\n');
  }
  await follow(file, n);
  return undefined;
}

/** A log opened without following a planted symlink or blocking on a FIFO; anything but a regular file is refused. */
function openLog(file: string): number {
  try {
    return openRead(file);
  } catch (e) {
    throw new ForgeError(`cannot read ${path.basename(file)}: ${(e as NodeJS.ErrnoException).code === 'ELOOP' ? 'it is a symlink' : (e as Error).message}`);
  }
}

/** The last `n` complete lines of a log file, raw, and the byte position just after them. */
function tail(file: string, n: number): { lines: string[]; end: number } {
  const fd = openLog(file);
  try {
    const size = fs.fstatSync(fd).size;
    const page = readLogPage(fd, size, 0, { maxLines: n, maxBytes: Infinity, lineCap: Infinity, scanBytes: 256 * 1024 * 1024 });
    return { lines: page.lines.map((l) => l.line), end: page.end };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Prints the tail, then appended lines as they arrive, until interrupted. Waits for a missing log
 * to appear, and starts over from the top when the file shrinks (it was rotated).
 */
async function follow(file: string, n: number): Promise<never> {
  const print = (lines: string[]) => {
    if (lines.length) process.stdout.write(lines.map(escapeControls).join('\n') + '\n');
  };
  let pos = 0;
  let partial = '';
  let first = true;
  for (;;) {
    let size = -1;
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(file);
    } catch {}
    if (st && !st.isFile()) throw new ForgeError(`cannot read ${path.basename(file)}: not a regular file`);
    if (st) size = st.size;
    if (size >= 0) {
      if (first) {
        const t = tail(file, n);
        print(t.lines);
        // Carry on after the last complete line the tail printed.
        pos = t.end;
        first = false;
      } else if (size < pos) {
        pos = 0;
        partial = '';
      }
      if (size > pos) {
        const buf = Buffer.alloc(size - pos);
        const fd = openLog(file);
        try {
          fs.readSync(fd, buf, 0, buf.length, pos);
        } finally {
          fs.closeSync(fd);
        }
        pos = size;
        const text = partial + buf.toString('utf8');
        const parts = text.split('\n');
        partial = parts.pop() ?? '';
        print(parts.filter((l) => l.trim()));
      }
    }
    await new Promise((r) => setTimeout(r, FOLLOW_MS));
  }
}
