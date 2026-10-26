// `forge daemon status|log`: the terminal's view of the session pool. Both read runtime files only,
// so they work with or without a running `forge dash` and never talk to its server.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { openRead, readInfo, sessionFiles, sessionRecords, tailLines } from '#core/job/session-files.ts';
import { redactKnown, scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { ASSISTANT_SCOPE_PREFIX, INBOX_SCOPE, MAX_ASSISTANTS, OFFICE_SCOPE, assistantScope, isAssistantScope, sharedScope, validJobId } from '#core/job/requests.ts';
import { sessionAgents } from '#office/session-agents.ts';
import { recordIds } from '#office/driver.ts';
import { ForgeError } from '#core/errors.ts';
import { pidAlive } from '#core/os/process.ts';
import { legacyDashboardFile, machineDashboardFile, provenDashboard, readDashboardRecord } from '#engine/ops/dashboard-record.ts';
import { forgeHome } from '#core/paths.ts';
import { usageError } from './args.ts';
import type { HelpGroup } from '../types.ts';

const DAEMON: HelpGroup = {
  name: 'daemon',
  summary: "the dashboard's headless sessions, from the terminal",
  commands: [
    { command: 'daemon status', args: '', summary: "the daemon's sessions, from the terminal", common: true },
    {
      command: 'daemon log',
      args: '<job>|--inbox|--office|--assistant N [--lines N] [--follow]',
      summary: "a session's log, from the terminal",
      flags: [
        ['--inbox', "the inbox session's log instead of a job's"],
        ['--office', "the Foreman's office session's log instead of a job's"],
        ['--assistant N', "assistant foreman N's log (1-16) instead of a job's"],
        ['--lines N', 'the last N lines (default 100, at most 5000)'],
        ['--follow', 'keep printing lines as they are written'],
      ],
      exits: [[1, 'an invalid job id, or no readable log']],
      common: true,
    },
  ],
};

export const HELP: HelpGroup[] = [DAEMON];
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
  throw usageError(DAEMON);
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function status(root: string): DaemonStatusOut {
  // The machine dashboard's record, else an older per-repo `forge dash`'s. A record that is not proven
  // still shows its pid, so the human sees something is there, but never its url.
  const files = [machineDashboardFile(forgeHome()), legacyDashboardFile(root)];
  const proven = files.map((f) => provenDashboard(f)).find((p) => p !== null) ?? null;
  const raw = proven ? null : (files.map((f) => readDashboardRecord(f)).find((r) => r && typeof r.pid === 'number') ?? null);
  const dashboard = proven
    ? { pid: proven.pid, url: proven.url, alive: true }
    : raw && typeof raw.pid === 'number' && Number.isInteger(raw.pid)
      ? { pid: raw.pid, url: null, alive: false }
      : null;
  // _inbox, then _office, then the assistant foremen by number, before every job id ('_' > 'Z' in code points, so they are placed first explicitly).
  const rank = (s: string) => (s === INBOX_SCOPE ? 0 : s === OFFICE_SCOPE ? 1 : isAssistantScope(s) ? 2 : 3);
  const nth = (s: string) => (isAssistantScope(s) ? Number(s.slice(ASSISTANT_SCOPE_PREFIX.length)) : 0);
  const records = sessionRecords(root).sort((a, b) => rank(a.scope) - rank(b.scope) || nth(a.scope) - nth(b.scope) || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
  const sessions = records.map((r) => {
    const info = readInfo(r.info);
    const pid = Number.isInteger(info.pid) ? info.pid : null;
    let logBytes = 0;
    try {
      logBytes = fs.statSync(r.log).size;
    } catch {}
    const alive = pid !== null && pidAlive(pid);
    const shared = sharedScope(r.scope);
    const owned = alive && !shared ? sessionAgents(root, r.scope, recordIds(info)) : null;
    return {
      scope: r.scope,
      job: shared ? null : r.scope,
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
  const assistant = flags.assistant;
  if ([flags.inbox, flags.office, assistant].filter((f) => f !== undefined).length > 1 || (assistant !== undefined && job !== undefined)) throw usageError(DAEMON, 'log');
  if (flags.inbox) scope = INBOX_SCOPE;
  else if (flags.office) scope = OFFICE_SCOPE;
  else if (assistant !== undefined) {
    // Checked as text before any path is built from it: 1 to MAX_ASSISTANTS, no leading zero.
    if (typeof assistant !== 'string' || !/^([1-9]|1[0-6])$/.test(assistant)) throw new ForgeError(`--assistant must be an integer from 1 to ${MAX_ASSISTANTS}`, 'usage');
    scope = assistantScope(Number(assistant));
  } else {
    // Refused before any path is built from it.
    if (!validJobId(job)) throw job === undefined ? usageError(DAEMON, 'log') : new ForgeError(`invalid job id ${JSON.stringify(String(job).slice(0, 80))}`);
    scope = job;
  }
  const n = flags.lines === undefined ? 100 : Number(flags.lines);
  if (!Number.isInteger(n) || n < 1 || n > MAX_LINES) throw new ForgeError(`--lines must be an integer from 1 to ${MAX_LINES}`, 'usage');
  const file = sessionFiles(root, scope).log;
  // Lines are redacted at write; this covers values recorded since, or a log written before.
  const known = scopeKnownValues(root, scope, loadConfig(root).config);
  const clean = (line: string) => escapeControls(redactKnown(line, known));
  if (!flags.follow) {
    if (!fs.existsSync(file)) throw new ForgeError(`no session log for ${scope}`);
    return tail(file, n).lines.map(clean).join('\n');
  }
  await follow(file, n, clean);
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
    return tailLines(fd, n);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Prints the tail, then appended lines as they arrive, until interrupted. Waits for a missing log
 * to appear, and starts over from the top when the file shrinks (it was rotated).
 */
async function follow(file: string, n: number, show: (line: string) => string): Promise<never> {
  const print = (lines: string[]) => {
    if (lines.length) process.stdout.write(lines.map(show).join('\n') + '\n');
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
