// @ts-check
// The opt-in headless orchestrator. `forge dash` supervises one long-lived
// `claude -p --input-format stream-json` session and, whenever new inbox work appears, writes it
// the one fixed `/forge requests` turn. The daemon never runs agents or writes job state itself:
// the session it supervises does, through the same claims and CLI as a human's session.
// docs/ARCHITECTURE.md "Daemon" and "Daemon security" describe the rules this file keeps.
import { spawn as nodeSpawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effectiveLimits, exceededKeys, measureBudget } from './budget.mjs';
import { daemonProblems, loadConfig as defaultLoadConfig } from './config.mjs';
import { loadJob } from './jobs.mjs';
import { PLUGIN_ROOT, paths } from './paths.mjs';
import { listRequests } from './requests.mjs';
import { now, run, sleepSync, splitWords, writeJsonAtomic } from './util.mjs';
import { pidAlive } from './worktree.mjs';

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
export const HOLD_TYPES = ['resume', 'rework', 'answer', 'revise-spec'];

const RING_SIZE = 200;
const STDERR_CAP = 4096;
const MAX_FAILURES = 3;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `daemon.command` split into words; see splitWords in lib/util.mjs. @param {string} template @returns {string[]} */
export function parseTemplate(template) {
  return splitWords(template, 'daemon.command');
}

/**
 * Placeholders expand after splitting, so a plugin path with spaces stays one argument.
 * @param {string} template
 * @param {{pluginRoot:string, session:{id:string, resume:boolean}, allowedTools:string[]}} vars
 * @returns {string[]}
 */
export function buildArgv(template, vars) {
  const tools = (vars.allowedTools ?? []).join(',');
  return parseTemplate(template).flatMap((tok) => {
    if (tok === '{session}') return [vars.session.resume ? '--resume' : '--session-id', vars.session.id];
    return [tok.replaceAll('{pluginRoot}', vars.pluginRoot).replaceAll('{allowedTools}', tools)];
  });
}

/**
 * A request is held while its job is parked on a budget that is still exceeded; once a human
 * raises or acknowledges it, the request becomes eligible on the next tick.
 * @param {string} root @param {any} config @param {any} rec
 */
export function heldByBudget(root, config, rec) {
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

/** @param {string} root */
function files(root) {
  const dir = paths(root).runtime;
  return { dir, info: path.join(dir, 'daemon.json'), log: path.join(dir, 'daemon.log') };
}

/** A corrupt daemon.json is treated as absent rather than wedging the dashboard. @param {string} file */
function readInfo(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

/** @param {any} child @param {NodeJS.Signals} signal */
function defaultKillTree(child, signal) {
  if (process.platform === 'win32') return void child.kill(signal);
  // The child leads its own group (detached), so the group signal reaches whatever it started.
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      process.kill(child.pid, signal);
    } catch {}
  }
}

/** @param {number} pid @param {NodeJS.Signals} signal */
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch {}
}

/** @param {string} file @param {any} line */
function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(line) + '\n');
  } catch {}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLAUDE_EXE = /^(?:.*[\\/])?claude(?:\.exe)?$/;
/** How far the process's start time may be from the recorded `startedAt` (ps reports whole seconds). */
const START_SLACK_MS = 30_000;

/**
 * Whether `pid` is provably the claude child a supervisor recorded in daemon.json. That file
 * lives in the repo's runtime dir, so it is checked rather than trusted: the process must lead
 * its own group (we spawn detached), not be us or our group, have started when the record says,
 * and run the recorded claude executable with the recorded session uuid as its session flag.
 * @param {any} info @param {number} pid
 */
function isOurChild(info, pid) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const ids = [info.sessionId, info.spawnSessionId].filter((s) => typeof s === 'string' && UUID.test(s));
  if (!ids.length || typeof info.argv0 !== 'string' || !CLAUDE_EXE.test(info.argv0) || !Date.parse(info.startedAt)) return false;
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
 * @param {string} root @param {{graceMs?:number}} [opts]
 * @returns {{reaped:boolean, pid:number|null}}
 */
export function reapOrphan(root, opts = {}) {
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

/**
 * @typedef {{kind:'line', seq:number, line:string} | {kind:'state', state:any}} DaemonEvent
 * @typedef {{
 *   spawn?: typeof nodeSpawn, killTree?: (child:any, signal:NodeJS.Signals)=>void,
 *   pollMs?: number, graceMs?: number, maxLineBytes?: number, rotateBytes?: number,
 *   env?: NodeJS.ProcessEnv, openLog?: (file:string)=>any, loadConfig?: (root:string)=>{config:any},
 * }} DaemonOptions
 */

/**
 * @param {string} root @param {DaemonOptions} [opts]
 */
export function createDaemon(root, opts = {}) {
  const spawn = opts.spawn ?? nodeSpawn;
  const killTree = opts.killTree ?? defaultKillTree;
  const pollMs = opts.pollMs ?? 2000;
  const graceMs = opts.graceMs ?? 5000;
  const maxLineBytes = opts.maxLineBytes ?? 8 * 1024 * 1024;
  const rotateBytes = opts.rotateBytes ?? 20 * 1024 * 1024;
  const env = opts.env ?? process.env;
  const openLog = opts.openLog ?? ((/** @type {string} */ file) => fs.createWriteStream(file, { flags: 'a' }));
  const readConfig = opts.loadConfig ?? defaultLoadConfig;
  const f = files(root);

  reapOrphan(root, { graceMs });
  /** @type {any} */
  let info = { sessionId: null, resumable: false, pid: null, serverPid: null, argv0: null, startedAt: null, lastTurnAt: null, ...readInfo(f.info) };

  let enabled = false;
  let wanted = false;
  /** @type {'off'|'idle'|'busy'|'stopping'} */
  let status = 'off';
  /** @type {any} */
  let child = null;
  let turns = 0;
  /** @type {string|null} */
  let lastResultAt = null;
  /** @type {string|null} */
  let lastError = null;
  /** @type {{reason:'budget', jobs:string[]}|null} */
  let held = null;
  let failures = 0;
  /** Request ids a finished turn has already covered; pruned to ids still pending. */
  const committed = new Set();
  /** @type {string[]} */
  let inFlight = [];
  /** @type {any} */
  let sink = null;
  /** @type {{seq:number, line:string}[]} */
  const ring = [];
  let seq = 0;
  /** @type {Set<(e:DaemonEvent)=>void>} */
  const subscribers = new Set();
  /** @type {NodeJS.Timeout|null} */
  let pollTimer = null;
  /** @type {NodeJS.Timeout|null} */
  let idleTimer = null;
  let closed = false;

  const persist = () => writeJsonAtomic(f.info, info);
  const emit = (/** @type {DaemonEvent} */ e) => {
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

  function logSink() {
    if (!sink) {
      fs.mkdirSync(f.dir, { recursive: true });
      sink = openLog(f.log);
      sink.on?.('error', () => {});
    }
    return sink;
  }

  /** Appends one line to daemon.log and the replay ring; returns the sink's write() result. @param {string} line */
  function logLine(line) {
    const ok = logSink().write(line + '\n');
    seq++;
    ring.push({ seq, line });
    if (ring.length > RING_SIZE) ring.shift();
    emit({ kind: 'line', seq, line });
    return ok;
  }

  /** @param {string} event @param {Record<string, any>} [extra] */
  const logEvent = (event, extra = {}) => logLine(JSON.stringify({ type: 'forge-daemon', at: now(), event, ...extra }));

  function state() {
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

  function config() {
    const { config: c } = readConfig(root);
    enabled = c.daemon?.enabled === true;
    return c;
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  /** @param {any} c */
  function armIdle(c) {
    clearIdle();
    const minutes = c?.daemon?.idleStopMinutes;
    if (typeof minutes !== 'number' || !(minutes > 0)) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (status === 'idle' && child) void kill('idle-stop', true);
    }, minutes * 60_000);
    idleTimer.unref?.();
  }

  /** @param {string} message */
  function fatal(message) {
    wanted = false;
    status = 'off';
    lastError = message;
    logEvent('error', { message });
    changed();
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

  /** @param {any} c @returns {boolean} whether a child is now running */
  function spawnChild(c) {
    if (c.daemon?.enabled !== true) {
      fatal('daemon.enabled is false in .forge/config.yml');
      return false;
    }
    const problem = daemonProblems(c)[0];
    if (problem) {
      fatal(problem);
      return false;
    }
    rotate();
    const resume = Boolean(info.resumable && info.sessionId);
    if (!resume) info = { ...info, sessionId: crypto.randomUUID(), resumable: false };
    let argv;
    try {
      argv = buildArgv(c.daemon.command, { pluginRoot: PLUGIN_ROOT, session: { id: info.sessionId, resume }, allowedTools: c.daemon.allowedTools });
    } catch (e) {
      fatal(`cannot start daemon: ${/** @type {Error} */ (e).message}`);
      return false;
    }
    let c2;
    try {
      // This plugin's bin/ goes first on PATH, so the session's `forge` is the same version as the
      // supervisor's even when another Forge install is on PATH (seen in the AC18 headless run).
      const PATH = [path.join(PLUGIN_ROOT, 'bin'), env.PATH].filter(Boolean).join(path.delimiter);
      c2 = spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env, PATH, FORGE_DAEMON: '1' } });
    } catch (e) {
      fatal(`cannot start daemon: ${/** @type {Error} */ (e).message}`);
      return false;
    }
    const proc = c2;
    child = proc;
    status = 'idle';
    /** init: a system/init was seen (claude emits one as each turn starts); committed: ids its results covered */
    const meta = { resume, stdout: false, init: false, result: false, asked: false, committed: /** @type {string[]} */ ([]) };
    proc._forge = meta;
    info = { ...info, pid: proc.pid ?? null, serverPid: process.pid, argv0: argv[0], startedAt: now(), spawnSessionId: info.sessionId };
    persist();
    logEvent('spawn', { pid: proc.pid ?? null, sessionId: info.sessionId, resume });

    proc.on('error', (/** @type {Error} */ e) => {
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
    proc.stdin?.on('error', (/** @type {Error} */ e) => {
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
    proc.on('close', (/** @type {number|null} */ code, /** @type {string|null} */ signal) => onExit(proc, code, signal));
    armIdle(c);
    changed();
    return true;
  }

  /** @param {any} proc @param {string} line */
  function onStdout(proc, line) {
    const meta = proc._forge;
    let ev = null;
    try {
      ev = JSON.parse(line);
    } catch {}
    const ok = ev && typeof ev === 'object' ? logLine(line) : logLine(JSON.stringify({ type: 'forge-raw', at: now(), text: line }));
    if (!ok && proc.stdout && !proc.stdout.isPaused()) {
      proc.stdout.pause();
      logSink().once('drain', () => proc.stdout.resume());
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
      const from = info.sessionId;
      info = { ...info, sessionId: ev.session_id };
      persist();
      logEvent('session-changed', { from, to: ev.session_id });
      changed();
    }
    if (ev.type === 'result') onResult(proc);
  }

  /** @param {any} proc */
  function onResult(proc) {
    proc._forge.result = true;
    proc._forge.committed.push(...inFlight);
    failures = 0;
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

  /** @param {any} proc @param {number|null} code @param {string|null} signal */
  function onExit(proc, code, signal) {
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
          fatal(`cannot start daemon: ${/** @type {Error} */ (e).message}`);
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

  /** Stops the current child: SIGTERM to its group, SIGKILL after graceMs. @param {string} event @param {boolean} endStdin */
  async function kill(event, endStdin) {
    const proc = child;
    if (!proc) {
      status = 'off';
      changed();
      return;
    }
    proc._forge.asked = true;
    clearIdle();
    status = 'stopping';
    logEvent(event, { pid: proc.pid ?? null });
    changed();
    const closedP = new Promise((resolve) => proc.once('close', () => resolve(true)));
    const wait = (/** @type {number} */ ms) => Promise.race([closedP, new Promise((r) => setTimeout(() => r(false), ms))]);
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

  function tick() {
    if (!wanted || closed) return;
    try {
      const c = config();
      const pending = listRequests(root, { status: 'pending' });
      const ids = new Set(pending.map((r) => r.id));
      for (const id of committed) if (!ids.has(id)) committed.delete(id);
      const heldJobs = new Set();
      const eligible = [];
      for (const r of pending) {
        if (heldByBudget(root, c, r)) heldJobs.add(r.job);
        else eligible.push(r.id);
      }
      const nextHeld = heldJobs.size ? { reason: /** @type {'budget'} */ ('budget'), jobs: [...heldJobs].sort() } : null;
      if (JSON.stringify(nextHeld) !== JSON.stringify(held)) {
        held = nextHeld;
        logEvent('held', { jobs: held?.jobs ?? [] });
        changed();
      }
      const fresh = eligible.filter((id) => !committed.has(id));
      if (!fresh.length || status === 'busy' || status === 'stopping') return;
      if (!child && !spawnChild(c)) return;
      writeTurn(eligible);
    } catch (e) {
      lastError = `daemon tick failed: ${/** @type {Error} */ (e).message}`;
      logEvent('error', { message: lastError });
      changed();
    }
  }

  /** @param {string[]} ids */
  function writeTurn(ids) {
    child.stdin.write(TURN_LINE);
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
    /** @param {string} [_reason] */
    start(_reason = 'start') {
      if (closed) return state();
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
      if (!pollTimer) {
        pollTimer = setInterval(tick, pollMs);
        pollTimer.unref?.();
      }
      if (!child && status !== 'stopping') spawnChild(c);
      tick();
      return state();
    },
    /** @param {string} [_reason] */
    async stop(_reason = 'stop') {
      wanted = false;
      await kill('stop', false);
      return state();
    },
    poke() {
      tick();
    },
    state,
    /** @param {(e:DaemonEvent)=>void} fn */
    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    /** Buffered lines after `afterSeq`; all of them when it is missing or ahead of us (a restarted server). @param {number} [afterSeq] */
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

/**
 * Byte-capped line splitter, so one runaway line can't grow memory without bound. A line longer
 * than `max` is dropped up to its newline and reported through `onTooLong`; with no
 * `onTooLong` its first `max` bytes are kept instead.
 * @param {number} max @param {(line:string)=>void} onLine @param {((bytes:number)=>void)|null} onTooLong
 */
function splitter(max, onLine, onTooLong) {
  /** @type {Buffer[]} */
  let parts = [];
  let size = 0;
  let dropping = false;
  let dropped = 0;
  return (/** @type {Buffer|string} */ data) => {
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
