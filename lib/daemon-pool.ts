// The session pool `forge dash` supervises when `daemon.enabled`: one inbox session for requests
// with no job, plus up to `daemon.maxConcurrent` job sessions, each spawned on demand for the job
// its requests name. Sessions fail, hold and stop on their own (lib/daemon.ts); the pool owns what
// is repo-wide: the trust snapshot, routing, the cap and the stops config changes force.
// docs/ARCHITECTURE.md "Daemon" describes the rules.
import { trustDigest } from './config.ts';
import { PERMISSION_MODES, TRUST_CHANGED, UUID, commandPermissionMode, createSession, otherOwner, readInfo, reapOrphans, sessionFiles, sessionOptions } from './daemon.ts';
import type { DaemonOptions, Session, SessionContext, SessionEvent } from './daemon.ts';
import { loadJob } from './jobs.ts';
import { INBOX_SCOPE, listRequests, requestScope, validScope } from './requests.ts';
import type { Config, DaemonPermissionMode, DaemonPoolState, DaemonSessionState, ForgeRequest, PermissionDecision } from './types.ts';

/** The pool's own state: state() below. The server adds `clients` to make a DaemonPoolState. */
export type PoolState = Omit<DaemonPoolState, 'clients'>;

/** The pool createPool returns: one per `forge dash`. */
export interface DaemonPool {
  start(reason?: string): PoolState;
  stop(reason?: string): Promise<PoolState>;
  /** Re-enables one session inside a wanted pool; `error` when the pool isn't wanted. */
  startSession(scope: string): { error: string | null };
  stopSession(scope: string): Promise<PoolState>;
  /** Answers one session's permission prompt; false when there is no such prompt. */
  answerPermission(scope: string, id: string, decision: PermissionDecision): boolean;
  /** Puts one session in a permission mode: now if its child runs, else from its next spawn. */
  setPermissionMode(scope: string, mode: DaemonPermissionMode): { error: string | null };
  poke(): void;
  state(): PoolState;
  sessionState(scope: string): DaemonSessionState;
  subscribe(fn: (e: SessionEvent) => void): () => void;
  recent(scope: string, afterOffset?: number): { offset: number; line: string }[];
  close(): Promise<void>;
  killSync(): void;
}

const FINISHED = ['done', 'cancelled', 'failed'];

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
  };
}

export function createPool(root: string, opts: DaemonOptions = {}): DaemonPool {
  const o = sessionOptions(opts);
  const pollMs = opts.pollMs ?? 2000;
  reapOrphans(root, { graceMs: o.graceMs });

  let enabled = false;
  let maxConcurrent = 1;
  let wanted = false;
  let lastError: string | null = null;
  /** trustDigest taken when a human (dashboard or `forge dash`) last started the pool. */
  let trusted: string | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let closed = false;
  /** A pool start brings the inbox up even without work, as the one-session daemon did. */
  let inboxEager = false;
  let startReason = 'start';
  const sessions = new Map<string, Session>();
  /**
   * Modes a human chose in the dashboard, by scope; only those that differ from daemon.command's.
   * In memory on purpose: a session can write files in the repo, runtime records included, so a
   * mode read back from disk would be one the session could pick for itself.
   */
  const modes = new Map<string, DaemonPermissionMode>();
  let baseMode = 'default';
  const subscribers = new Set<(e: SessionEvent) => void>();

  const emit = (e: SessionEvent) => {
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {}
    }
  };

  const ctx: SessionContext = {
    trusted: () => trusted,
    poolWanted: () => wanted && !closed,
    config,
    untrusted: () => poolStop(TRUST_CHANGED, 'trust'),
    fatal: (message) => poolStop(message, 'fatal'),
    emit,
    onResult,
    poke: () => tick(),
    permissionMode: (scope) => modes.get(scope) ?? null,
    permissionModeRefused(scope, mode, live) {
      // The refused choice may be daemon.command's own mode, which holds no entry; a later choice wins.
      if ((modes.get(scope) ?? baseMode) !== mode) return;
      // Show what the session is really in rather than a choice claude turned down.
      const kept = PERMISSION_MODES.find((m) => m === live);
      if (kept && kept !== baseMode) modes.set(scope, kept);
      else modes.delete(scope);
    },
  };

  function session(scope: string): Session {
    let s = sessions.get(scope);
    if (!s) {
      s = createSession(root, scope, ctx, o);
      sessions.set(scope, s);
    }
    return s;
  }
  const inbox = session(INBOX_SCOPE);
  const jobSessions = () => [...sessions.values()].filter((s) => s.scope !== INBOX_SCOPE);

  function config(): Config {
    const { config: c } = o.readConfig(root);
    enabled = c.daemon?.enabled === true;
    const m = c.daemon?.maxConcurrent;
    // An out-of-range value is a daemonProblems refusal at spawn; until then count it as 1.
    maxConcurrent = Number.isInteger(m) && m >= 1 && m <= 16 ? m : 1;
    baseMode = commandPermissionMode(c.daemon?.command);
    return c;
  }
  try {
    config();
  } catch {}

  /** Config is repo-wide, so a trust change or a config refusal stops every session. */
  function poolStop(message: string, reason: string): void {
    wanted = false;
    inboxEager = false;
    lastError = message;
    for (const s of sessions.values()) {
      s.logEvent('error', { message });
      s.setWaiting(false);
    }
    for (const s of sessions.values()) void s.kill('stop', false, reason);
  }

  function onResult(scope: string): void {
    if (scope !== INBOX_SCOPE && !closed) {
      let state: string | null = null;
      try {
        state = loadJob(root, scope).state;
      } catch {}
      const s = sessions.get(scope);
      if (s && (state === null || FINISHED.includes(state)) && !listRequests(root, { status: 'pending' }).some((r) => requestScope(root, r) === scope)) {
        s.logEvent('finished', { state: state ?? 'missing' });
        // Its kill pokes the pool once the slot is free.
        void s.kill('stop', true, 'job-finished');
        return;
      }
    }
    tick();
  }

  function tick(): void {
    if (!wanted || closed) return;
    try {
      const c = config();
      if (trustDigest(root) !== trusted) return poolStop(TRUST_CHANGED, 'trust');
      const groups = new Map<string, ForgeRequest[]>();
      for (const r of listRequests(root, { status: 'pending' })) {
        const scope = requestScope(root, r);
        const g = groups.get(scope);
        if (g) g.push(r);
        else groups.set(scope, [r]);
      }
      for (const scope of groups.keys()) session(scope);
      if (inboxEager && inbox.wanted && !inbox.running && inbox.status !== 'stopping') {
        inboxEager = false;
        inbox.spawn(c, startReason);
        if (!wanted) return;
      }
      const waiters: { s: Session; eligible: string[]; oldest: string }[] = [];
      for (const s of [...sessions.values()]) {
        if (!wanted) return;
        const routed = groups.get(s.scope) ?? [];
        const { eligible, fresh } = s.route(c, routed);
        if (!fresh || !s.wanted) {
          s.setWaiting(false);
          continue;
        }
        if (s.status === 'busy' || s.status === 'stopping') continue;
        if (s.running) s.writeTurn(eligible);
        else if (s.scope === INBOX_SCOPE) {
          // The inbox is never counted against the cap.
          if (s.spawn(c, 'work')) {
            inboxEager = false;
            s.writeTurn(eligible);
          }
        } else waiters.push({ s, eligible, oldest: routed[0].id });
      }
      // Slots go to the job whose oldest pending request is oldest (request ids sort by time).
      waiters.sort((a, b) => a.oldest.localeCompare(b.oldest));
      let live = jobSessions().filter((s) => s.running).length;
      for (const w of waiters) {
        if (!wanted) return;
        if (live < maxConcurrent) {
          if (w.s.spawn(c, 'work')) {
            live++;
            w.s.writeTurn(w.eligible);
          }
        } else w.s.setWaiting(true);
      }
      for (const s of jobSessions()) if (s.running) s.refreshKept();
      // Each waiting job gets the slot of an idle session (oldest result first), unless one is already being freed.
      // A session whose job has agents running, or that just finished a turn or an agent, keeps its slot.
      const short = waiters.filter((w) => w.s.waiting).length - jobSessions().filter((s) => s.status === 'stopping').length;
      if (short > 0) {
        const idle = jobSessions()
          .filter((s) => s.status === 'idle' && s.keptBy(o.slotGraceMs) === null)
          .sort((a, b) => (a.lastResultAt ?? '').localeCompare(b.lastResultAt ?? ''));
        for (const s of idle.slice(0, short)) void s.kill('idle-stop', true, 'slot');
      }
      prune(groups);
    } catch (e) {
      // A broken config.yml fails every poll: log the error once, not every 2 s.
      const message = `daemon tick failed: ${(e as Error).message}`;
      if (message !== lastError) {
        lastError = message;
        inbox.logEvent('error', { message });
      }
      return;
    }
    if (lastError?.startsWith('daemon tick failed')) lastError = null;
  }

  /**
   * Drops job sessions that are off and clean, so the pool doesn't grow with every job ever run.
   * A session with requests still routed to it stays: its committed set is what stops a
   * repeated turn. Its files stay too, for resume and the log viewer.
   */
  function prune(groups: Map<string, ForgeRequest[]>): void {
    for (const [scope, s] of sessions) {
      if (scope === INBOX_SCOPE || groups.has(scope) || s.running || s.status !== 'off' || s.waiting || s.held || s.lastError || !s.wanted) continue;
      sessions.delete(scope);
      void s.close();
    }
  }

  /** A job session worth showing in the dashboard's pool bar. */
  const listed = (s: Session) => s.running || s.status === 'stopping' || s.waiting || s.held !== null || s.lastError !== null || (!s.wanted && wanted);

  function state(): PoolState {
    const jobs: Record<string, DaemonSessionState> = {};
    for (const s of jobSessions().sort((a, b) => (a.scope < b.scope ? -1 : 1))) if (listed(s)) jobs[s.scope] = s.state();
    return {
      enabled,
      wanted,
      maxConcurrent,
      live: jobSessions().filter((s) => s.running).length,
      lastError,
      inbox: inbox.state(),
      jobs,
      permissionMode: baseMode,
      permissionModes: Object.fromEntries([...modes].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
  }

  return {
    start(reason = 'start') {
      if (closed) return state();
      // Before reading config, so a change in between fails the spawn's comparison instead of being blessed.
      const snapshot = trustDigest(root);
      config();
      const owner = otherOwner(root);
      if (owner !== null) {
        wanted = false;
        lastError = `another forge dash (pid ${owner}) owns the daemon`;
        return state();
      }
      wanted = true;
      lastError = null;
      for (const s of sessions.values()) s.reset();
      // Never while a child lives: that would bless a change its current turn made.
      if (![...sessions.values()].some((s) => s.running)) trusted = snapshot;
      if (!pollTimer) {
        pollTimer = setInterval(tick, pollMs);
        pollTimer.unref?.();
      }
      inboxEager = true;
      startReason = reason;
      tick();
      return state();
    },
    async stop(reason = 'stop') {
      wanted = false;
      inboxEager = false;
      for (const s of sessions.values()) s.setWaiting(false);
      await Promise.all([...sessions.values()].map((s) => s.kill('stop', false, reason)));
      return state();
    },
    startSession(scope) {
      if (!validScope(scope)) return { error: 'invalid scope' };
      if (!wanted || closed) return { error: 'start the daemon first' };
      session(scope).reset();
      if (scope === INBOX_SCOPE) inboxEager = true;
      tick();
      return { error: null };
    },
    async stopSession(scope) {
      if (!validScope(scope)) return state();
      // Kept even without a child: a job a human stopped spawns nothing until they start it again.
      const s = session(scope);
      s.setWanted(false);
      if (scope === INBOX_SCOPE) inboxEager = false;
      await s.kill('stop', false, 'human');
      return state();
    },
    answerPermission(scope, id, decision) {
      return sessions.get(scope)?.answerPermission(id, decision) ?? false;
    },
    setPermissionMode(scope, mode) {
      if (!validScope(scope)) return { error: 'invalid scope' };
      if (!PERMISSION_MODES.includes(mode)) return { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` };
      if (closed) return { error: 'the dashboard is shutting down' };
      if (mode === baseMode) modes.delete(scope);
      else modes.set(scope, mode);
      const s = sessions.get(scope);
      s?.logEvent('permission-mode-set', { mode });
      // A running child switches now; claude confirms with a status event, which updates its state.
      s?.setPermissionMode(mode);
      return { error: null };
    },
    poke() {
      tick();
    },
    state,
    sessionState(scope) {
      return sessions.get(scope)?.state() ?? offState(root, scope);
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => void subscribers.delete(fn);
    },
    recent(scope, afterOffset) {
      return sessions.get(scope)?.recent(afterOffset) ?? [];
    },
    async close() {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      wanted = false;
      closed = true;
      await Promise.all([...sessions.values()].map((s) => s.close()));
      subscribers.clear();
    },
    /** Last resort from a process `exit` handler: synchronous, so it can't wait for the grace period. */
    killSync() {
      for (const s of sessions.values()) s.killSync();
    },
  };
}
