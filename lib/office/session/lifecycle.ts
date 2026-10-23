// One supervised headless session. `forge dash` runs a pool of these (lib/office/pool.ts): one for
// the inbox and one per job with work. Each is a long-lived `claude -p --input-format stream-json`
// child that, whenever its pool sees new work for its scope, gets the one fixed `/forge requests`
// turn. A session never runs agents or writes job state itself: the claude child does, through the
// same claims and CLI as a human's session. docs/ARCHITECTURE.md "Daemon" and "Daemon security"
// describe the rules this file keeps.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TRUST_ENV } from '#core/config/load.ts';
import { UUID, logBaseOf, readInfo, sessionFiles } from '#core/job/session-files.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, SCOPE_ENV, validJobId } from '#core/job/requests.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { now } from '#core/utils.ts';
import { apiKeyVars, buildArgv, commandPermissionMode, sessionEnv } from '#integrations/claude/argv.ts';
import type { ChildMeta, DaemonChild, Session, SessionContext, SessionCore, SessionOptions } from './contract.ts';
import { TURN_LINE, cap, createControl } from './control.ts';
import { LIMIT_TEXT, parseRateLimit, routeHolds } from './holds.ts';
import type { RateLimitInfo } from './holds.ts';
import { checkLaunch } from './launch.ts';
import { STDERR_CAP, createSessionLog, splitter, stamped } from './log.ts';
import { createOwned } from './owned.ts';
import { withSessionId } from './records.ts';
import { createTimers } from './timers.ts';
import type { Config, DaemonSessionState, DaemonStatus, Effort } from '#core/types.ts';

/** Why the supervisor stopped: shown in the dashboard, so it speaks to the human. */
export const TRUST_CHANGED =
  'daemon stopped: .forge/config.yml, .forge/trackers/ or .forge/verifiers/ changed while it was running. The session can write files in this checkout, so only a human may approve that change: review `git diff .forge/`, then start the daemon again.';

const MAX_FAILURES = 3;

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
  let held: 'budget' | 'repo-budget' | null = null;
  let waiting = false;
  let failures = 0;
  /** Request ids a working turn has already covered; pruned to ids still pending. */
  const committed = new Set<string>();
  let inFlight: string[] = [];
  /** No turn is written before this time (ms): set by a failed turn, cleared by a working one or a human start. */
  let retryAt: number | null = null;
  /** Failed turns in a row (any kind): the backoff exponent. */
  let turnFailures = 0;
  /** Failed turns in a row that were not a quota limit: at MAX_FAILURES the session stops wanting itself. */
  let strikes = 0;
  /** The last rate_limit_event of the turn in flight. */
  let rateLimit: RateLimitInfo | null = null;
  /** A session that stopped on its own says so; a job scope's stop is recorded on the job. Never throws. */
  const announceStop = (reason: 'failed-turns' | 'failed-starts') => {
    try {
      o.notify(root, ['daemon-stopped'], { job: scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE && validJobId(scope) ? scope : null, reason });
    } catch {}
  };
  /** Last computed by refreshKept: running agents of its job keep it. */
  let kept: 'agents' | null = null;
  let closed = false;
  /**
   * The mode the current child runs in: the one it was launched with until claude reports one (it
   * does so only at its first turn's init), then claude's word. Never null while a child runs, so a
   * refused switch can't make the pool forget a more permissive launch mode.
   */
  let liveMode: string | null = null;
  /** The --effort the current child was spawned with (null: none passed). A later change waits for the next spawn. */
  let spawnEffort: Effort | null = null;

  // Never recreate a repo that was deleted under a running supervisor (or a test's temp repo).
  const persist = () => {
    if (fs.existsSync(root)) writeJsonAtomic(f.info, info);
  };
  const changed = () => ctx.emit({ kind: 'state', scope, state: state() });

  const core: SessionCore = {
    root,
    scope,
    ctx,
    o,
    files: f,
    get child() {
      return child;
    },
    get status() {
      return status;
    },
    get closed() {
      return closed;
    },
    get lastResultAt() {
      return lastResultAt;
    },
    get liveMode() {
      return liveMode;
    },
    get info() {
      return info;
    },
    set info(next) {
      info = next;
    },
    persist,
    changed,
    logEvent: (event, extra) => log.logEvent(event, extra),
    kill,
  };
  const log = createSessionLog(core);
  const { logLine, logEvent } = log;
  const { agents, computeKept, keptBy, facts, loseAgents, letGo } = createOwned(core);
  const control = createControl(core);
  const { onControl, onControlCancel, onControlResponse, setPermissionMode, answerPermission, clearModeRequests } = control;
  const { armTurn, clearTurn, armIdle, clearIdle } = createTimers(core, agents);

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
      permissions: control.permissions(),
      permissionMode: child ? liveMode : null,
      kept,
      effort: child ? spawnEffort : null,
    };
  }

  function refreshKept(): void {
    const next = computeKept();
    if (next === kept) return;
    kept = next;
    changed();
  }

  /** Its child is gone, so nothing can answer them, and nothing it reported about its mode holds. */
  function dropPrompts(): void {
    control.dropPrompts();
    liveMode = null;
  }

  /** This session can't start (its executable is missing, say): stop wanting it, and only it. */
  function sessionFatal(message: string): void {
    wanted = false;
    status = 'off';
    lastError = message;
    logEvent('error', { message });
    changed();
  }

  function spawnChild(c: Config, reason?: string): boolean {
    if (child) return true;
    if (closed) return false;
    const launch = checkLaunch(root, ctx, o);
    if (!launch) return false;
    c = launch.config;
    log.armRotation(c.retention?.logMaxBytes);
    // The record is a local file anyone with repo access can edit; only a uuid may follow --resume.
    const resume = Boolean(info.resumable && typeof info.sessionId === 'string' && UUID.test(info.sessionId));
    if (!resume) info = { ...withSessionId(info, crypto.randomUUID()), resumable: false };
    let argv;
    const launchMode = ctx.permissionMode(scope);
    // From the config bytes just hashed (never a second read) and the job.json read now, so a change made since the last spawn applies.
    const effort = ctx.effort(scope, c);
    try {
      argv = buildArgv(c.daemon.command, { pluginRoot: PLUGIN_ROOT, session: { id: info.sessionId, resume }, allowedTools: c.daemon.allowedTools, permissionMode: launchMode, effort: effort.level });
    } catch (e) {
      ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    let c2;
    try {
      // The scope reaches the session only through its environment, never stdin or argv.
      c2 = o.spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sessionEnv(o.env, c.daemon.auth), [TRUST_ENV]: launch.trusted, [SCOPE_ENV]: scope } });
    } catch (e) {
      sessionFatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    // _forge is attached on the next lines, before anything reads it.
    const proc = c2 as DaemonChild;
    child = proc;
    status = 'idle';
    waiting = false;
    liveMode = launchMode ?? commandPermissionMode(c.daemon.command);
    spawnEffort = effort.level;
    clearModeRequests();
    const meta: ChildMeta = { resume, stdout: false, init: false, result: false, asked: false, committed: [], background: null, reason: null };
    proc._forge = meta;
    info = { ...info, pid: proc.pid ?? null, serverPid: process.pid, argv0: argv[0], startedAt: now(), spawnSessionId: info.sessionId };
    persist();
    logEvent('spawn', { pid: proc.pid ?? null, sessionId: info.sessionId, resume, ...(reason ? { reason } : {}) });
    logEvent('effort', { level: effort.level ?? 'inherit', source: effort.source });
    const keys = apiKeyVars(o.env);
    if (keys.length) logEvent('auth', { auth: c.daemon.auth, vars: keys, passed: c.daemon.auth === 'api-key' });

    proc.on('error', (e: Error) => {
      if (child !== proc) return;
      if (!proc.pid) {
        // Never started (ENOENT, EACCES): retrying can't help, so stop wanting this session.
        child = null;
        clearIdle();
        clearTurn();
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
    const ok = ev && typeof ev === 'object' ? logLine(stamped(ev, line)) : logLine(JSON.stringify({ type: 'forge-raw', at: now(), text: line }));
    if (!ok) log.backpressure(proc);
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
    if (ev.type === 'system' && ev.subtype === 'init' && status === 'idle' && meta.result) {
      // A turn nobody wrote: a background agent finished and its notification woke the orchestrator.
      // init alone is the signal, so a stray line after a result can never leave the session busy.
      status = 'busy';
      clearIdle();
      // A woken turn can hang like a written one, and a busy session counts as driving its job.
      armTurn(proc);
      logEvent('wake');
      kept = computeKept();
      changed();
    }
    if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && ev.session_id && ev.session_id !== info.sessionId) {
      // It becomes the value after --resume on the next spawn, so it must be a uuid, never a flag.
      if (!UUID.test(ev.session_id)) return void logEvent('error', { message: `ignored a non-uuid session_id: ${JSON.stringify(ev.session_id.slice(0, 80))}` });
      const from = info.sessionId;
      info = withSessionId(info, ev.session_id);
      persist();
      logEvent('session-changed', { from, to: ev.session_id });
      changed();
    }
    // claude reports its mode at each turn's init and in a status event after every switch.
    if (ev.type === 'system' && (ev.subtype === 'init' || ev.subtype === 'status') && typeof ev.permissionMode === 'string') {
      const mode = cap(ev.permissionMode, 40);
      if (mode !== liveMode) {
        liveMode = mode;
        changed();
      }
    }
    if (ev.type === 'system' && ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) {
      // The reconciler reads it (facts): an idle session with none left and agents marked running is undriven.
      meta.background = ev.tasks.length;
    }
    if (ev.type === 'control_request') onControl(proc, ev);
    if (ev.type === 'control_response') onControlResponse(ev);
    if (ev.type === 'control_cancel_request') onControlCancel(ev);
    if (ev.type === 'rate_limit_event') rateLimit = parseRateLimit(ev.rate_limit_info) ?? rateLimit;
    if (ev.type === 'result') onResult(proc, ev);
  }

  function onResult(proc: DaemonChild, ev: Record<string, any>): void {
    proc._forge.result = true;
    failures = 0;
    // A result clears errors from earlier exits and failed turns; a refusal or fatal error stays.
    if (lastError && /^(daemon exited|last turn failed)/.test(lastError)) lastError = null;
    const ids = inFlight;
    inFlight = [];
    lastResultAt = now();
    if (status === 'busy') status = 'idle';
    clearTurn();
    kept = computeKept();
    if (ev.is_error === true) failedTurn(proc, ev, ids);
    else {
      proc._forge.committed.push(...ids);
      for (const id of ids) committed.add(id);
      turnFailures = 0;
      strikes = 0;
      retryAt = null;
    }
    logEvent('result', { turns });
    changed();
    if (status === 'idle') {
      try {
        armIdle(ctx.config());
      } catch {}
    }
    ctx.onResult(scope);
  }

  /**
   * claude reports an API failure (an expired login, an exhausted quota) as a result with is_error,
   * often with subtype "success": the session is alive but no request made progress. Nothing is
   * committed, so the requests stay fresh, and the session waits before its next turn: until the
   * rate-limit window resets when claude said which one refused it, otherwise with a doubling
   * backoff. A limit is retried for as long as it takes; any other error strikes out at MAX_FAILURES.
   */
  function failedTurn(proc: DaemonChild, ev: Record<string, any>, ids: string[]): void {
    const why = (typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : String(ev.subtype ?? 'error')).slice(0, 300);
    const meta = proc._forge;
    const t = Date.now();
    if (meta.resume && !meta.init) {
      // A lost transcript on --resume prints this result and exits 1; onExit then starts over and
      // clears the wait. The wait only guards against a child that stays up without ever initialising.
      retryAt = t + o.retryMinMs;
      lastError = `last turn failed: ${why}`;
      return;
    }
    const rejected = rateLimit?.status === 'rejected';
    const reset = rejected && rateLimit!.resetsAt !== null && rateLimit!.resetsAt > t ? rateLimit!.resetsAt : null;
    const limit = rejected || LIMIT_TEXT.test(why);
    turnFailures++;
    if (!limit) strikes++;
    if (!limit && strikes >= MAX_FAILURES) {
      wanted = false;
      retryAt = null;
      lastError = `daemon stopped after ${MAX_FAILURES} failed turns: ${why}`;
      logEvent('error', { message: lastError });
      announceStop('failed-turns');
      // The child would otherwise sit idle in a slot other jobs could use.
      void kill('stop', true, 'failed-turns');
      return;
    }
    // A limit with no reset time (a spend cap's 400, say) starts its backoff higher: retrying sooner can't help.
    const backoff = Math.min(o.retryMaxMs, o.retryMinMs * (limit ? 5 : 1) * 2 ** (turnFailures - 1));
    retryAt = reset ?? t + backoff;
    const at = new Date(retryAt).toISOString();
    lastError = `last turn failed: ${why}; retry at ${at}`;
    logEvent('retry', { at, reason: limit ? 'limit' : 'error', attempt: turnFailures, requests: ids.length });
  }

  function onExit(proc: DaemonChild, code: number | null, signal: string | null): void {
    if (child !== proc) return;
    try {
      exited(proc, code, signal);
    } finally {
      // Last, once this session's own state is settled: the pool reconciles the job and ticks.
      if (!closed) ctx.onExit(scope);
    }
  }

  function exited(proc: DaemonChild, code: number | null, signal: string | null): void {
    const meta = proc._forge;
    child = null;
    clearIdle();
    clearTurn();
    dropPrompts();
    inFlight = [];
    status = 'off';
    kept = null;
    info = { ...info, pid: null };
    persist();
    logEvent('exit', { code, signal });
    loseAgents();
    letGo(meta.reason ?? `exited (code ${code}, signal ${signal})`);
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
      retryAt = null;
      logEvent('resume-failed', { sessionId: info.sessionId, code });
      info = { ...withSessionId(info, crypto.randomUUID()), resumable: false };
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
      announceStop('failed-starts');
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
    proc._forge.reason = reason ?? event;
    clearIdle();
    clearTurn();
    status = 'stopping';
    kept = null;
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
      kept = null;
      dropPrompts();
      info = { ...info, pid: null };
      persist();
      loseAgents();
      letGo(proc._forge.reason ?? event);
      if (!closed) ctx.onExit(scope);
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
    rateLimit = null;
    retryAt = null;
    turns++;
    info = { ...info, lastTurnAt: now() };
    persist();
    clearIdle();
    armTurn(child!);
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
    get kept() {
      return kept;
    },
    refreshKept,
    keptBy,
    state,
    facts,
    route(c, pending, repo = null) {
      const ids = new Set(pending.map((r) => r.id));
      for (const id of committed) if (!ids.has(id)) committed.delete(id);
      const { held: next, eligible } = routeHolds(root, c, pending, repo);
      if (next !== held) {
        held = next;
        logEvent('held', { held: next });
        changed();
      }
      // Backing off after a failed turn: the requests stay fresh, the turn just waits.
      if (retryAt !== null && Date.now() < retryAt) return { eligible, fresh: false };
      return { eligible, fresh: eligible.some((id) => !committed.has(id)) };
    },
    spawn: spawnChild,
    writeTurn,
    answerPermission,
    setPermissionMode,
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
      turnFailures = 0;
      strikes = 0;
      retryAt = null;
      lastError = null;
      changed();
    },
    recent: log.recent,
    async close() {
      await kill('stop', false);
      closed = true;
      clearIdle();
      clearTurn();
      // Only our own record: a refused start must not clear the owning server's pid.
      if (info.serverPid === process.pid) {
        info = { ...info, pid: null, serverPid: null };
        persist();
      }
      await log.close();
    },
    /** Last resort from a process `exit` handler: synchronous, so it can't wait for the grace period. */
    killSync() {
      if (child) o.killTree(child, 'SIGTERM');
    },
  };
}
