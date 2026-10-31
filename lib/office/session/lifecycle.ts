// One supervised headless session. `forge dash` runs a pool of these (lib/office/pool.ts): one for the inbox and one per job
// with work. Each is a long-lived `claude -p --input-format stream-json` child that, whenever its pool sees new work for its
// scope, gets the one fixed `/forge requests` turn; a chat's session gets the owner's message instead (writeChat). A session
// never runs agents or writes job state itself: the claude child does, through the same claims and CLI as a human's session.
// It never reads claude's output either: it reacts to the ClaudeEvents lib/integrations/claude/ reports.
// docs/architecture/daemon-runtime.md and daemon-security.md describe the rules this file keeps.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TRUST_ENV } from '#core/config/load.ts';
import { UUID, logBaseOf, readInfo, sessionFiles } from '#core/job/session-files.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { SCOPE_ENV, isChatScope, sharedScope, validJobId } from '#core/job/requests.ts';
import { ForgeError } from '#core/errors.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { now } from '#core/utils.ts';
import { billingOf, buildArgv, commandPermissionMode, sessionEnv } from '#integrations/claude/argv.ts';
import type { ClaudeChild, ClaudeEvent } from '#integrations/claude/types.ts';
import type { ChildMeta, DaemonChild, Session, SessionContext, SessionCore, SessionOptions } from './contract.ts';
import { budgetStopMessage, spawnBudgetCap } from './budget-cap.ts';
import { createControl } from './permissions/control.ts';
import { createMeter } from './meter.ts';
import { routeHolds } from './holds.ts';
import { confineDigest, spawnConfinement } from './confine.ts';
import { chatPrompt, checkLaunch } from './launch.ts';
import { createSessionLog } from './log.ts';
import { createOwned } from './owned.ts';
import { withSessionId } from './records.ts';
import { createFreshness, createTimers } from './timers.ts';
import type { Config, DaemonSessionState, DaemonStatus, Effort } from '#core/types.ts';

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
  let waitingFor: DaemonSessionState['waitingFor'] = null;
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
  /** A session that stopped on its own says so; a job scope's stop is recorded on the job. Never throws. */
  const announceStop = (reason: 'failed-turns' | 'failed-starts' | 'daily-cap') => {
    try {
      o.notify(root, ['daemon-stopped'], { job: !sharedScope(scope) && validJobId(scope) ? scope : null, reason });
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
  /** The --max-budget-usd the current child was spawned with (null: none passed), for the stop message. */
  let spawnCap: number | null = null;

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
  const { agents, computeKept, keptBy, facts, release, takeUp } = createOwned(core);
  const control = createControl(core);
  const { setPermissionMode, answerPermission, clearModeRequests } = control;
  const { armTurn, clearTurn, armIdle, clearIdle } = createTimers(core, agents);
  const fresh = createFreshness(core, agents);
  const meter = createMeter(core, stopSelf);

  function state(): DaemonSessionState {
    return {
      scope,
      wanted,
      running: Boolean(child),
      status,
      sessionId: info.sessionId ?? null,
      pid: child?.claude.pid ?? null,
      lastTurnAt: info.lastTurnAt ?? null,
      lastResultAt,
      turns,
      failures,
      held,
      waiting: waitingFor !== null, waitingFor,
      lastError,
      permissions: control.permissions(),
      timedOut: control.timedOut(),
      permissionMode: child ? liveMode : null,
      kept,
      effort: child ? spawnEffort : null,
      contextTokens: child ? fresh.context() : null,
    };
  }

  function refreshKept(): void {
    const next = computeKept();
    if (next === kept) return;
    kept = next;
    changed();
  }

  /** This session can't start (its executable is missing, say): stop wanting it, and only it. */
  function sessionFatal(message: string): void {
    wanted = false;
    status = 'off';
    lastError = message;
    logEvent('error', { message });
    changed();
  }

  /** The session stops its child and says why; unless keepWanted, it stops wanting itself until a human starts it. */
  function stopSelf(message: string, reason: string, announce: 'failed-turns' | 'daily-cap' | null, keepWanted = false): void {
    if (!keepWanted) wanted = false;
    retryAt = null;
    lastError = message;
    logEvent('error', { message });
    if (announce) announceStop(announce);
    changed();
    void kill('stop', true, reason);
  }

  function spawnChild(c: Config, reason?: string): boolean {
    if (child) return true;
    if (closed) return false;
    const launch = checkLaunch(root, ctx, o);
    if (!launch) return false;
    c = launch.config;
    log.armRotation(c.retention?.logMaxBytes);
    const resume = fresh.resumes(info);
    if (!resume) info = { ...withSessionId(info, crypto.randomUUID()), resumable: false };
    let argv;
    let confined: ReturnType<typeof spawnConfinement>;
    const launchMode = ctx.permissionMode(scope);
    // From the config bytes just hashed (never a second read) and the job.json read now, so a change made since the last spawn applies.
    const effort = ctx.effort(scope, c);
    const model = ctx.model(scope, c);
    const base = meter.spawned(c, resume);
    if (base === null) return false;
    const cap = spawnBudgetCap(root, scope, c, base);
    try {
      confined = spawnConfinement(root, c);
      const { roots, deny } = confined;
      const vars = { allowedTools: c.daemon.allowedTools, permissionMode: launchMode, effort: effort.level, model, writeRoots: [roots.jobs, ...roots.worktrees], deny, maxBudgetUsd: cap, appendSystemPrompt: chatPrompt(scope), mcpConfig: ctx.browser(scope) };
      argv = buildArgv(c.daemon.command, { pluginRoot: PLUGIN_ROOT, session: { id: info.sessionId, resume }, ...vars });
    } catch (e) {
      ctx.fatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    const meta: ChildMeta = { resume, stdout: false, init: false, result: false, asked: false, committed: [], background: null, reason: null };
    // Assigned as soon as start returns, before any event arrives.
    let proc!: DaemonChild;
    let claude: ClaudeChild;
    try {
      // The scope reaches the session only through its environment, never stdin or argv.
      const env = { ...sessionEnv(o.env, c.daemon.auth), ...confined.env, [TRUST_ENV]: launch.trusted, [SCOPE_ENV]: scope };
      claude = o.claude.start(argv, { cwd: root, env, maxLineBytes: o.maxLineBytes }, (e) => onEvent(proc, e));
    } catch (e) {
      sessionFatal(`cannot start daemon: ${(e as Error).message}`);
      return false;
    }
    proc = { claude, meta };
    child = proc;
    status = 'idle';
    waitingFor = null;
    liveMode = launchMode ?? commandPermissionMode(c.daemon.command);
    spawnEffort = effort.level;
    spawnCap = cap;
    clearModeRequests();
    info = { ...info, pid: claude.pid, serverPid: process.pid, argv0: argv[0], startedAt: now(), spawnSessionId: info.sessionId };
    persist();
    logEvent('spawn', { pid: claude.pid, sessionId: info.sessionId, resume, capUsd: cap, model: model ?? 'inherit', ...(reason ? { reason } : {}) });
    logEvent('effort', { level: effort.level ?? 'inherit', source: effort.source });
    const billing = billingOf(o.env, c.daemon.auth);
    if (billing) logEvent('auth', { auth: c.daemon.auth, ...billing });
    armIdle(c);
    changed();
    return true;
  }

  /** What one of the child's events changes. A log line is always logged; the rest count only from the current child. */
  function onEvent(proc: DaemonChild, e: ClaudeEvent): void {
    if (e.kind === 'log') {
      if (!logLine(e.line) && e.stream === 'stdout') log.backpressure(proc.claude);
      if (e.stream === 'stdout' && child === proc && !proc.meta.stdout) {
        proc.meta.stdout = true;
        if (!info.resumable) {
          info = { ...info, resumable: true };
          persist();
        }
      }
      return;
    }
    if (child !== proc) return;
    const meta = proc.meta;
    switch (e.kind) {
      case 'turn-started':
        meta.init = true;
        if (status === 'idle' && meta.result) {
          // A turn nobody wrote: a background agent finished and its notification woke the orchestrator.
          // turn-started alone is the signal, so a stray line after a result can never leave the session busy.
          status = 'busy';
          clearIdle();
          // A woken turn can hang like a written one, and a busy session counts as driving its job.
          armTurn(proc);
          logEvent('wake');
          kept = computeKept();
          changed();
        }
        return;
      case 'session-id': {
        if (e.id === info.sessionId) return;
        // It becomes the value after --resume on the next spawn, so it must be a uuid, never a flag.
        if (!UUID.test(e.id)) return void logEvent('error', { message: `ignored a non-uuid session id: ${JSON.stringify(e.id.slice(0, 80))}` });
        const from = info.sessionId;
        info = withSessionId(info, e.id);
        persist();
        logEvent('session-changed', { from, to: e.id });
        return changed();
      }
      case 'permission-mode':
        if (e.mode === liveMode) return;
        liveMode = e.mode;
        return changed();
      case 'background':
        // The reconciler reads it (facts): an idle session with none left and agents marked running is undriven.
        meta.background = e.count;
        return;
      case 'permission-asked':
        return control.onAsked(proc.claude, e);
      case 'permission-cancelled':
        return control.onCancelled(e.requestId);
      case 'mode-answer':
        return control.onModeAnswer(e);
      case 'turn-ended':
        return onResult(proc, e);
      case 'protocol-error':
        return logEvent('error', { message: e.message });
      case 'line-too-long':
        return logEvent('line-truncated', { bytes: e.bytes });
      case 'stdin-error':
        return logEvent('error', { message: `stdin: ${e.message}` });
      case 'process-error':
        if (e.started) return logEvent('error', { message: e.message });
        // Never started (ENOENT, EACCES): retrying can't help, so stop wanting this session.
        child = null;
        clearIdle();
        clearTurn();
        inFlight = [];
        info = { ...info, pid: null };
        persist();
        return sessionFatal(`cannot start daemon: ${e.message}`);
      case 'exit':
        return onExit(proc, e.code, e.signal);
    }
  }

  function onResult(proc: DaemonChild, e: Extract<ClaudeEvent, { kind: 'turn-ended' }>): void {
    const stop = meter.result(e, turns);
    proc.meta.result = true;
    failures = 0;
    // A result clears errors from earlier exits, failed turns and a cleared budget stop; a refusal or fatal error stays.
    if (lastError && /^(daemon exited|last turn failed|daemon stopped: this job's metered)/.test(lastError)) lastError = null;
    const ids = inFlight;
    inFlight = [];
    lastResultAt = now();
    if (status === 'busy') status = 'idle';
    clearTurn();
    kept = computeKept();
    if (e.ok === false) failedTurn(proc, e, ids);
    else {
      proc.meta.committed.push(...ids);
      for (const id of ids) committed.add(id);
      takeUp(ids);
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
    // The post-turn check: a protected path this turn changed (through forge, git or a nested CLAUDE.md) stops the pool.
    let same = false;
    try {
      same = confineDigest(root, ctx.config()) === ctx.confined();
    } catch {}
    if (!same) return ctx.untrusted();
    if (stop) stopSelf(stop.message, stop.reason, stop.announce, stop.keepWanted);
    fresh.result(e);
    ctx.onResult(scope);
  }

  /**
   * A failed turn (an expired login, an exhausted quota): the session is alive but no request made
   * progress. Nothing is committed, so the requests stay fresh, and the session waits before its next
   * turn: until the quota window resets when claude said when, otherwise with a doubling backoff. A
   * limit is retried for as long as it takes; any other error strikes out at MAX_FAILURES.
   */
  function failedTurn(proc: DaemonChild, e: { reason: string; limit: boolean; resetsAt: number | null; budget: boolean }, ids: string[]): void {
    const why = e.reason;
    const meta = proc.meta;
    const t = Date.now();
    if (meta.resume && !meta.init) {
      // A lost transcript on --resume prints this result and exits 1; onExit then starts over and
      // clears the wait. The wait only guards against a child that stays up without ever initialising.
      retryAt = t + o.retryMinMs;
      lastError = `last turn failed: ${why}`;
      return;
    }
    const { limit } = e;
    const reset = e.resetsAt !== null && e.resetsAt > t ? e.resetsAt : null;
    turnFailures++;
    // Reaching the dollar cap stops at once: every later turn of this child would hit it again.
    if (!limit) strikes = e.budget ? MAX_FAILURES : strikes + 1;
    // Stopped, because the child would otherwise sit idle in a slot other jobs could use.
    if (!limit && strikes >= MAX_FAILURES) return stopSelf(e.budget ? budgetStopMessage(spawnCap ?? 0) : `daemon stopped after ${MAX_FAILURES} failed turns: ${why}`, e.budget ? 'budget-cap' : 'failed-turns', 'failed-turns');
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

  /**
   * The child is gone, whether it exited or a kill never saw it close: this session's own state
   * settles first, then the one release of what its ids held. Both paths call it exactly once.
   */
  function gone(reason: string): void {
    child = null;
    kept = null;
    clearIdle();
    clearTurn();
    // Its child is gone, so nothing can answer its prompts, and nothing it reported about its mode holds.
    control.dropPrompts();
    liveMode = null;
    inFlight = [];
    status = 'off';
    info = { ...info, pid: null };
    persist();
    release(reason);
  }

  function exited(proc: DaemonChild, code: number | null, signal: string | null): void {
    const meta = proc.meta;
    logEvent('exit', { code, signal });
    gone(meta.reason ?? `exited (code ${code}, signal ${signal})`);
    if (meta.asked) {
      // A failed turn's error describes the process just stopped on purpose; the log keeps it.
      // Clearing it lets a finished or slot-stopped session be pruned instead of showing failing forever.
      if (lastError?.startsWith('last turn failed')) lastError = null;
      return changed();
    }
    if (meta.resume && !meta.init && code !== 0 && code !== null) {
      // The transcript is gone (or unreadable): start over once rather than counting a failure.
      // Real claude still ends the turn, failed (error_during_execution), before exiting 1, so the
      // test is "no turn-started", and whatever that turn committed is undone: no turn actually ran.
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
    proc.meta.asked = true;
    proc.meta.reason = reason ?? event;
    clearIdle();
    clearTurn();
    status = 'stopping';
    kept = null;
    logEvent(event, { pid: proc.claude.pid, ...(reason ? { reason } : {}) });
    changed();
    const closedP = proc.claude.closed.then(() => true);
    const wait = (ms: number) => {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise((r) => (timer = setTimeout(() => r(false), ms)));
      // Cleared once the child closes, so a pending grace timer never holds the process open.
      return Promise.race([closedP, timeout]).finally(() => clearTimeout(timer));
    };
    if (endStdin) proc.claude.endInput();
    proc.claude.signal('SIGTERM');
    if (!(await wait(o.graceMs))) {
      proc.claude.signal('SIGKILL');
      await wait(o.graceMs);
    }
    if (child === proc) {
      // No close event at all (a stuck pipe): treat it as gone so the supervisor can't wedge.
      gone(proc.meta.reason ?? event);
      if (!closed) ctx.onExit(scope);
    }
    if (!child) status = 'off';
    changed();
    // A start that arrived while this child was stopping, or a job waiting for this slot, gets its session now.
    if (!closed) ctx.poke();
  }

  /** Hands the child a turn: the fixed one for `ids`, or (writeChat) one owner `message`, which only a running chat session takes; a refusal throws, writing nothing. */
  function writeTurn(ids: string[], message?: string): void {
    // The pool only calls this once a child is running.
    if (message === undefined) child!.claude.writeTurn();
    else if (!isChatScope(scope) || !child?.claude.writeMessage(message)) throw new ForgeError(`no owner message was written to ${scope}: only a running chat session takes one, of 1 to 8000 characters`);
    status = 'busy';
    inFlight = ids;
    retryAt = null;
    turns++;
    info = { ...info, lastTurnAt: now() };
    persist();
    clearIdle();
    armTurn(child!);
    // Never the text: the chat log holds the owner's message.
    logEvent('turn', { requests: ids.length, turn: turns, ...(message === undefined ? {} : { chat: true }) });
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
      return waitingFor !== null;
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
    writeTurn: (ids) => writeTurn(ids),
    writeChat: (text) => writeTurn([], typeof text === 'string' ? text : ''),
    answerPermission,
    setPermissionMode,
    kill,
    logEvent,
    setWaiting(w, machineCap = null) {
      const next = !w ? null : machineCap === null ? 'project' : 'machine';
      if (next === waitingFor) return;
      if ((waitingFor = next)) logEvent('waiting', { cap: next, maxConcurrent: next === 'machine' ? machineCap : (ctx.config().daemon?.maxConcurrent ?? null) });
      changed();
    },
    setWanted(w) {
      if (w === wanted) return;
      wanted = w;
      if (!w) waitingFor = null;
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
      if (child) child.claude.signal('SIGTERM');
    },
  };
}
