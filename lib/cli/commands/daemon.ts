// `forge daemon status|log|prompts`: the terminal's view of the session pool. Each reads runtime files only,
// so they work with or without a running `forge dash` and never talk to its server; `prompts` writes nothing,
// not even the config it suggests rules for.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { openRead, readInfo, sessionFiles, sessionRecords, tailLines } from '#core/job/session-files.ts';
import { redactKnown, scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { GATES_SCOPE, INBOX_SCOPE, OFFICE_SCOPE, sharedScope, validJobId } from '#core/job/requests.ts';
import { sessionAgents } from '#office/session/owned.ts';
import { readPromptHistory } from '#office/session/permissions/history.ts';
import { promptReport, promptRoots, type PromptReport } from '#office/session/permissions/suggest.ts';
import { parseAuditDate } from '#engine/ops/audit.ts';
import { recordIds } from '#office/driver.ts';
import { ForgeError } from '#core/errors.ts';
import { pidAlive } from '#core/os/process.ts';
import { legacyDashboardFile, machineDashboardFile, provenDashboard, readDashboardRecord } from '#engine/ops/dashboard-record.ts';
import { forgeHome } from '#core/paths.ts';
import { usageError } from './args.ts';
import type { HelpGroup } from '../types.ts';
import type { DaemonPermissionMode } from '#core/types.ts';

const DEFAULT_MIN = 3;
const MAX_MIN = 1000;

const DAEMON: HelpGroup = {
  name: 'daemon',
  summary: "the dashboard's headless sessions, from the terminal",
  commands: [
    { command: 'daemon status', args: '', summary: "the daemon's sessions and the machine dashboard (pid, url, launch permission mode), from the terminal", common: true },
    {
      command: 'daemon log',
      args: '<job>|--inbox|--office|--gates [--lines N] [--follow]',
      summary: "a session's log, or the gate runs' log, from the terminal",
      flags: [
        ['--inbox', "the inbox session's log instead of a job's"],
        ['--office', "the Foreman's office session's log instead of a job's"],
        ['--gates', "the gate runs' log (gate-start, gate-end, gate-held and error lines) instead of a job's"],
        ['--lines N', 'the last N lines (default 100, at most 5000)'],
        ['--follow', 'keep printing lines as they are written'],
      ],
      exits: [[1, 'an invalid job id, or no readable log']],
      common: true,
    },
    {
      command: 'daemon prompts',
      args: '[--since DATE] [--min N]',
      summary: 'the permission prompts pool sessions raised, grouped by candidate rule, with suggested daemon.allowedTools entries (read-only)',
      flags: [
        ['--since DATE', 'only count prompts answered at or after DATE (YYYY-MM-DD or a full ISO timestamp); a deny before it still blocks a suggestion'],
        ['--min N', `suggest a rule only once allowed at least N times (1-${MAX_MIN}, default ${DEFAULT_MIN})`],
      ],
      exits: [[2, `a --since that is not a date, a --min outside 1-${MAX_MIN}, or an argument (usage)`]],
    },
  ],
};

export const HELP: HelpGroup[] = [DAEMON];
const MAX_LINES = 5000;
const FOLLOW_MS = 250;

export interface DaemonStatusOut {
  /** `permissionMode`: the proven record's launch mode (`forge dash --permission-mode`), else null. */
  dashboard: { pid: number; url: string | null; alive: boolean; permissionMode: DaemonPermissionMode | null } | null;
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

export async function daemonCmd(root: string, sub: string | undefined, rest: string[], flags: Record<string, any>): Promise<DaemonStatusOut | PromptReport | string | undefined> {
  if (sub === 'status') return status(root);
  if (sub === 'log') return log(root, rest[0], flags);
  if (sub === 'prompts') return prompts(root, rest, flags);
  throw usageError(DAEMON);
}

/** The prompt history's report (lib/office/session/permissions/suggest.ts): reads the history and the config, writes nothing. */
function prompts(root: string, rest: string[], flags: Record<string, any>): PromptReport {
  if (rest.length) throw usageError(DAEMON, 'prompts');
  const since = flags.since === undefined ? null : parseAuditDate(flags.since, '--since');
  // Digits only: a bare --min (true), a repeated one (an array) and `0x10` all fail.
  const min = flags.min === undefined ? DEFAULT_MIN : /^\d{1,4}$/.test(String(flags.min)) ? Number(flags.min) : NaN;
  if (!(min >= 1 && min <= MAX_MIN))
    throw new ForgeError(`--min must be an integer from 1 to ${MAX_MIN} (got ${JSON.stringify(String(flags.min)).slice(0, 60)})`, 'usage');
  const config = loadConfig(root).config;
  // The whole history is read and promptReport applies `since`: a deny before it must still block a suggestion.
  return promptReport(readPromptHistory(root), { min, since, allowedTools: config.daemon?.allowedTools, roots: promptRoots(root, config) });
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
    ? { pid: proven.pid, url: proven.url, alive: true, permissionMode: proven.permissionMode }
    : raw && typeof raw.pid === 'number' && Number.isInteger(raw.pid)
      ? { pid: raw.pid, url: null, alive: false, permissionMode: null }
      : null;
  // _inbox, then _office, before every job id ('_' > 'Z' in code points, so they are placed first explicitly).
  const rank = (s: string) => (s === INBOX_SCOPE ? 0 : s === OFFICE_SCOPE ? 1 : 2);
  const records = sessionRecords(root).sort((a, b) => rank(a.scope) - rank(b.scope) || (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));
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
  if ([flags.inbox, flags.office, flags.gates].filter((f) => f !== undefined).length > 1 || (flags.gates !== undefined && job !== undefined)) throw usageError(DAEMON, 'log');
  if (flags.inbox) scope = INBOX_SCOPE;
  else if (flags.office) scope = OFFICE_SCOPE;
  else if (flags.gates) scope = GATES_SCOPE;
  else {
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
