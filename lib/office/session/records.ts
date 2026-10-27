// What a session record (`.forge/runtime/daemons/<scope>.json`) says about its child, and reaping the
// children a dead `forge dash` left behind. The record is a file anyone with repo access can edit,
// so every pid in it is proved before it is signalled (isOurChild).
import fs from 'node:fs';
import path from 'node:path';
import { UUID, openAppend, readInfo, sessionFiles, sessionRecords } from '#core/job/session-files.ts';
import { START_SLACK_MS, isClaudeExecutable, killAndWait, pidAlive, processStartMs, run } from '#core/os/process.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { now } from '#core/utils.ts';
import type { DaemonSessionState } from '#core/types.ts';

/** A session the pool isn't running: what its record still says. */
export function offState(root: string, scope: string): DaemonSessionState {
  const info = readInfo(sessionFiles(root, scope).info);
  return {
    scope,
    wanted: true,
    running: false,
    status: 'off',
    sessionId: typeof info.sessionId === 'string' && UUID.test(info.sessionId) ? info.sessionId : null,
    pid: null,
    lastTurnAt: typeof info.lastTurnAt === 'string' && Date.parse(info.lastTurnAt) ? info.lastTurnAt : null,
    lastResultAt: null,
    turns: 0,
    failures: 0,
    held: null,
    waiting: false,
    lastError: null,
    permissions: [],
    permissionMode: null,
    kept: null,
    effort: null,
    contextTokens: null,
  };
}

function appendLine(file: string, line: unknown): void {
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fd = openAppend(file);
    fs.writeSync(fd, JSON.stringify(line) + '\n');
  } catch {
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** How many replaced session ids a record remembers, so a job claimed by an old incarnation can be handed on. */
const MAX_PAST_SESSION_IDS = 20;

/**
 * The record after its session id becomes `next`: the old id (a uuid only, since the record is a
 * local file anyone with repo access can edit) joins `pastSessionIds`, deduped and capped. A record
 * runs one child at a time, so a past id names a session that has exited (lib/office/driver.ts).
 */
export function withSessionId(info: any, next: string): any {
  const kept = [...(Array.isArray(info.pastSessionIds) ? info.pastSessionIds : []), info.sessionId].filter((s: unknown): s is string => typeof s === 'string' && UUID.test(s) && s !== next);
  // Deduped keeping each id's latest position, so the cap drops the oldest.
  const past = kept.filter((s, i) => kept.lastIndexOf(s) === i);
  return { ...info, sessionId: next, pastSessionIds: past.slice(-MAX_PAST_SESSION_IDS) };
}

/**
 * Whether `pid` is provably the claude child a supervisor recorded in a session record. That file
 * lives in the repo's runtime dir, so it is checked rather than trusted: the process must lead
 * its own group (we spawn detached), not be us or our group, have started when the record says,
 * and run the recorded claude executable with the recorded session uuid as its session flag.
 */
export function isOurChild(info: any, pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const ids = [info.sessionId, info.spawnSessionId].filter((s) => typeof s === 'string' && UUID.test(s));
  if (!ids.length || typeof info.argv0 !== 'string' || !isClaudeExecutable(info.argv0) || !Date.parse(info.startedAt)) return false;
  const ps = run('ps', ['-o', 'pgid=', '-o', 'command=', '-p', String(pid)], { allowFail: true });
  const m = ps.ok ? /^\s*(\d+)\s+(.*)$/s.exec(ps.stdout.trim()) : null;
  if (!m || Number(m[1]) !== pid) return false;
  const own = run('ps', ['-o', 'pgid=', '-p', String(process.pid)], { allowFail: true });
  if (!own.ok || Number(own.stdout.trim()) === pid) return false;
  const started = processStartMs(pid);
  if (started === null || Math.abs(started - Date.parse(info.startedAt)) > START_SLACK_MS) return false;
  const command = m[2].trim();
  const words = command.split(/\s+/);
  const exeOk = path.isAbsolute(info.argv0) ? `${command} `.includes(`${info.argv0} `) : words.some((w) => path.basename(w) === info.argv0);
  if (!exeOk) return false;
  return ids.some((id) => words.some((w, i) => (w === '--session-id' || w === '--resume') && words[i + 1] === id));
}

/** A live `forge dash` other than this process that recorded itself in any daemons/<scope>.json. */
export function otherOwner(root: string): number | null {
  for (const file of sessionRecords(root).map((r) => r.info)) {
    const pid = readInfo(file).serverPid;
    if (Number.isInteger(pid) && pid !== process.pid && pidAlive(pid)) return pid;
  }
  return null;
}

function reapOne(info: any, graceMs: number): number | null {
  const pid = info.pid;
  if (!Number.isInteger(pid)) return null;
  const serverGone = !info.serverPid || info.serverPid === process.pid || !pidAlive(info.serverPid);
  if (!serverGone || !pidAlive(pid) || !isOurChild(info, pid)) return null;
  killAndWait(pid, graceMs);
  return pid;
}

/**
 * Children left behind by a `forge dash` that died without stopping them. Each daemons/<scope>.json
 * record is proven on its own: only when its server is gone, its child is alive, and isOurChild
 * proves it is the claude process the record describes, so a reused or planted pid is never
 * signalled.
 */
export function reapOrphans(root: string, opts: { graceMs?: number } = {}): { reaped: number[] } {
  const reaped: number[] = [];
  if (process.platform === 'win32') return { reaped };
  const graceMs = opts.graceMs ?? 5000;
  for (const r of sessionRecords(root)) {
    const info = readInfo(r.info);
    const p = reapOne(info, graceMs);
    if (p === null) continue;
    reaped.push(p);
    appendLine(r.log, { type: 'forge-daemon', at: now(), event: 'reaped', pid: p });
    writeJsonAtomic(r.info, { ...info, pid: null });
  }
  return { reaped };
}
