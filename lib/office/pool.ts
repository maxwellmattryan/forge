// The session pool `forge dash` supervises when `daemon.enabled`: the intake runner (lib/office/inbox/runner.ts) that answers job-less requests in code
// (an inbox session spawns only for a type it doesn't handle), the office runner (lib/office/foreman/runs/) that runs draft and direct requests in code and
// the gate runner (lib/office/foreman/run.ts) that decides gate requests in code when `foreman.enabled`, up to `daemon.maxConcurrent` job sessions, each
// spawned on demand for its job, and a session per chat (sendChat). No session serves `_office`. Sessions fail, hold and stop on their own
// (lib/office/session/lifecycle.ts); the pool owns what is repo-wide: the trust snapshot, routing, the cap, the stops config changes force, and the
// periodic sync and Office pass children. docs/architecture/daemon.md describes the rules.
import fs from 'node:fs';
import { trustDigest } from '#core/config/load.ts';
import { confineDigest } from './session/confine.ts';
import { createSession } from './session/lifecycle.ts';
import { TRUST_CHANGED } from './session/launch.ts';
import { CHAT_START, sendChat } from './chat/send.ts';
import { runForgeCall, runPassChild, runSyncChild } from './inbox/children.ts';
import { createPassScheduler } from './mandates/cadence.ts';
import { sessionOptions, type DaemonOptions, type Session, type SessionContext, type SessionEvent } from './session/contract.ts';
import { offState, otherOwner, reapOrphans } from './session/records.ts';
import { PERMISSION_MODES } from '#integrations/claude/argv.ts';
import { createModeBook, type PoolOptions } from './modes.ts';
import { sessionBrowser, sessionEffort, sessionKind, sessionModel, startWork, type SlotMember } from './slots.ts';
import { createGateRunner } from './foreman/run.ts';
import { OFFICE_NO_SESSION, createOfficeRunner } from './foreman/runs/runner.ts';
import { createIntakeRunner, ensureIntakeSessionId, type IntakeRunner } from './inbox/runner.ts';
import { daemonSessionIds, releaseSession } from './driver.ts';
import { loadJob, logHumanEvent } from '#core/job/store.ts';
import { RECONCILE_MS, daemonLockDir, reconcile, type SessionFacts } from './reconcile.ts';
import { tryLock } from '#core/os/lock.ts';
import { createRepoBudgetMemo } from '#engine/metrics/repo-budget.ts';
import { daemonPlatformProblem } from '#core/os/platform.ts';
import { GATES_SCOPE, INBOX_SCOPE, OFFICE_SCOPE, isChatScope, listRequests, requestScope, sharedScope as shared, validScope } from '#core/job/requests.ts';
import type { Config, DaemonPermissionMode, DaemonPoolState, DaemonSessionState, EventActor, ForgeRequest, PermissionDecision } from '#core/types.ts';

/** The pool's own state: state() below. The server adds `clients` and `needsApproval` to make a DaemonPoolState. */
export type PoolState = Omit<DaemonPoolState, 'clients' | 'needsApproval'>;

/** The pool createPool returns: one per `forge dash`. */
export interface DaemonPool {
  start(reason?: string): PoolState;
  stop(reason?: string): Promise<PoolState>;
  /** Re-enables one session inside a wanted pool; `error` when the pool isn't wanted. */
  startSession(scope: string): { error: string | null };
  stopSession(scope: string): Promise<PoolState>;
  /** Stops a job's or a chat's session and forgets it, for a job about to be deleted or an archived chat. */
  dropSession(scope: string): Promise<void>;
  /** Hands an owner's message to its chat session, spawning it if none runs (lib/office/chat/send.ts); `error` when refused. */
  sendChat(scope: string, text: string): { error: string | null };
  /** Answers one session's permission prompt as `actor`; false when there is no such prompt. */
  answerPermission(scope: string, id: string, decision: PermissionDecision, actor: EventActor): boolean;
  /** Puts one session in a permission mode as `actor`: now if its child runs, else from its next spawn. */
  setPermissionMode(scope: string, mode: DaemonPermissionMode, actor: EventActor): { error: string | null };
  /** Sets the job sessions' default as `actor`: every job session without its own choice, the running ones now. */
  setJobPermissionMode(mode: DaemonPermissionMode, actor: EventActor): { error: string | null };
  poke(): void;
  /** The trustDigest the pool runs under: taken by the last start with no child alive, null before one. What a Start approves. */
  trusted(): string | null;
  state(): PoolState;
  sessionState(scope: string): DaemonSessionState;
  /** What the pool knows about one scope's session (lib/office/driver.ts whoDrives reads it), or null with none. */
  facts(scope: string): SessionFacts | null;
  subscribe(fn: (e: SessionEvent) => void): () => void;
  recent(scope: string, afterOffset?: number): { offset: number; line: string }[];
  close(): Promise<void>;
  killSync(): void;
}

const FINISHED = ['done', 'cancelled', 'failed'];
/** How often a wanted pool runs `forge sync`, so CI results and PR feedback reach the office unasked. */
const SYNC_MS = 120_000;

export function createPool(root: string, opts: PoolOptions = {}): DaemonPool {
  // Pinned: one machine server runs pools for several roots, and an inherited FORGE_ROOT must not steer a session elsewhere.
  const o = sessionOptions({ ...opts, env: { ...(opts.env ?? process.env), FORGE_ROOT: root } });
  const slots = opts.slots ?? null;
  const pollMs = opts.pollMs ?? 2000;
  const syncMs = opts.syncMs ?? SYNC_MS;
  const reconcileMs = opts.reconcileMs ?? RECONCILE_MS;
  /** Aborted by close() and killSync(): stops a running sync child (SIGTERM, then SIGKILL after graceMs). */
  const children = new AbortController();
  const runSync = opts.runSync ?? ((r: string, signal: AbortSignal) => runSyncChild(r, o.env, { signal, graceMs: o.graceMs }));
  const runPass = opts.runPass ?? ((r: string, signal: AbortSignal) => runPassChild(r, o.env, { signal, graceMs: o.graceMs }));
  const platform = opts.platform ?? process.platform;
  reapOrphans(root, { graceMs: o.graceMs });

  // A person's answer in a job's session also lands on that job's own trail (forge job audit).
  function jobAudit(scope: string, type: string, data: Record<string, unknown>, actor: EventActor): void {
    if (shared(scope)) return;
    try {
      logHumanEvent(root, scope, type, data, actor);
    } catch {} // The job vanished since the request was validated; the daemon log line still records it.
  }

  let enabled = false;
  let maxConcurrent = 1;
  let foreman = false;
  let wanted = false;
  let lastError: string | null = null;
  /** trustDigest taken when a human (dashboard or `forge dash`) last started the pool. */
  let trusted: string | null = null;
  /** confineDigest (./session/confine.ts) taken by the same start: the post-turn check's baseline. */
  let confined: string | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let syncTimer: NodeJS.Timeout | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  let lastReconcileError: string | null = null;
  /** The running sync, from runSync to the end of its handler (one at a time), and every reconcile pass not yet settled: what close() waits for. */
  let syncInFlight: Promise<void> | null = null;
  const reconciling = new Set<Promise<void>>();
  let lastSyncError: string | null = null;
  let closed = false;
  const sessions = new Map<string, Session>();
  /** `<locks>/daemon`, held from a start until stop, close or exit: one `forge dash` drives a repo. */
  let daemonLock: { release: () => void } | null = null;
  const releaseDaemonLock = () => {
    daemonLock?.release();
    daemonLock = null;
  };
  const repoBudget = createRepoBudgetMemo(root);
  const modes = createModeBook(opts.launchPermissionMode);
  const subscribers = new Set<(e: SessionEvent) => void>();

  /** The intake runner's facts over the inbox's state (set once it exists): every inbox state frame carries them. */
  let overlay: ((s: DaemonSessionState) => DaemonSessionState) | null = null;
  const emit = (e: SessionEvent) => {
    if (e.kind === 'state' && e.scope === INBOX_SCOPE && overlay) e = { ...e, state: overlay(e.state) };
    for (const fn of subscribers) {
      try {
        fn(e);
      } catch {}
    }
  };

  const ctx: SessionContext = {
    trusted: () => trusted,
    confined: () => confined,
    poolWanted: () => wanted && !closed,
    config,
    untrusted: () => poolStop(TRUST_CHANGED, 'trust'),
    fatal: (message) => poolStop(message, 'fatal'),
    emit,
    onResult,
    onExit(scope) {
      if (closed) return;
      // The exit requeued what the child claimed and expired its lease: judge its job now, then hand out the work.
      if (!shared(scope)) runReconcile(scope);
      tick();
      if (!shared(scope)) slots?.freed(member);
    },
    poke: () => tick(),
    permissionMode: (scope) => modes.launch(scope),
    permissionModeRefused: (scope, mode, live) => modes.refused(scope, mode, live),
    // Read at every spawn and never pushed to a running session: a change applies at its next spawn.
    effort: (scope, c) => sessionEffort(root, scope, c),
    model: (scope, c) => sessionModel(scope, c),
    browser: (scope) => sessionBrowser(root, scope),
  };
  // The gate and office runners decide gate requests and run draft and direct ones in code; their runs count against no cap and end with a poke.
  const gates = createGateRunner(root, { ctx, o });
  const officeRuns = createOfficeRunner(root, { ctx, o });
  // The Office pass (lib/office/mandates/cadence.ts): its child ends with a tick, so the direct request it queued becomes an office run at once.
  // runPass gets the scheduler's signal, which its abort() and close() abort; a pass that ends after close() logs nothing.
  const passes = createPassScheduler(root, { run: runPass, done: () => tick(), log: (message) => officeRuns.log('error', { message }) });

  function session(scope: string): Session {
    let s = sessions.get(scope);
    if (!s) {
      s = createSession(root, scope, ctx, o);
      sessions.set(scope, s);
    }
    return s;
  }
  // Before the inbox session reads its record, so its own writes keep the id.
  const intakeId = ensureIntakeSessionId(root);
  const inbox = session(INBOX_SCOPE);
  /** Answers the inbox's requests in code (lib/office/inbox/runner.ts), one at a time; each run ends with a poke. */
  const intake: IntakeRunner = createIntakeRunner(root, { ctx, o, runForge: opts.runForge ?? ((args, x) => runForgeCall(root, args, x)), inbox, id: intakeId, changed: () => emit({ kind: 'state', scope: INBOX_SCOPE, state: inbox.state() }) });
  overlay = intake.state;
  // Shared sessions (inbox, chats) are never job sessions: never counted against a cap, never pruned.
  const jobSessions = () => [...sessions.values()].filter((s) => !shared(s.scope));
  /** The oldest request the machine cap held at the last tick, below this pool's own cap (lib/office/slots.ts). */
  let heldOldest: string | null = null;
  const member: SlotMember = {
    live: () => jobSessions().filter((s) => s.running).length,
    maxConcurrent: () => maxConcurrent,
    oldestWaiting: () => (wanted && !closed && member.live() < maxConcurrent ? heldOldest : null),
    idle: () => jobSessions().filter((s) => s.status === 'idle' && s.keptBy() === null).map((s) => ({ lastResultAt: s.lastResultAt, stop: () => void s.kill('idle-stop', true, 'slot') })),
    stopping: () => jobSessions().filter((s) => s.status === 'stopping').length,
    poke: () => tick(),
  };
  const leave = slots?.join(member) ?? null;
  function config(): Config {
    const { config: c } = o.readConfig(root);
    enabled = c.daemon?.enabled === true;
    foreman = c.foreman?.enabled === true;
    const m = c.daemon?.maxConcurrent;
    // An out-of-range value is a daemonProblems refusal at spawn; until then count it as 1.
    maxConcurrent = Number.isInteger(m) && m >= 1 && m <= 16 ? m : 1;
    modes.setCommand(c.daemon?.command);
    gates.configure(c);
    officeRuns.configure(c);
    return c;
  }
  try {
    config();
  } catch {}

  /** Config is repo-wide, so a trust change or a config refusal stops every session. */
  function poolStop(message: string, reason: string): void {
    // Every session reports the trust change, so only the first stop of a running pool announces it.
    const announce = reason === 'trust' && wanted && !closed;
    wanted = false;
    lastError = message;
    for (const s of sessions.values()) {
      s.logEvent('error', { message });
      s.setWaiting(false);
    }
    for (const s of sessions.values()) void s.kill('stop', false, reason);
    // Live gate, intake and office runs are killed too, their claims given back uncounted.
    void Promise.all([gates.stop(), intake.stop(), officeRuns.stop()]);
    if (announce)
      try {
        o.notify(root, ['daemon-stopped'], { job: null, reason: 'trust' });
      } catch {}
  }

  function onResult(scope: string): void {
    if (!shared(scope) && !closed) {
      let state: string | null = null;
      // A done job's post-merge score run (JS1-JS3) still needs its session.
      let scoring = false;
      try {
        const job = loadJob(root, scope);
        passes.after(job);
        state = job.state;
        scoring = job.score?.status === 'queued';
      } catch {}
      const s = sessions.get(scope);
      if (s && (state === null || FINISHED.includes(state)) && !scoring && !listRequests(root, { status: 'pending' }).some((r) => requestScope(root, r) === scope)) {
        s.logEvent('finished', { state: state ?? 'missing' });
        // Its kill pokes the pool once the slot is free.
        void s.kill('stop', true, 'job-finished');
        return;
      }
      if (state === 'running') runReconcile(scope);
    }
    tick();
  }

  /** Every job session's facts, by job id: what judge (lib/office/reconcile.ts) reads beside job.json and the requests. */
  function sessionFacts(): Map<string, SessionFacts> {
    return new Map(jobSessions().map((s) => [s.scope, s.facts()]));
  }

  /**
   * One reconciler pass (lib/office/reconcile.ts), for every job or only `only`. Never throws: a failed
   * pass is logged once per distinct failure and retried at the next timer. close() waits for it.
   */
  function runReconcile(only?: string): void {
    if (closed || !fs.existsSync(root)) return;
    const pass = reconcileOnce(only).finally(() => reconciling.delete(pass));
    reconciling.add(pass);
  }
  async function reconcileOnce(only?: string): Promise<void> {
    try {
      // The inbox session, and gate, intake and office runs too: their requests have no lease, so only this keeps a long turn's claim.
      const busy = [...[...sessions.values()].filter((s) => s.status === 'busy' || s.status === 'stopping').flatMap((s) => s.facts().ids), ...gates.sessions(), ...intake.sessions(), ...officeRuns.sessions()];
      const r = await reconcile(root, config(), { facts: sessionFacts(), busy, ...(only !== undefined ? { only } : {}) });
      // The pool closed while the pass ran: the session logs it would write to are closed.
      if (closed) return;
      for (const id of r.resumed) sessions.get(id)?.logEvent('reconcile', { action: 'resume' });
      for (const id of r.escalated) sessions.get(id)?.logEvent('reconcile', { action: 'escalate' });
      lastReconcileError = null;
    } catch (e) {
      const message = `reconcile failed: ${(e as Error).message}`;
      if (message !== lastReconcileError && !closed) inbox.logEvent('error', { message });
      lastReconcileError = message;
    }
  }

  function tick(): void {
    // First: a tick that throws below (a broken config.yml) spawns nothing, so it must hold no other project's waiter.
    heldOldest = null;
    if (!wanted || closed) return;
    try {
      const c = config();
      if (trustDigest(root) !== trusted) return poolStop(TRUST_CHANGED, 'trust');
      passes.check(c);
      const groups = new Map<string, ForgeRequest[]>();
      for (const r of listRequests(root, { status: 'pending' })) {
        const scope = requestScope(root, r);
        const g = groups.get(scope);
        if (g) g.push(r);
        else groups.set(scope, [r]);
      }
      // The intake runner takes the inbox requests it handles (below); only the rest reach the inbox session.
      const handled = intake.split(groups);
      // The gate and office groups are never sessions: their runners take from them below, and while the foreman is off they wait for a person.
      for (const scope of groups.keys()) if (validScope(scope) && scope !== OFFICE_SCOPE) session(scope);
      const waiters: { s: Session; eligible: string[]; oldest: string }[] = [];
      // A chat is turned only by its owner's messages (sendChat), never by routing.
      for (const s of [...sessions.values()].filter((x) => sessionKind(x.scope) !== 'chat')) {
        if (!wanted) return;
        const routed = groups.get(s.scope) ?? [];
        // Never the inbox: job-less requests are not the repo budget's to hold.
        const { eligible, fresh } = s.route(c, routed, shared(s.scope) || !routed.length ? null : repoBudget(c));
        if (!fresh || !s.wanted) {
          s.setWaiting(false);
          continue;
        }
        if (s.status === 'busy' || s.status === 'stopping') continue;
        if (s.running) s.writeTurn(eligible);
        // The inbox is never counted against the cap.
        else if (shared(s.scope)) startWork(s, c, 'work', eligible);
        else waiters.push({ s, eligible, oldest: routed[0].id });
      }
      if (!wanted) return;
      gates.take(c, foreman ? (groups.get(GATES_SCOPE) ?? []) : []);
      officeRuns.take(c, foreman ? (groups.get(OFFICE_SCOPE) ?? []) : []);
      intake.take(c, handled);
      if (!wanted) return;
      // Slots go to the job whose oldest pending request is oldest (request ids sort by time).
      waiters.sort((a, b) => a.oldest.localeCompare(b.oldest));
      let live = jobSessions().filter((s) => s.running).length;
      let held = 0;
      for (const w of waiters) {
        if (!wanted) return;
        if (live < maxConcurrent && (!slots || slots.mayTake(member, w.oldest))) {
          if (startWork(w.s, c, 'work', w.eligible)) live++;
        } else {
          w.s.setWaiting(true);
          // Below this pool's own cap, only the machine cap holds it.
          if (live < maxConcurrent && held++ === 0) heldOldest = w.oldest;
        }
      }
      for (const s of jobSessions()) if (s.running) s.refreshKept();
      // Each waiting job gets the slot of an idle session (oldest result first), unless one is already being freed.
      // A session whose job has agents running keeps its slot.
      const short = waiters.filter((w) => w.s.waiting).length - jobSessions().filter((s) => s.status === 'stopping').length;
      if (short > 0) {
        const idle = jobSessions()
          .filter((s) => s.status === 'idle' && s.keptBy() === null)
          .sort((a, b) => (a.lastResultAt ?? '').localeCompare(b.lastResultAt ?? ''));
        for (const s of idle.slice(0, short)) void s.kill('idle-stop', true, 'slot');
        // Still short while the machine cap holds a waiter: an idle session in another project makes room.
        if (slots && held && short > idle.length) slots.reclaim(member, Math.min(held, short - idle.length));
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
   * Gate requests for PR feedback and failing checks, unparked dependents and deferred merges all
   * come from `forge sync`; without it they wait until some session happens to sync. Skipped while
   * one still runs, and while the trust snapshot is stale (tick stops the pool for that).
   */
  function periodicSync(): void {
    if (!wanted || closed || syncInFlight || !enabled) return;
    if (trustDigest(root) !== trusted) return;
    syncInFlight = runSync(root, children.signal)
      .catch((e: unknown) => (e as Error).message ?? String(e))
      .then((err) => {
        syncInFlight = null;
        // A sync the close stopped: its failure is the kill, and the inbox log is closed.
        if (closed) return;
        // Logged once per distinct failure, like a broken tick, so an offline laptop doesn't fill the log.
        if (err !== null && err !== lastSyncError) inbox.logEvent('error', { message: `periodic forge sync failed: ${err}` });
        lastSyncError = err;
        tick();
      });
  }

  /**
   * No earlier `forge dash`'s child can still run once this one holds the daemon lock and has
   * reaped orphans, so everything one of their ids held is released (lib/office/driver.ts), as
   * their exits would have. A lease held by an interactive session (in no record) is left alone.
   */
  function expireBootLeases(): void {
    const r = releaseSession(root, daemonSessionIds(root), { reason: 'dash-start', config: config(), byAge: true });
    for (const j of r.jobs) {
      if (j.lost.length) inbox.logEvent('agents-lost', { job: j.job, roles: j.lost });
      if (j.expired) inbox.logEvent('lease-expired', { job: j.job, session: j.expired, reason: 'dash-start' });
    }
    for (const message of r.errors) inbox.logEvent('error', { message });
  }

  /**
   * Drops job sessions that are off and clean, so the pool doesn't grow with every job ever run.
   * A session with requests still routed to it stays: its committed set is what stops a
   * repeated turn. Its files stay too, for resume and the log viewer.
   */
  function prune(groups: Map<string, ForgeRequest[]>): void {
    for (const [scope, s] of sessions) {
      if (shared(scope) || groups.has(scope) || s.running || s.status !== 'off' || s.waiting || s.held || s.lastError || !s.wanted) continue;
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
      inbox: intake.state(inbox.state()),
      office: officeRuns.state(),
      foreman,
      gates: gates.state(),
      jobs,
      ...modes.state(),
      machine: slots ? { maxConcurrent: slots.cap(), live: slots.live() } : null,
    };
  }

  return {
    start() {
      if (closed) return state();
      // Sessions need POSIX process groups and ps; refusing here covers every caller (boot, the API, a later start).
      const refused = daemonPlatformProblem(platform);
      if (refused) {
        wanted = false;
        lastError = refused;
        return state();
      }
      // Before reading config, so a change in between fails the spawn's comparison instead of being blessed.
      const snapshot = trustDigest(root);
      const confineSnapshot = confineDigest(root, config());
      const fresh = !daemonLock;
      if (!daemonLock) {
        // The lock, not the records, decides: two dashes started together both see no other owner in them.
        const got = tryLock(daemonLockDir(root));
        if ('holder' in got) {
          wanted = false;
          lastError = `another forge dash (pid ${got.holder.pid ?? 'unknown'}) owns the daemon`;
          return state();
        }
        daemonLock = got;
      }
      // Still asked, after the lock: an older Forge's dash takes no lock but records itself.
      const owner = otherOwner(root);
      if (owner !== null) {
        releaseDaemonLock();
        wanted = false;
        lastError = `another forge dash (pid ${owner}) owns the daemon`;
        return state();
      }
      // Only on taking the lock with none of this pool's children alive: then no session in any record still runs.
      if (fresh && ![...sessions.values()].some((s) => s.running || s.status === 'stopping') && !intake.sessions().length && !officeRuns.sessions().length) {
        reapOrphans(root, { graceMs: o.graceMs });
        expireBootLeases();
        // No earlier dash's gate or office run can still be live: what one left claimed goes back, counted.
        gates.recover();
        officeRuns.recover();
      }
      wanted = true;
      lastError = null;
      for (const s of sessions.values()) s.reset();
      // Never while a child lives: that would bless a change its current turn made.
      if (![...sessions.values()].some((s) => s.running)) {
        trusted = snapshot;
        confined = confineSnapshot;
      }
      if (!pollTimer) {
        pollTimer = setInterval(tick, pollMs);
        pollTimer.unref?.();
      }
      if (!syncTimer && syncMs > 0) {
        syncTimer = setInterval(periodicSync, syncMs);
        syncTimer.unref?.();
      }
      if (!reconcileTimer && reconcileMs > 0) {
        // runReconcile skips a closed pool itself.
        reconcileTimer = setInterval(() => void (wanted && runReconcile()), reconcileMs);
        reconcileTimer.unref?.();
      }
      passes.want();
      tick();
      return state();
    },
    async stop(reason = 'stop') {
      wanted = false;
      for (const s of sessions.values()) s.setWaiting(false);
      await Promise.all([...[...sessions.values()].map((s) => s.kill('stop', false, reason)), gates.stop(), intake.stop(), officeRuns.stop()]);
      // Unless a start came in while the sessions stopped.
      if (!wanted) releaseDaemonLock();
      return state();
    },
    startSession(scope) {
      if (!validScope(scope)) return { error: 'invalid scope' };
      if (isChatScope(scope)) return { error: CHAT_START };
      if (scope === OFFICE_SCOPE) return { error: OFFICE_NO_SESSION };
      if (!wanted || closed) return { error: 'start the daemon first' };
      session(scope).reset();
      tick();
      return { error: null };
    },
    async stopSession(scope) {
      if (!validScope(scope) || scope === OFFICE_SCOPE) return state();
      // Kept even without a child: a job a human stopped spawns nothing until they start it again.
      const s = session(scope);
      s.setWanted(false);
      // The inbox's Stop stops the intake runner too: a live run's claim goes back, and none starts until its Start.
      await Promise.all([s.kill('stop', false, 'human'), ...(scope === INBOX_SCOPE ? [intake.stop()] : [])]);
      return state();
    },
    async dropSession(scope) {
      const s = sessions.get(scope);
      if (!s || (shared(scope) && !isChatScope(scope))) return;
      await s.kill('stop', false, 'deleted');
      sessions.delete(scope);
      await s.close();
    },
    sendChat: (scope, text) => sendChat({ wanted: () => wanted && !closed, session, config, lastError: () => lastError }, scope, text),
    answerPermission(scope, id, decision, actor) {
      const tool = sessions.get(scope)?.answerPermission(id, decision, actor) ?? null;
      if (tool === null) return false;
      jobAudit(scope, 'daemon-permission', { tool, decision }, actor);
      return true;
    },
    setPermissionMode(scope, mode, actor) {
      if (!validScope(scope)) return { error: 'invalid scope' };
      if (scope === OFFICE_SCOPE) return { error: OFFICE_NO_SESSION };
      if (!PERMISSION_MODES.includes(mode)) return { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` };
      if (closed) return { error: 'the dashboard is shutting down' };
      modes.choose(scope, mode);
      const s = sessions.get(scope);
      s?.logEvent('permission-mode-set', { mode, actor });
      jobAudit(scope, 'daemon-mode', { mode }, actor);
      // A running child switches now; claude confirms with a status event, which updates its state.
      s?.setPermissionMode(mode);
      return { error: null };
    },
    setJobPermissionMode(mode, actor) {
      if (!PERMISSION_MODES.includes(mode)) return { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` };
      if (closed) return { error: 'the dashboard is shutting down' };
      modes.chooseJobs(mode);
      // A job with its own choice keeps it; the rest switch as if each were chosen one by one.
      for (const s of jobSessions().filter((j) => !modes.chosen(j.scope))) {
        s.logEvent('permission-mode-set', { mode, actor, default: true });
        jobAudit(s.scope, 'daemon-mode', { mode, default: true }, actor);
        s.setPermissionMode(mode);
      }
      return { error: null };
    },
    poke: () => tick(),
    trusted: () => trusted,
    state,
    sessionState(scope) {
      return sessions.get(scope)?.state() ?? offState(root, scope);
    },
    facts: (scope) => sessions.get(scope)?.facts() ?? null,
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
      if (syncTimer) clearInterval(syncTimer);
      syncTimer = null;
      if (reconcileTimer) clearInterval(reconcileTimer);
      reconcileTimer = null;
      wanted = false;
      closed = true;
      leave?.();
      // A running sync or pass child gets SIGTERM, then SIGKILL after graceMs, and is waited for: none still writes once close() resolves.
      children.abort();
      await Promise.all([...[...sessions.values()].map((s) => s.close()), gates.close(), intake.close(), officeRuns.close(), passes.close(), ...(syncInFlight ? [syncInFlight] : []), ...reconciling]);
      releaseDaemonLock();
      subscribers.clear();
    },
    /** Last resort from a process `exit` handler: synchronous, so it can't wait for the grace period. */
    killSync() {
      // SIGTERM to a running sync or pass child, so a crashing `forge dash` leaves none behind.
      children.abort();
      passes.abort();
      for (const s of sessions.values()) s.killSync();
      gates.killSync();
      intake.killSync();
      officeRuns.killSync();
      releaseDaemonLock();
    },
  };
}
