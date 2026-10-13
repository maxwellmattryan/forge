// The opt-in headless orchestrator. `forge dash` supervises one long-lived
// `claude -p --input-format stream-json` session and, whenever new inbox work appears, writes it
// the one fixed `/forge requests` turn. The daemon never runs agents or writes job state itself:
// the session it supervises does, through the same claims and CLI as a human's session.
// docs/ARCHITECTURE.md "Daemon" and "Daemon security" describe the rules this file keeps.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effectiveLimits, exceededKeys, measureBudget } from './budget.ts';
import { TRUST_ENV, daemonProblems, loadConfig as defaultLoadConfig, trackerSymlinks, trustDigest } from './config.ts';
import { loadJob } from './jobs.ts';
import { PLUGIN_ROOT, paths } from './paths.ts';
import { listRequests } from './requests.ts';
import { isClaudeExecutable, now, run, sleepSync, splitWords, writeJsonAtomic } from './util.ts';
import { pidAlive } from './worktree.ts';
import type { Config, DaemonState, DaemonStatus } from './types.ts';

/** The supervisor's own state: state() below. The server adds `clients` to make a DaemonState. */
export type SupervisorState = Omit<DaemonState, 'clients'>;

/** What subscribers receive: a log line as it is written, or the new state after a change. */
export type DaemonEvent = { kind: 'line'; seq: number; line: string } | { kind: 'state'; state: SupervisorState };

/** Where daemon.log goes: an fs.WriteStream, or a test's stand-in. */
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

/** The supervisor createDaemon returns: one per `forge dash`. */
export interface Daemon {
  start(reason?: string): SupervisorState;
  stop(reason?: string): Promise<SupervisorState>;
  poke(): void;
  state(): SupervisorState;
  subscribe(fn: (e: DaemonEvent) => void): () => void;
  recent(afterSeq?: number): { seq: number; line: string }[];
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
/** Lines kept in memory for replay are capped like SSE frames; daemon.log keeps them verbatim. */
const RING_LINE_BYTES = 64 * 1024;
const STDERR_CAP = 4096;
const MAX_FAILURES = 3;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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
  if (!HOLD_TYPES.includes(rec?.type) || typeof rec.job !== 'string' || !JOB_ID.test(rec.job)) return false;
  let job;
  try {
    job = loadJob(root, rec.job);
  } catch {
    return false;
  }
  if (job.state !== 'waiting' || job.waitingOn !== 'budget') return false;
  return exceededKeys(effectiveLimits(config, job), measureBudget(job), job.budget.ack, job.round).length > 0;
}

function files(root: string) {
  const dir = paths(root).runtime;
  return { dir, info: path.join(dir, 'daemon.json'), log: path.join(dir, 'daemon.log') };
}

/** A corrupt daemon.json is treated as absent rather than wedging the dashboard. */
function readInfo(file: string): any {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
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
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How far the process's start time may be from the recorded `startedAt` (ps reports whole seconds). */
const START_SLACK_MS = 30_000;

/**
 * Whether `pid` is provably the claude child a supervisor recorded in daemon.json. That file
 * lives in the repo's runtime dir, so it is checked rather than trusted: the process must lead
 * its own group (we spawn detached), not be us or our group, have started when the record says,
 * and run the recorded claude executable with the recorded session uuid as its session flag.
 */
function isOurChild(info: any, pid: number): boolean {
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
 * A child left behind by a `forge dash` that died without stopping it. Only acts when the
 * recorded server is gone, the child is alive, and isOurChild proves it is the claude process
 * the record describes, so a reused or planted pid is never signalled.
 */
export function reapOrphan(root: string, opts: { graceMs?: number } = {}): { reaped: boolean; pid: number | null } {
  const none = { reaped: false, pid: null };
  if (process.platform === 'win32') return none;
  const f = files(root);
  const info = readInfo(f.info);
  const pid = info.pid;
  if (!Number.isInteger(pid)) return none;
  const serverGone = !info.serverPid || info.serverPid === process.pid || !pidAlive(info.serverPid);
  if (!serverGone || !pidAlive(pid) || !isOurChild(info, pid)) return none;
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + (opts.graceMs ?? 5000);
  while (pidAlive(pid) && Date.now() < deadline) sleepSync(50);
  if (pidAlive(pid)) signalGroup(pid, 'SIGKILL');
  appendLine(f.log, { type: 'forge-daemon', at: now(), event: 'reaped', pid });
  writeJsonAtomic(f.info, { ...info, pid: null });
  return { reaped: true, pid };
}

export function createDaemon(root: string, opts: DaemonOptions = {}): Daemon {
  const spawn = opts.spawn ?? nodeSpawn;
  const killTree = opts.killTree ?? defaultKillTree;
  const pollMs = opts.pollMs ?? 2000;
  const graceMs = opts.graceMs ?? 5000;
  const maxLineBytes = opts.maxLineBytes ?? 8 * 1024 * 1024;
  const rotateBytes = opts.rotateBytes ?? 20 * 1024 * 1024;
  const env = opts.env ?? process.env;
  const openLog = opts.openLog ?? ((file: string) => fs.createWriteStream(file, { flags: 'a' }));
  const readConfig = opts.loadConfig ?? defaultLoadConfig;
  const f = files(root);

  reapOrphan(root, { graceMs });
  let info: any = { sessionId: null, resumable: false, pid: null, serverPid: null, argv0: null, startedAt: null, lastTurnAt: null, ...readInfo(f.info) };

  let enabled = false;
  let wanted = false;
  let status: DaemonStatus = 'off';
  let child: DaemonChild | null = null;
  let turns = 0;
  let lastResultAt: string | null = null;
  let lastError: string | null = null;
  let held: SupervisorState['held'] = null;
  /** trustDigest taken when a human (dashboard or `forge dash`) last started the daemon. */
  let trusted: string | null = null;
  let failures = 0;
  /** Request ids a finished turn has already covered; pruned to ids still pending. */
  const committed = new Set<string>();
  let inFlight: string[] = [];
  let sink: LogSink | null = null;
  const ring: { seq: number; line: string }[] = [];
  let seq = 0;
  const subscribers = new Set<(e: DaemonEvent) => void>();
  let pollTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let closed = false;

  // Never recreate a repo that was deleted under a running supervisor (or a test's temp repo).
  const persist = () => {
    if (fs.existsSync(root)) writeJsonAtomic(f.info, info);
  };
  const emit = (e: DaemonEvent) => {
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {}
    }
  };
  const changed = () => emit({ kind: 'state', state: state() });
  try {
    config();
  } catch {}

  function logSink(): LogSink {
    if (!sink) {
      if (!fs.existsSync(root)) return { write: () => true };
      fs.mkdirSync(f.dir, { recursive: true });
      sink = openLog(f.log);
      sink.on?.('error', () => {});
    }
    return sink;
  }

  /** Appends one line to daemon.log and the replay ring; returns the sink's write() result. */
  function logLine(line: string): boolean {
    const ok = logSink().write(line + '\n');
    seq++;
    ring.push({ seq, line: capLine(line) });
    if (ring.length > RING_SIZE) ring.shift();
    emit({ kind: 'line', seq, line });
    return ok;
  }

  const logEvent = (event: string, extra: Record<string, unknown> = {}) => logLine(JSON.stringify({ type: 'forge-daemon', at: now(), event, ...extra }));

  function state(): SupervisorState {
    return {
      enabled,
      wanted,
      running: Boolean(child),
      status,
      sessionId: info.sessionId ?? null,
      pid: child?.pid ?? null,
      lastTurnAt: info.lastTurnAt ?? null,
      lastResultAt,
      turns,
      held,
      lastError,
    };
  }

  function config(): Config {
    const { config: c } = readConfig(root);
    enabled = c.daemon?.enabled === true;
    return c;
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
      if (status === 'idle' && child) void kill('idle-stop', true);
    }, minutes * 60_000);
    idleTimer.unref?.();
  }

  function fatal(message: string): void {
    wanted = false;
    status = 'off';
    lastError = message;
    logEvent('error', { message });
    changed();
  }

  /** The session (or anyone) changed what Forge executes: stop, and wait for a human to start again. */
  function untrusted() {
    wanted = false;
    lastError = TRUST_CHANGED;
    logEvent('error', { message: TRUST_CHANGED });
    if (child) void kill('stop', false, 'trust');
    else {
      status = 'off';
      changed();
    }
  }

  function rotate() {
    try {
      if (fs.statSync(f.log).size <= rotateBytes) return;
    } catch {
      return;
    }
    if (sink) {
      sink.end?.();
      sink = null;
    }
    try {
      fs.renameSync(f.log, `${f.log}.1`);
    } catch {}
  }

  /** Returns whether a child is now running. */
  function spawnChild(c: Config, reason?: string): boolean {
    const links = trackerSymlinks(root);
    if (links.length) {
      fatal(`cannot start daemon: .forge/trackers/ contains symlinks (${links.join(', ')}), whose targets the daemon can't pin; replace them with files`);
      return false;
    }
    // Respawns (idle stop, resume failure) happen without a human, so they reuse start()'s snapshot.
    // config.yml is read once, hashed, and that same text is what argv is built from: a file
    // swapped and restored between two reads (by a job's background process, say) can't slip in.
    let bytes: Buffer | null = null;
    try {
      bytes = fs.readFileSync(paths(root).config);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') bytes = Buffer.from(`!${(e as NodeJS.ErrnoException).code}`);
    }
    if (!trusted || trustDigest(root, bytes) !== trusted) {
      untrusted();
      return false;
    }
    try {
      c = readConfig(root, { text: bytes === null ? null : bytes.toString('utf8') }).config;
    } catch (e) {
      fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    if (c.daemon?.enabled !== true) {
      fatal('daemon.enabled is false in .forge/config.yml');
      return false;
    }
    const problem = daemonProblems(c, root)[0];
    if (problem) {
      fatal(problem);
      return false;
    }
    rotate();
    // daemon.json is a local file anyone with repo access can edit; only a uuid may follow --resume.
    const resume = Boolean(info.resumable && typeof info.sessionId === 'string' && UUID.test(info.sessionId));
    if (!resume) info = { ...info, sessionId: crypto.randomUUID(), resumable: false };
    let argv;
    try {
      argv = buildArgv(c.daemon.command, { pluginRoot: PLUGIN_ROOT, session: { id: info.sessionId, resume }, allowedTools: c.daemon.allowedTools });
    } catch (e) {
      fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    let c2;
    try {
      c2 = spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sessionEnv(env), [TRUST_ENV]: trusted } });
    } catch (e) {
      fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    // _forge is attached on the next lines, before anything reads it.
    const proc = c2 as DaemonChild;
    child = proc;
    status = 'idle';
    const meta: ChildMeta = { resume, stdout: false, init: false, result: false, asked: false, committed: [] };
    proc._forge = meta;
    info = { ...info, pid: proc.pid ?? null, serverPid: process.pid, argv0: argv[0], startedAt: now(), spawnSessionId: info.sessionId };
    persist();
    logEvent('spawn', { pid: proc.pid ?? null, sessionId: info.sessionId, resume, ...(reason ? { reason } : {}) });

    proc.on('error', (e: Error) => {
      if (child !== proc) return;
      if (!proc.pid) {
        // Never started (ENOENT, EACCES): retrying can't help, so stop wanting it.
        child = null;
        clearIdle();
        inFlight = [];
        info = { ...info, pid: null };
        persist();
        fatal(`cannot start daemon: ${e.message}`);
      } else logEvent('error', { message: e.message });
    });
    // EPIPE on a child that died mid-write must not take the server down.
    proc.stdin?.on('error', (e: Error) => {
      if (child === proc) logEvent('error', { message: `stdin: ${e.message}` });
    });
    proc.stdout?.on(
      'data',
      splitter(maxLineBytes, (line) => onStdout(proc, line), (bytes) => {
        if (child === proc) logEvent('line-truncated', { bytes });
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
    if (ev.type === 'result') onResult(proc);
  }

  function onResult(proc: DaemonChild): void {
    proc._forge.result = true;
    proc._forge.committed.push(...inFlight);
    failures = 0;
    // A working turn clears errors from earlier exits or ticks; a refusal or fatal error stays.
    if (lastError && /^daemon (exited|tick failed)/.test(lastError)) lastError = null;
    for (const id of inFlight) committed.add(id);
    inFlight = [];
    lastResultAt = now();
    if (status === 'busy') status = 'idle';
    logEvent('result', { turns });
    changed();
    if (status === 'idle') {
      try {
        armIdle(config());
      } catch {}
    }
    tick();
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
    if (meta.asked) return changed();
    if (meta.resume && !meta.init && code !== 0 && code !== null) {
      // The transcript is gone (or unreadable): start over once rather than counting a failure.
      // Real claude still prints one `result` (subtype error_during_execution, is_error) before
      // exiting 1, so the test is "no system/init", and whatever that result committed is undone:
      // no turn actually ran.
      for (const id of meta.committed) committed.delete(id);
      logEvent('resume-failed', { sessionId: info.sessionId, code });
      info = { ...info, sessionId: crypto.randomUUID(), resumable: false };
      persist();
      changed();
      if (wanted) {
        try {
          if (spawnChild(config())) tick();
        } catch (e) {
          fatal(`cannot start daemon: ${(e as Error).message}`);
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
      status = 'off';
      changed();
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
    killTree(proc, 'SIGTERM');
    if (!(await wait(graceMs))) {
      killTree(proc, 'SIGKILL');
      await wait(graceMs);
    }
    if (child === proc) {
      // No close event at all (a stuck pipe): treat it as gone so the supervisor can't wedge.
      child = null;
      info = { ...info, pid: null };
      persist();
    }
    if (!child) status = 'off';
    changed();
    // A start() that arrived while this child was stopping gets its session now.
    if (event === 'stop' && wanted && !child && !closed) {
      try {
        if (spawnChild(config())) tick();
      } catch {}
    }
  }

  function tick(): void {
    if (!wanted || closed) return;
    try {
      const c = config();
      if (trustDigest(root) !== trusted) return untrusted();
      const pending = listRequests(root, { status: 'pending' });
      const ids = new Set(pending.map((r) => r.id));
      for (const id of committed) if (!ids.has(id)) committed.delete(id);
      const heldJobs = new Set<string>();
      const eligible: string[] = [];
      for (const r of pending) {
        // heldByBudget is true only for a request whose job is a string.
        if (heldByBudget(root, c, r)) heldJobs.add(r.job!);
        else eligible.push(r.id);
      }
      const nextHeld = heldJobs.size ? { reason: 'budget' as const, jobs: [...heldJobs].sort() } : null;
      if (JSON.stringify(nextHeld) !== JSON.stringify(held)) {
        held = nextHeld;
        logEvent('held', { jobs: held?.jobs ?? [] });
        changed();
      }
      const fresh = eligible.filter((id) => !committed.has(id));
      if (!fresh.length || status === 'busy' || status === 'stopping') return;
      if (!child && !spawnChild(c, 'work')) return;
      writeTurn(eligible);
    } catch (e) {
      // A broken config.yml fails every poll: log and broadcast the error once, not every 2 s.
      const message = `daemon tick failed: ${(e as Error).message}`;
      if (message !== lastError) {
        lastError = message;
        logEvent('error', { message });
        changed();
      }
      return;
    }
    if (lastError?.startsWith('daemon tick failed')) {
      lastError = null;
      changed();
    }
  }

  function writeTurn(ids: string[]): void {
    // tick() only calls this once a child is running, and its stdin is a pipe.
    child!.stdin!.write(TURN_LINE);
    status = 'busy';
    inFlight = ids;
    turns++;
    info = { ...info, lastTurnAt: now() };
    persist();
    clearIdle();
    logEvent('turn', { requests: ids.length });
    changed();
  }

  return {
    start(reason = 'start') {
      if (closed) return state();
      // Before reading config, so a change in between fails spawnChild's comparison instead of being blessed.
      const snapshot = trustDigest(root);
      const c = config();
      const current = readInfo(f.info);
      if (current.serverPid && current.serverPid !== process.pid && pidAlive(current.serverPid)) {
        wanted = false;
        lastError = `another forge dash (pid ${current.serverPid}) owns the daemon`;
        changed();
        return state();
      }
      wanted = true;
      lastError = null;
      failures = 0;
      // Never while a child lives: that would bless a change its current turn made.
      if (!child) trusted = snapshot;
      if (!pollTimer) {
        pollTimer = setInterval(tick, pollMs);
        pollTimer.unref?.();
      }
      if (!child && status !== 'stopping') spawnChild(c, reason);
      tick();
      return state();
    },
    async stop(reason = 'stop') {
      wanted = false;
      await kill('stop', false, reason);
      return state();
    },
    poke() {
      tick();
    },
    state,
    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    /** Buffered lines after `afterSeq`; all of them when it is missing or ahead of us (a restarted server). */
    recent(afterSeq) {
      if (afterSeq === undefined || !Number.isFinite(afterSeq) || afterSeq > seq) return ring.slice();
      return ring.filter((r) => r.seq > afterSeq);
    },
    async close() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      wanted = false;
      await kill('stop', false);
      closed = true;
      subscribers.clear();
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
      if (child) killTree(child, 'SIGTERM');
    },
  };
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
function splitter(max: number, onLine: (line: string) => void, onTooLong: ((bytes: number) => void) | null): (data: Buffer | string) => void {
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
