// One supervised headless session. `forge dash` runs a pool of these (lib/daemon-pool.ts): one for
// the inbox and one per job with work. Each is a long-lived `claude -p --input-format stream-json`
// child that, whenever its pool sees new work for its scope, gets the one fixed `/forge requests`
// turn. A session never runs agents or writes job state itself: the claude child does, through the
// same claims and CLI as a human's session. docs/ARCHITECTURE.md "Daemon" and "Daemon security"
// describe the rules this file keeps.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effectiveLimits, exceededKeys, measureBudget } from './budget.ts';
import { TRUST_ENV, daemonProblems, loadConfig as defaultLoadConfig, trackerSymlinks, trustDigest } from './config.ts';
import { loadJob } from './jobs.ts';
import { PLUGIN_ROOT, paths } from './paths.ts';
import { SCOPE_ENV, validJobId, validScope } from './requests.ts';
import { isClaudeExecutable, now, run, sleepSync, splitWords, writeJsonAtomic } from './util.ts';
import { pidAlive } from './worktree.ts';
import type { Config, DaemonSessionState, DaemonStatus, ForgeRequest } from './types.ts';

/** What a session reports to its pool: a log line as it is written, or its new state after a change. */
export type SessionEvent = { kind: 'line'; scope: string; offset: number; line: string } | { kind: 'state'; scope: string; state: DaemonSessionState };

/** Where a session log goes: an fs.WriteStream, or a test's stand-in. */
export interface LogSink {
  write(line: string): boolean;
  on?(event: 'error', fn: (e: Error) => void): unknown;
  once?(event: 'drain', fn: () => void): unknown;
  end?(cb?: () => void): unknown;
}

/** Injection points for tests; every one defaults to the real thing. */
export interface DaemonOptions {
  spawn?: typeof nodeSpawn;
  killTree?: (child: DaemonChild, signal: NodeJS.Signals) => void;
  pollMs?: number;
  graceMs?: number;
  maxLineBytes?: number;
  rotateBytes?: number;
  env?: NodeJS.ProcessEnv;
  openLog?: (file: string) => LogSink;
  loadConfig?: (root: string, opts?: { text?: string | null }) => { config: Config };
}

/** DaemonOptions with every default filled in. */
export interface SessionOptions {
  spawn: typeof nodeSpawn;
  killTree: (child: DaemonChild, signal: NodeJS.Signals) => void;
  graceMs: number;
  maxLineBytes: number;
  rotateBytes: number;
  env: NodeJS.ProcessEnv;
  openLog: (file: string) => LogSink;
  readConfig: (root: string, opts?: { text?: string | null }) => { config: Config };
}

export function sessionOptions(opts: DaemonOptions = {}): SessionOptions {
  return {
    spawn: opts.spawn ?? nodeSpawn,
    killTree: opts.killTree ?? defaultKillTree,
    graceMs: opts.graceMs ?? 5000,
    maxLineBytes: opts.maxLineBytes ?? 8 * 1024 * 1024,
    rotateBytes: opts.rotateBytes ?? 20 * 1024 * 1024,
    env: opts.env ?? process.env,
    // fd-based, so a symlink planted as <scope>.log is refused rather than followed.
    openLog: opts.openLog ?? ((file: string) => fs.createWriteStream(file, { fd: openAppend(file) })),
    readConfig: opts.loadConfig ?? defaultLoadConfig,
  };
}

/** What a session needs from its pool, which owns the trust snapshot and every repo-wide decision. */
export interface SessionContext {
  /** The trustDigest a human's pool start took. */
  trusted(): string | null;
  poolWanted(): boolean;
  config(): Config;
  /** .forge/config.yml or .forge/trackers/ changed: the pool stops every session. */
  untrusted(): void;
  /** A repo-wide refusal (config, daemon.enabled, tracker symlinks): the pool stops every session. */
  fatal(message: string): void;
  emit(e: SessionEvent): void;
  /** A turn's result arrived. */
  onResult(scope: string): void;
  /** Something freed a slot or may have left work unserved: tick. */
  poke(): void;
}

/** What the supervisor records about each child it spawned. */
interface ChildMeta {
  resume: boolean;
  stdout: boolean;
  /** a system/init was seen (claude emits one as each turn starts) */
  init: boolean;
  result: boolean;
  asked: boolean;
  /** ids its results covered */
  committed: string[];
}

/** A spawned session, with the supervisor's bookkeeping attached. */
export type DaemonChild = ChildProcess & { _forge: ChildMeta };

/** One scope's supervisor. The pool decides when it spawns and gets a turn; the session does the rest. */
export interface Session {
  readonly scope: string;
  readonly wanted: boolean;
  readonly running: boolean;
  readonly status: DaemonStatus;
  readonly waiting: boolean;
  readonly held: 'budget' | null;
  readonly lastError: string | null;
  readonly lastResultAt: string | null;
  state(): DaemonSessionState;
  /** Applies this tick's pending requests for the scope: prunes, holds, and says whether any is fresh. */
  route(c: Config, pending: ForgeRequest[]): { eligible: string[]; fresh: boolean };
  /** Returns whether a child is now running. */
  spawn(c: Config, reason?: string): boolean;
  writeTurn(ids: string[]): void;
  kill(event: string, endStdin: boolean, reason?: string): Promise<void>;
  logEvent(event: string, extra?: Record<string, unknown>): void;
  setWaiting(waiting: boolean): void;
  setWanted(wanted: boolean): void;
  /** A human (re)started it: wanted again, with a clean failure count and error. */
  reset(): void;
  recent(afterOffset?: number): { offset: number; line: string }[];
  close(): Promise<void>;
  killSync(): void;
}

/**
 * The only bytes the daemon ever writes to the child's stdin. Nothing from requests, HTTP or
 * config reaches it, so inbox text can't become a prompt: the session reads requests through
 * `forge requests`, where they are fenced as data.
 */
export const TURN = Object.freeze({
  type: 'user',
  message: Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: '/forge requests' })]) }),
});
export const TURN_LINE = JSON.stringify(TURN) + '\n';

/** Request types that act on a job a budget stop may have parked. `approve` is the acknowledgement, so it is never held. */
export const HOLD_TYPES: string[] = ['resume', 'rework', 'answer', 'revise-spec'];

/**
 * Paths the session may never write, appended to every daemon command as --disallowedTools
 * whatever `daemon.command` says. Claude Code checks file writes against Edit(path) rules,
 * anchors relative paths at the session's cwd (the main checkout, so job worktrees are
 * unaffected) and lets deny beat allow. This stops the Edit/Write route only; trustDigest is the
 * check that also covers writes made through Bash (docs/ARCHITECTURE.md "Daemon security").
 */
export const DENY_TOOLS = Object.freeze(['Edit(.forge/config.yml)', 'Edit(.forge/trackers/**)']);

/** Why the supervisor stopped: shown in the dashboard, so it speaks to the human. */
export const TRUST_CHANGED =
  'daemon stopped: .forge/config.yml or .forge/trackers/ changed while it was running. The session can write files in this checkout, so only a human may approve that change: review `git diff .forge/`, then start the daemon again.';

const RING_SIZE = 200;
/** Lines kept in memory for replay are capped like SSE frames; the session log keeps them verbatim. */
const RING_LINE_BYTES = 64 * 1024;
const STDERR_CAP = 4096;
const MAX_FAILURES = 3;

/**
 * Git config pinned for the session and everything it runs (subagents, `forge`, verify commands).
 * GIT_CONFIG_* entries outrank every config file, and the allowlist has no `git -c`, so a hook
 * or fsmonitor program the session writes into the repo (e.g. a `core.hooksPath` dir such as
 * `.githooks/`, which Claude Code doesn't protect the way it does `.git/`) never runs.
 * Drivers that only .git/config or ~/.gitconfig can define (filter, diff, merge) are left alone.
 */
export const GIT_PINS = Object.freeze([
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
]);

/**
 * The child's environment: this plugin's bin/ first on PATH, git pins appended after any the
 * caller already set, and a no-op editor so `git merge|rebase --continue` can't wait on a TTY.
 */
export function sessionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // This plugin's bin/ goes first on PATH, so the session's `forge` is the same version as the
  // supervisor's even when another Forge install is on PATH (seen in the AC18 headless run).
  const PATH = [path.join(PLUGIN_ROOT, 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
  const out: NodeJS.ProcessEnv = { ...env, PATH, FORGE_DAEMON: '1', GIT_EDITOR: 'true' };
  const count = Number(env.GIT_CONFIG_COUNT ?? 0);
  const base = Number.isInteger(count) && count > 0 ? count : 0;
  GIT_PINS.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${base + i}`] = key;
    out[`GIT_CONFIG_VALUE_${base + i}`] = value;
  });
  out.GIT_CONFIG_COUNT = String(base + GIT_PINS.length);
  return out;
}

/** `daemon.command` split into words; see splitWords in lib/util.ts. */
export function parseTemplate(template: string): string[] {
  return splitWords(template, 'daemon.command');
}

/**
 * Placeholders expand after splitting, so a plugin path with spaces stays one argument.
 * DENY_TOOLS always follows the template.
 */
export function buildArgv(template: string, vars: { pluginRoot: string; session: { id: string; resume: boolean }; allowedTools: string[] }): string[] {
  const tools = (vars.allowedTools ?? []).join(',');
  const argv = parseTemplate(template).flatMap((tok) => {
    if (tok === '{session}') return [vars.session.resume ? '--resume' : '--session-id', vars.session.id];
    return [tok.replaceAll('{pluginRoot}', vars.pluginRoot).replaceAll('{allowedTools}', tools)];
  });
  return [...argv, '--disallowedTools', DENY_TOOLS.join(',')];
}

/**
 * A request is held while its job is parked on a budget that is still exceeded; once a human
 * raises or acknowledges it, the request becomes eligible on the next tick.
 */
export function heldByBudget(root: string, config: Config, rec: { type: string; job: string | null }): boolean {
  if (!HOLD_TYPES.includes(rec?.type) || !validJobId(rec.job)) return false;
  let job;
  try {
    job = loadJob(root, rec.job);
  } catch {
    return false;
  }
  if (job.state !== 'waiting' || job.waitingOn !== 'budget') return false;
  return exceededKeys(effectiveLimits(config, job), measureBudget(job), job.budget.ack, job.round).length > 0;
}

function defaultKillTree(child: DaemonChild, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return void child.kill(signal);
  // The child leads its own group (detached), so the group signal reaches whatever it started.
  // A child without a pid never spawned, and its error handler drops it before anything kills it.
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      process.kill(child.pid!, signal);
    } catch {}
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {}
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

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How far the process's start time may be from the recorded `startedAt` (ps reports whole seconds). */
const START_SLACK_MS = 30_000;

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
  const ps = run('ps', ['-o', 'pgid=', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)], { allowFail: true });
  const m = ps.ok ? /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/s.exec(ps.stdout.trim()) : null;
  if (!m || Number(m[1]) !== pid) return false;
  const own = run('ps', ['-o', 'pgid=', '-p', String(process.pid)], { allowFail: true });
  if (!own.ok || Number(own.stdout.trim()) === pid) return false;
  const started = Date.parse(m[2]);
  if (!Number.isFinite(started) || Math.abs(started - Date.parse(info.startedAt)) > START_SLACK_MS) return false;
  const command = m[3].trim();
  const words = command.split(/\s+/);
  const exeOk = path.isAbsolute(info.argv0) ? `${command} `.includes(`${info.argv0} `) : words.some((w) => path.basename(w) === info.argv0);
  if (!exeOk) return false;
  return ids.some((id) => words.some((w, i) => (w === '--session-id' || w === '--resume') && words[i + 1] === id));
}

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

/** The one-session daemon's record, from before the pool: reaped, then never used again. */
function legacyFiles(root: string): { info: string; log: string } {
  const dir = paths(root).runtime;
  return { info: path.join(dir, 'daemon.json'), log: path.join(dir, 'daemon.log') };
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

/** A live `forge dash` other than this process that recorded itself in any session record. */
export function otherOwner(root: string): number | null {
  for (const file of [legacyFiles(root).info, ...sessionRecords(root).map((r) => r.info)]) {
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
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
  return pid;
}

/**
 * Children left behind by a `forge dash` that died without stopping them. Each record (the legacy
 * daemon.json and every daemons/<scope>.json) is proven on its own: only when its server is gone,
 * its child is alive, and isOurChild proves it is the claude process the record describes, so a
 * reused or planted pid is never signalled.
 */
export function reapOrphans(root: string, opts: { graceMs?: number } = {}): { reaped: number[] } {
  const reaped: number[] = [];
  if (process.platform === 'win32') return { reaped };
  const graceMs = opts.graceMs ?? 5000;
  const legacy = legacyFiles(root);
  const old = readInfo(legacy.info);
  const pid = reapOne(old, graceMs);
  if (pid !== null) {
    reaped.push(pid);
    // daemon.log is never read again, so the note goes to the inbox log.
    appendLine(sessionFiles(root, '_inbox').log, { type: 'forge-daemon', at: now(), event: 'reaped', pid, record: 'daemon.json' });
    writeJsonAtomic(legacy.info, { ...old, pid: null });
  }
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

export function createSession(root: string, scope: string, ctx: SessionContext, o: SessionOptions): Session {
  const f = sessionFiles(root, scope);
  let info: any = { sessionId: null, resumable: false, pid: null, serverPid: null, argv0: null, startedAt: null, lastTurnAt: null, ...readInfo(f.info) };
  info.logBase = logBaseOf(info);

  let wanted = true;
  let status: DaemonStatus = 'off';
  let child: DaemonChild | null = null;
  let turns = 0;
  let lastResultAt: string | null = null;
  let lastError: string | null = null;
  let held: 'budget' | null = null;
  let waiting = false;
  let failures = 0;
  /** Request ids a finished turn has already covered; pruned to ids still pending. */
  const committed = new Set<string>();
  let inFlight: string[] = [];
  let sink: LogSink | null = null;
  /** Offset of the next line: logBase plus its byte position in <scope>.log. */
  let pos = info.logBase;
  const ring: { offset: number; line: string }[] = [];
  let idleTimer: NodeJS.Timeout | null = null;
  let closed = false;

  // Never recreate a repo that was deleted under a running supervisor (or a test's temp repo).
  const persist = () => {
    if (fs.existsSync(root)) writeJsonAtomic(f.info, info);
  };
  const changed = () => ctx.emit({ kind: 'state', scope, state: state() });

  function logSink(): LogSink {
    if (!sink) {
      if (!fs.existsSync(root)) return { write: () => true };
      fs.mkdirSync(f.dir, { recursive: true });
      let size = 0;
      try {
        size = fs.statSync(f.log).size;
      } catch {}
      pos = info.logBase + size;
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
  function logLine(line: string): boolean {
    const s = logSink();
    const offset = pos;
    const ok = s.write(line + '\n');
    pos += Buffer.byteLength(line) + 1;
    ring.push({ offset, line: capLine(line) });
    if (ring.length > RING_SIZE) ring.shift();
    ctx.emit({ kind: 'line', scope, offset, line });
    return ok;
  }

  const logEvent = (event: string, extra: Record<string, unknown> = {}) => void logLine(JSON.stringify({ type: 'forge-daemon', at: now(), event, ...extra }));

  function state(): DaemonSessionState {
    return {
      scope,
      wanted,
      running: Boolean(child),
      status,
      sessionId: info.sessionId ?? null,
      pid: child?.pid ?? null,
      lastTurnAt: info.lastTurnAt ?? null,
      lastResultAt,
      turns,
      failures,
      held,
      waiting,
      lastError,
    };
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(c: Config): void {
    clearIdle();
    const minutes = c?.daemon?.idleStopMinutes;
    if (typeof minutes !== 'number' || !(minutes > 0)) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (status === 'idle' && child) void kill('idle-stop', true, 'idle');
    }, minutes * 60_000);
    idleTimer.unref?.();
  }

  /** This session can't start (its executable is missing, say): stop wanting it, and only it. */
  function sessionFatal(message: string): void {
    wanted = false;
    status = 'off';
    lastError = message;
    logEvent('error', { message });
    changed();
  }

  function rotate() {
    let size: number;
    try {
      size = fs.statSync(f.log).size;
    } catch {
      return;
    }
    // An open sink may still hold writes the file doesn't show yet; offsets must count them.
    if (sink) size = Math.max(size, pos - info.logBase);
    if (size <= o.rotateBytes) return;
    if (sink) {
      sink.end?.();
      sink = null;
    }
    try {
      fs.renameSync(f.log, `${f.log}.1`);
    } catch {
      return;
    }
    info = { ...info, logBase: info.logBase + size };
    pos = info.logBase;
    persist();
  }

  function spawnChild(c: Config, reason?: string): boolean {
    if (child) return true;
    if (closed) return false;
    const links = trackerSymlinks(root);
    if (links.length) {
      ctx.fatal(`cannot start daemon: .forge/trackers/ contains symlinks (${links.join(', ')}), whose targets the daemon can't pin; replace them with files`);
      return false;
    }
    // Respawns (idle stop, resume failure, new work) happen without a human, so they reuse the
    // pool start's snapshot. config.yml is read once, hashed, and that same text is what argv is
    // built from: a file swapped and restored between two reads (by a job's background process,
    // say) can't slip in.
    let bytes: Buffer | null = null;
    try {
      bytes = fs.readFileSync(paths(root).config);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bytes = Buffer.from(`!${(e as NodeJS.ErrnoException).code}`);
    }
    const trusted = ctx.trusted();
    if (!trusted || trustDigest(root, bytes) !== trusted) {
      ctx.untrusted();
      return false;
    }
    try {
      c = o.readConfig(root, { text: bytes === null ? null : bytes.toString('utf8') }).config;
    } catch (e) {
      ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    if (c.daemon?.enabled !== true) {
      ctx.fatal('daemon.enabled is false in .forge/config.yml');
      return false;
    }
    const problem = daemonProblems(c, root)[0];
    if (problem) {
      ctx.fatal(problem);
      return false;
    }
    rotate();
    // The record is a local file anyone with repo access can edit; only a uuid may follow --resume.
    const resume = Boolean(info.resumable && typeof info.sessionId === 'string' && UUID.test(info.sessionId));
    if (!resume) info = { ...info, sessionId: crypto.randomUUID(), resumable: false };
    let argv;
    try {
      argv = buildArgv(c.daemon.command, { pluginRoot: PLUGIN_ROOT, session: { id: info.sessionId, resume }, allowedTools: c.daemon.allowedTools });
    } catch (e) {
      ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    let c2;
    try {
      // The scope reaches the session only through its environment, never stdin or argv.
      c2 = o.spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sessionEnv(o.env), [TRUST_ENV]: trusted, [SCOPE_ENV]: scope } });
    } catch (e) {
      sessionFatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    // _forge is attached on the next lines, before anything reads it.
    const proc = c2 as DaemonChild;
    child = proc;
    status = 'idle';
    waiting = false;
    const meta: ChildMeta = { resume, stdout: false, init: false, result: false, asked: false, committed: [] };
    proc._forge = meta;
    info = { ...info, pid: proc.pid ?? null, serverPid: process.pid, argv0: argv[0], startedAt: now(), spawnSessionId: info.sessionId };
    persist();
    logEvent('spawn', { pid: proc.pid ?? null, sessionId: info.sessionId, resume, ...(reason ? { reason } : {}) });

    proc.on('error', (e: Error) => {
      if (child !== proc) return;
      if (!proc.pid) {
        // Never started (ENOENT, EACCES): retrying can't help, so stop wanting this session.
        child = null;
        clearIdle();
        inFlight = [];
        info = { ...info, pid: null };
        persist();
        sessionFatal(`cannot start daemon: ${e.message}`);
      } else logEvent('error', { message: e.message });
    });
    // EPIPE on a child that died mid-write must not take the server down.
    proc.stdin?.on('error', (e: Error) => {
      if (child === proc) logEvent('error', { message: `stdin: ${e.message}` });
    });
    proc.stdout?.on(
      'data',
      splitter(o.maxLineBytes, (line) => onStdout(proc, line), (n) => {
        if (child === proc) logEvent('line-truncated', { bytes: n });
      }),
    );
    proc.stderr?.on(
      'data',
      splitter(STDERR_CAP, (text) => void logLine(JSON.stringify({ type: 'forge-stderr', at: now(), text })), null),
    );
    proc.on('close', (code: number | null, signal: string | null) => onExit(proc, code, signal));
    armIdle(c);
    changed();
    return true;
  }

  function onStdout(proc: DaemonChild, line: string): void {
    const meta = proc._forge;
    let ev: any = null;
    try {
      ev = JSON.parse(line);
    } catch {}
    const ok = ev && typeof ev === 'object' ? logLine(line) : logLine(JSON.stringify({ type: 'forge-raw', at: now(), text: line }));
    if (!ok && proc.stdout && !proc.stdout.isPaused()) {
      proc.stdout.pause();
      // write() returned false, so the sink is a real stream (the stand-in never does), and stdout was
      // checked just above, where the callback can't see the narrowing.
      logSink().once!('drain', () => proc.stdout!.resume());
    }
    if (child !== proc) return;
    if (!meta.stdout) {
      meta.stdout = true;
      if (!info.resumable) {
        info = { ...info, resumable: true };
        persist();
      }
    }
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'system' && ev.subtype === 'init') meta.init = true;
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id && ev.session_id !== info.sessionId) {
      // It becomes the value after --resume on the next spawn, so it must be a uuid, never a flag.
      if (!UUID.test(ev.session_id)) return void logEvent('error', { message: `ignored a non-uuid session_id: ${JSON.stringify(ev.session_id.slice(0, 80))}` });
      const from = info.sessionId;
      info = { ...info, sessionId: ev.session_id };
      persist();
      logEvent('session-changed', { from, to: ev.session_id });
      changed();
    }
    if (ev.type === 'result') onResult(proc, ev);
  }

  function onResult(proc: DaemonChild, ev: Record<string, any>): void {
    proc._forge.result = true;
    proc._forge.committed.push(...inFlight);
    failures = 0;
    // A working turn clears errors from earlier exits and failed turns; a refusal or fatal error stays.
    if (lastError && /^(daemon exited|last turn failed)/.test(lastError)) lastError = null;
    // claude reports an API failure (an expired login, say) as a result with is_error, often
    // with subtype "success": the session is alive but no request is making progress.
    if (ev.is_error === true) {
      const why = typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : String(ev.subtype ?? 'error');
      lastError = `last turn failed: ${why.slice(0, 300)}`;
    }
    for (const id of inFlight) committed.add(id);
    inFlight = [];
    lastResultAt = now();
    if (status === 'busy') status = 'idle';
    logEvent('result', { turns });
    changed();
    if (status === 'idle') {
      try {
        armIdle(ctx.config());
      } catch {}
    }
    ctx.onResult(scope);
  }

  function onExit(proc: DaemonChild, code: number | null, signal: string | null): void {
    if (child !== proc) return;
    const meta = proc._forge;
    child = null;
    clearIdle();
    inFlight = [];
    status = 'off';
    info = { ...info, pid: null };
    persist();
    logEvent('exit', { code, signal });
    if (meta.asked) {
      // A failed turn's error describes the process just stopped on purpose; the log keeps it.
      // Clearing it lets a finished or slot-stopped session be pruned instead of showing failing forever.
      if (lastError?.startsWith('last turn failed')) lastError = null;
      return changed();
    }
    if (meta.resume && !meta.init && code !== 0 && code !== null) {
      // The transcript is gone (or unreadable): start over once rather than counting a failure.
      // Real claude still prints one `result` (subtype error_during_execution, is_error) before
      // exiting 1, so the test is "no system/init", and whatever that result committed is undone:
      // no turn actually ran.
      for (const id of meta.committed) committed.delete(id);
      if (lastError?.startsWith('last turn failed')) lastError = null;
      logEvent('resume-failed', { sessionId: info.sessionId, code });
      info = { ...info, sessionId: crypto.randomUUID(), resumable: false };
      persist();
      changed();
      // Its own slot was just freed, so the respawn needs no new one.
      if (wanted && ctx.poolWanted() && !closed) {
        try {
          if (spawnChild(ctx.config())) ctx.poke();
        } catch (e) {
          sessionFatal(`cannot start daemon: ${(e as Error).message}`);
        }
      }
      return;
    }
    lastError = `daemon exited (code ${code}, signal ${signal})`;
    if (!meta.result) failures++;
    if (failures >= MAX_FAILURES && wanted) {
      wanted = false;
      lastError = `daemon stopped after ${MAX_FAILURES} failed starts: ${lastError}`;
      logEvent('error', { message: lastError });
    }
    changed();
  }

  /** Stops the current child: SIGTERM to its group, SIGKILL after graceMs. */
  async function kill(event: string, endStdin: boolean, reason?: string): Promise<void> {
    const proc = child;
    if (!proc) {
      if (status !== 'off') {
        status = 'off';
        changed();
      }
      return;
    }
    proc._forge.asked = true;
    clearIdle();
    status = 'stopping';
    logEvent(event, { pid: proc.pid ?? null, ...(reason ? { reason } : {}) });
    changed();
    const closedP = new Promise((resolve) => proc.once('close', () => resolve(true)));
    const wait = (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise((r) => (timer = setTimeout(() => r(false), ms)));
      // Cleared once the child closes, so a pending grace timer never holds the process open.
      return Promise.race([closedP, timeout]).finally(() => clearTimeout(timer));
    };
    if (endStdin) {
      try {
        proc.stdin?.end();
      } catch {}
    }
    o.killTree(proc, 'SIGTERM');
    if (!(await wait(o.graceMs))) {
      o.killTree(proc, 'SIGKILL');
      await wait(o.graceMs);
    }
    if (child === proc) {
      // No close event at all (a stuck pipe): treat it as gone so the supervisor can't wedge.
      child = null;
      info = { ...info, pid: null };
      persist();
    }
    if (!child) status = 'off';
    changed();
    // A start that arrived while this child was stopping, or a job waiting for this slot, gets its session now.
    if (!closed) ctx.poke();
  }

  function writeTurn(ids: string[]): void {
    // The pool only calls this once a child is running, and its stdin is a pipe.
    child!.stdin!.write(TURN_LINE);
    status = 'busy';
    inFlight = ids;
    turns++;
    info = { ...info, lastTurnAt: now() };
    persist();
    clearIdle();
    logEvent('turn', { requests: ids.length, turn: turns });
    changed();
  }

  return {
    scope,
    get wanted() {
      return wanted;
    },
    get running() {
      return Boolean(child);
    },
    get status() {
      return status;
    },
    get waiting() {
      return waiting;
    },
    get held() {
      return held;
    },
    get lastError() {
      return lastError;
    },
    get lastResultAt() {
      return lastResultAt;
    },
    state,
    route(c, pending) {
      const ids = new Set(pending.map((r) => r.id));
      for (const id of committed) if (!ids.has(id)) committed.delete(id);
      let isHeld = false;
      const eligible: string[] = [];
      for (const r of pending) {
        if (heldByBudget(root, c, r)) isHeld = true;
        else eligible.push(r.id);
      }
      const next = isHeld ? 'budget' : null;
      if (next !== held) {
        held = next;
        logEvent('held', { held: next });
        changed();
      }
      return { eligible, fresh: eligible.some((id) => !committed.has(id)) };
    },
    spawn: spawnChild,
    writeTurn,
    kill,
    logEvent,
    setWaiting(w) {
      if (w === waiting) return;
      waiting = w;
      if (w) logEvent('waiting', { maxConcurrent: ctx.config().daemon?.maxConcurrent ?? null });
      changed();
    },
    setWanted(w) {
      if (w === wanted) return;
      wanted = w;
      if (!w) waiting = false;
      changed();
    },
    reset() {
      wanted = true;
      failures = 0;
      lastError = null;
      changed();
    },
    /** Buffered lines after `afterOffset`; all of them when it is missing or ahead of us (a restarted server). */
    recent(afterOffset) {
      const last = ring.length ? ring[ring.length - 1].offset : -1;
      if (afterOffset === undefined || !Number.isFinite(afterOffset) || afterOffset > last) return ring.slice();
      return ring.filter((r) => r.offset > afterOffset);
    },
    async close() {
      await kill('stop', false);
      closed = true;
      clearIdle();
      // Only our own record: a refused start must not clear the owning server's pid.
      if (info.serverPid === process.pid) {
        info = { ...info, pid: null, serverPid: null };
        persist();
      }
      if (sink) {
        const s = sink;
        sink = null;
        await new Promise((resolve) => {
          if (typeof s.end !== 'function') return resolve(undefined);
          s.end(() => resolve(undefined));
        });
      }
    },
    /** Last resort from a process `exit` handler: synchronous, so it can't wait for the grace period. */
    killSync() {
      if (child) o.killTree(child, 'SIGTERM');
    },
  };
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
