// One supervised headless session. `forge dash` runs a pool of these (lib/office/pool.ts): one for
// the inbox and one per job with work. Each is a long-lived `claude -p --input-format stream-json`
// child that, whenever its pool sees new work for its scope, gets the one fixed `/forge requests`
// turn. A session never runs agents or writes job state itself: the claude child does, through the
// same claims and CLI as a human's session. docs/ARCHITECTURE.md "Daemon" and "Daemon security"
// describe the rules this file keeps.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { TRUST_ENV, daemonProblems, defaults, trackerSymlinks, trustDigest } from '#core/config/load.ts';
import { UUID, logBaseOf, readInfo, sessionFiles } from '#core/job/session-files.ts';
import { expireLease, markAgentsLost, requeueOrphanedRequests } from '#core/job/store.ts';
import type { SessionFacts } from '../reconcile.ts';
import { redactKnown } from '#engine/guard/known-secrets.ts';
import { PLUGIN_ROOT, paths } from '#core/paths.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, SCOPE_ENV, validJobId } from '#core/job/requests.ts';
import { sessionAgents } from '../session-agents.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { now } from '#core/utils.ts';
import { PERMISSION_MODES, apiKeyVars, buildArgv, commandPermissionMode, modeReach, sessionEnv } from '#integrations/claude/argv.ts';
import type { ChildMeta, DaemonChild, LogSink, Session, SessionContext, SessionOptions } from './contract.ts';
import { MAX_PROMPTS, PROMPT_INPUT_CHARS, PROMPT_PATH_CHARS, PROMPT_TEXT_CHARS, TURN_LINE, cap, modeRequest, permissionResponse, record, ruleText, sessionGrant } from './control.ts';
import type { SessionGrant } from './control.ts';
import { LIMIT_TEXT, heldByBudget, heldByRepoBudget, parseRateLimit } from './holds.ts';
import type { RateLimitInfo } from './holds.ts';
import { RING_SIZE, STDERR_CAP, capLine, splitter, stamped } from './log.ts';
import { withSessionId } from './records.ts';
import type { Config, DaemonPermissionMode, DaemonPermissionPrompt, DaemonSessionState, DaemonStatus, Effort, EventActor, PermissionDecision } from '#core/types.ts';

/** Why the supervisor stopped: shown in the dashboard, so it speaks to the human. */
export const TRUST_CHANGED =
  'daemon stopped: .forge/config.yml, .forge/trackers/ or .forge/verifiers/ changed while it was running. The session can write files in this checkout, so only a human may approve that change: review `git diff .forge/`, then start the daemon again.';

/** The summary an agent gets when its session's child exits under it. */
export const LOST_SUMMARY = 'lost: its daemon session ended';

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
  let sink: LogSink | null = null;
  /** Offset of the next line: logBase plus its byte position in <scope>.log. */
  let pos = info.logBase;
  /** retention.logMaxBytes as of the last spawn: rotate mid-session at this size. null rotates only at spawn. */
  let rotateAt: number | null = null;
  /** A session that stopped on its own says so; a job scope's stop is recorded on the job. Never throws. */
  const announceStop = (reason: 'failed-turns' | 'failed-starts') => {
    try {
      o.notify(root, ['daemon-stopped'], { job: scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE && validJobId(scope) ? scope : null, reason });
    } catch {}
  };
  /** Resumes stdout paused on a full sink; a rotation ends that sink, which then never drains. */
  let resumeStdout: (() => void) | null = null;
  const ring: { offset: number; line: string }[] = [];
  let idleTimer: NodeJS.Timeout | null = null;
  /** When the idle timer was last armed (spawn or result), in ms. */
  let idleSince = 0;
  /** Last computed by refreshKept: running agents of its job keep it. */
  let kept: 'agents' | null = null;
  let closed = false;
  /** Permission prompts waiting on a human, by the supervisor's id, oldest first. */
  const prompts = new Map<string, { proc: DaemonChild; requestId: string; input: Record<string, unknown>; grant: SessionGrant; prompt: DaemonPermissionPrompt }>();
  /**
   * The mode the current child runs in: the one it was launched with until claude reports one (it
   * does so only at its first turn's init), then claude's word. Never null while a child runs, so a
   * refused switch can't make the pool forget a more permissive launch mode.
   */
  let liveMode: string | null = null;
  /** Mode switches sent to the current child and not yet answered, by request id, each with its confirmation deadline. */
  const modeRequests = new Map<string, { mode: DaemonPermissionMode; timer: NodeJS.Timeout }>();
  /** The --effort the current child was spawned with (null: none passed). A later change waits for the next spawn. */
  let spawnEffort: Effort | null = null;
  /** Armed at each written turn, cleared by its result or the child's exit: daemon.turnTimeoutMinutes. */
  let turnTimer: NodeJS.Timeout | null = null;

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
  function logLine(raw: string): boolean {
    // Before the offset is taken: the ring, the SSE frame and the file all carry the same redacted bytes.
    let line = raw;
    try {
      line = redactKnown(raw, o.redactor(root, scope, ctx.config()));
    } catch {}
    const s = logSink();
    const offset = pos;
    const ok = s.write(line + '\n');
    pos += Buffer.byteLength(line) + 1;
    ring.push({ offset, line: capLine(line) });
    if (ring.length > RING_SIZE) ring.shift();
    ctx.emit({ kind: 'line', scope, offset, line });
    // The ended sink flushes what it holds, so the caller has nothing to wait for.
    if (rotateAt !== null && pos - info.logBase >= rotateAt && rotate(rotateAt)) return true;
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
      permissions: [...prompts.values()].map((p) => p.prompt),
      permissionMode: child ? liveMode : null,
      kept,
      effort: child ? spawnEffort : null,
    };
  }

  const agents = (at?: number) => sessionAgents(root, scope, typeof info.sessionId === 'string' ? info.sessionId : null, at);

  function computeKept(): 'agents' | null {
    return child && status !== 'stopping' && agents().keeps ? 'agents' : null;
  }

  function refreshKept(): void {
    const next = computeKept();
    if (next === kept) return;
    kept = next;
    changed();
  }

  /**
   * The child is gone, so every agent it drove is too: marking them lost lets the next session's
   * step respawn or retry them instead of waiting on phantoms. Only agents of a job this session
   * owns (sessionAgents), so another driver's agents are never touched. Never throws: an exit
   * must finish whatever job.json says.
   */
  function loseAgents(): void {
    if (!fs.existsSync(root)) return;
    try {
      const { running } = agents();
      if (!running.length) return;
      let cfg: Config;
      try {
        cfg = o.readConfig(root).config;
      } catch {
        cfg = defaults();
      }
      const roles = markAgentsLost(root, scope, running, LOST_SUMMARY, cfg, info.sessionId);
      if (roles.length) logEvent('agents-lost', { roles });
    } catch (e) {
      logEvent('error', { message: `marking agents lost: ${(e as Error).message}` });
    }
  }

  function keptBy(at = Date.now()): 'agents' | null {
    return agents(at).keeps ? 'agents' : null;
  }

  /** Every id this scope's sessions ran under: current, past and the one its child was spawned with. */
  function sessionIds(): string[] {
    const ids = [info.sessionId, info.spawnSessionId, ...(Array.isArray(info.pastSessionIds) ? info.pastSessionIds : [])];
    return [...new Set(ids.filter((s): s is string => typeof s === 'string' && UUID.test(s)))];
  }

  function facts(): SessionFacts {
    const background = child?._forge.background;
    return { ids: sessionIds(), status, background: typeof background === 'number' ? background : -1, idleSince: status === 'idle' ? lastResultAt : null };
  }

  /**
   * The child is gone, so nothing it held is driven: its job's lease expires when one of its ids
   * drives it (driver and epoch kept: anyone may now claim), and requests it claimed go back to
   * pending (lib/core/job/requests.ts requeueOrphans). Never throws: an exit must finish.
   */
  function letGo(reason: string): void {
    if (!fs.existsSync(root)) return;
    const ids = sessionIds();
    if (scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE && validJobId(scope)) {
      try {
        const session = expireLease(root, scope, ids, reason);
        if (session) logEvent('lease-expired', { session, reason });
      } catch (e) {
        logEvent('error', { message: `expiring the lease: ${(e as Error).message}` });
      }
    }
    try {
      // No claim-age rule here: this session can't see which of the pool's others are mid-turn; the pool's reconciler can.
      const { requeued, rejected } = requeueOrphanedRequests(root, { exited: ids, byAge: false });
      if (requeued.length || rejected.length) logEvent('requeued', { requests: requeued.map((r) => r.id), rejected: rejected.map((r) => r.id) });
    } catch (e) {
      logEvent('error', { message: `requeueing claimed requests: ${(e as Error).message}` });
    }
  }

  function clearTurn(): void {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
  }

  /**
   * A turn still busy past daemon.turnTimeoutMinutes (or turnTimeoutMs) is stopped: the exit lets go
   * of its agents, lease and claims, and the session stays wanted, so the pool respawns it for the
   * requeued work. setTimeout is monotonic, so a wall-clock jump never fires it.
   */
  function armTurn(proc: DaemonChild): void {
    clearTurn();
    let ms = o.turnTimeoutMs;
    if (ms === null) {
      let minutes: unknown;
      try {
        minutes = ctx.config().daemon?.turnTimeoutMinutes;
      } catch {}
      if (typeof minutes !== 'number' || !(minutes > 0)) return;
      ms = minutes * 60_000;
    }
    // setTimeout's own ceiling (about 24.8 days); a longer limit is no limit.
    if (!(ms > 0) || ms > 2 ** 31 - 1) return;
    const limit = ms;
    turnTimer = setTimeout(() => {
      turnTimer = null;
      if (closed || child !== proc || status !== 'busy') return;
      logEvent('turn-timeout', { minutes: Math.round((limit / 60_000) * 1000) / 1000 });
      void kill('stop', true, 'turn-timeout');
    }, limit);
    turnTimer.unref?.();
  }

  /** Its child is gone, so nothing can answer them, and nothing it reported about its mode holds. */
  function dropPrompts(): void {
    prompts.clear();
    clearModeRequests();
    liveMode = null;
  }

  function clearModeRequests(): void {
    for (const r of modeRequests.values()) clearTimeout(r.timer);
    modeRequests.clear();
  }

  function writeControl(proc: DaemonChild, line: string): void {
    proc.stdin?.write(line);
  }

  /**
   * A `control_request` from claude. `can_use_tool` becomes a prompt the dashboard shows until a
   * human answers it; claude sends no other subtype unless asked to, so any other gets an error
   * rather than leaving claude waiting.
   */
  function onControl(proc: DaemonChild, ev: Record<string, any>): void {
    const requestId = ev.request_id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) return void logEvent('error', { message: 'ignored a control_request without a usable request_id' });
    const req = record(ev.request);
    if (req.subtype !== 'can_use_tool') {
      const error = `forge does not handle ${String(req.subtype).slice(0, 40)} control requests`;
      return writeControl(proc, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }) + '\n');
    }
    const tool = cap(req.tool_name, 200) ?? 'unknown';
    const input = record(req.input);
    const deny = (reason: string) => {
      logEvent('permission', { tool, decision: 'deny', reason });
      writeControl(proc, permissionResponse(requestId, 'deny', input, { rules: [], dirs: [] }));
    };
    if (prompts.size >= MAX_PROMPTS) return deny('too-many');
    let json: string | undefined;
    try {
      json = JSON.stringify(input);
    } catch {}
    // The dashboard must show the whole input, because an allow runs all of it: a call it can't show
    // whole is refused rather than shown cut short, and so is one whose tool name was cut.
    if (typeof json !== 'string') return deny('unserialisable-input');
    if (json.length > PROMPT_INPUT_CHARS) return deny('too-large');
    if (tool === 'unknown' || tool.endsWith('…')) return deny('unusable-tool-name');
    const grant = sessionGrant(req.permission_suggestions);
    const id = crypto.randomUUID();
    const prompt: DaemonPermissionPrompt = {
      id,
      tool,
      input: json,
      description: cap(req.description, PROMPT_TEXT_CHARS),
      agentId: cap(req.agent_id, 64),
      blockedPath: cap(req.blocked_path, PROMPT_PATH_CHARS),
      sessionRules: grant.rules.map(ruleText),
      sessionDirs: grant.dirs,
      at: now(),
    };
    prompts.set(id, { proc, requestId, input, grant, prompt });
    logEvent('permission-asked', { id, tool });
    changed();
  }

  /** claude withdrew a request (its turn was interrupted): the prompt goes away unanswered. */
  function onControlCancel(ev: Record<string, any>): void {
    for (const [id, p] of prompts) {
      if (p.requestId !== ev.request_id) continue;
      prompts.delete(id);
      logEvent('permission-cancelled', { id, tool: p.prompt.tool });
      changed();
    }
  }

  function setPermissionMode(mode: DaemonPermissionMode): boolean {
    if (!child || !PERMISSION_MODES.includes(mode)) return false;
    const requestId = `forge-mode-${crypto.randomUUID()}`;
    const proc = child;
    const timer = setTimeout(() => {
      if (!modeRequests.delete(requestId) || child !== proc) return;
      modeFailed(mode, `claude did not confirm permission mode ${mode}`);
    }, o.modeConfirmMs);
    timer.unref?.();
    modeRequests.set(requestId, { mode, timer });
    writeControl(child, modeRequest(requestId, mode));
    logEvent('permission-mode-requested', { mode });
    return true;
  }

  /** claude's answer to a control_request the supervisor sent: only mode switches are ever sent. */
  function onControlResponse(ev: Record<string, any>): void {
    const res = record(ev.response);
    const requestId = res.request_id;
    if (typeof requestId !== 'string') return;
    const pending = modeRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    modeRequests.delete(requestId);
    const { mode } = pending;
    if (res.subtype === 'success') return void logEvent('permission-mode', { mode });
    modeFailed(mode, `claude refused permission mode ${mode}: ${cap(res.error, PROMPT_TEXT_CHARS) ?? 'no reason given'}`);
  }

  /**
   * A switch claude refused or never confirmed. One that would have widened the session falls back:
   * the dashboard shows the mode the session still runs in. One that would have narrowed it stops
   * the child instead, so the session never keeps more reach than the human chose: its next spawn
   * starts in the chosen mode.
   */
  function modeFailed(mode: DaemonPermissionMode, why: string): void {
    if (modeReach(mode) < modeReach(liveMode)) {
      logEvent('error', { message: `${why}; stopping the session so it starts in ${mode}` });
      void kill('stop', true, 'permission-mode');
      return;
    }
    logEvent('error', { message: why });
    ctx.permissionModeRefused(scope, mode, liveMode);
    changed();
  }

  function answerPermission(id: string, decision: PermissionDecision, actor?: EventActor): string | null {
    const p = prompts.get(id);
    if (!p || p.proc !== child) return null;
    prompts.delete(id);
    writeControl(p.proc, permissionResponse(p.requestId, decision, p.input, p.grant));
    logEvent('permission', { id, tool: p.prompt.tool, decision, ...(actor ? { actor } : {}) });
    changed();
    return p.prompt.tool;
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(c: Config): void {
    clearIdle();
    const minutes = c?.daemon?.idleStopMinutes;
    if (typeof minutes !== 'number' || !(minutes > 0)) return;
    idleSince = Date.now();
    idleAfter(minutes * 60_000, minutes * 60_000);
  }

  /**
   * The window counts from the later of the arming and the last agent end, and never runs out while
   * an agent keeps the session: an orchestrator waiting on background reviewers is idle, not done.
   */
  function idleAfter(delay: number, ms: number): void {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (status !== 'idle' || !child) return;
      const a = agents();
      if (a.keeps) return idleAfter(ms, ms);
      const end = a.lastEndAt ? Date.parse(a.lastEndAt) : NaN;
      const left = Math.max(idleSince, Number.isFinite(end) ? end : 0) + ms - Date.now();
      // Never longer than the window, so no job.json time can push setTimeout past its 2^31-1 ms limit.
      if (left > 0) return idleAfter(Math.min(left, ms), ms);
      void kill('idle-stop', true, 'idle');
    }, delay);
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

  /**
   * Moves <scope>.log over <scope>.log.1 once it holds at least `limit` bytes (one older generation
   * is kept), and advances logBase by its size so offsets keep growing. Returns whether it rotated.
   */
  function rotate(limit: number): boolean {
    let size: number;
    try {
      size = fs.statSync(f.log).size;
    } catch {
      return false;
    }
    // An open sink may still hold writes the file doesn't show yet; offsets must count them. Those
    // writes land in .log.1: the open descriptor follows the renamed file.
    if (sink) size = Math.max(size, pos - info.logBase);
    if (size < limit) return false;
    if (sink) {
      sink.end?.();
      sink = null;
    }
    try {
      fs.renameSync(f.log, `${f.log}.1`);
    } catch {
      return false;
    }
    info = { ...info, logBase: info.logBase + size };
    pos = info.logBase;
    persist();
    if (resumeStdout) {
      const resume = resumeStdout;
      resumeStdout = null;
      resume();
    }
    return true;
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
    const max = c.retention?.logMaxBytes;
    rotateAt = Number.isSafeInteger(max) && (max as number) > 0 ? (max as number) : null;
    // Without a limit, today's rule: past rotateBytes, and only here.
    rotate(rotateAt ?? o.rotateBytes + 1);
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
      c2 = o.spawn(argv[0], argv.slice(1), { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...sessionEnv(o.env, c.daemon.auth), [TRUST_ENV]: trusted, [SCOPE_ENV]: scope } });
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
    if (!ok && proc.stdout && !proc.stdout.isPaused()) {
      proc.stdout.pause();
      // write() returned false, so the sink is a real stream (the stand-in never does), and stdout was
      // checked just above, where the callback can't see the narrowing.
      const resume = () => {
        if (resumeStdout === resume) resumeStdout = null;
        proc.stdout!.resume();
      };
      resumeStdout = resume;
      logSink().once!('drain', resume);
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
      // The repo budget reads first when both hold: it is the one a per-job ack can't clear.
      let next: 'budget' | 'repo-budget' | null = null;
      const eligible: string[] = [];
      for (const r of pending) {
        if (heldByRepoBudget(root, repo, r)) next = 'repo-budget';
        else if (heldByBudget(root, c, r)) next ??= 'budget';
        else eligible.push(r.id);
      }
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
      clearTurn();
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
