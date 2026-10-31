// A job scope's Session under `daemon.driver: code`: forge dash drives every turn of the job itself, applying its
// requests with `forge job apply`, then running `forge job advance` and one `forge job agent run` per spawn as child
// processes until a gate or `done`, with no orchestrator session (./turn.ts). It wraps an inner createSession, which takes
// only the turn of a procedure step the driver handed off (RC1's recall eval) exactly as a job session does, and every
// call under `daemon.driver: session`. docs/architecture/daemon-runtime.md "Code driver" describes the loop.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { defaults } from '#core/config/keys/defaults.ts';
import { readInfo, sessionFiles } from '#core/job/session-files.ts';
import { enqueue, listRequests, sharedScope } from '#core/job/requests.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { driverIdOf, releaseSession } from '../driver.ts';
import { createSession } from '../session/lifecycle.ts';
import { closeResumes } from '../session/owned.ts';
import { createRelay } from './relay.ts';
import { driveTurn, killTurnSync, newTurn, oneLine, stopRunners, type Turn, type TurnDeps, type TurnEnd } from './turn.ts';
import type { Session, SessionContext, SessionOptions } from '../session/contract.ts';
import type { SessionFacts } from '../reconcile.ts';
import type { Config, DaemonSessionState, ForgeRequest } from '#core/types.ts';

/** The one resume the driver queues when it reaches a procedure step: fixed text, so nothing from a child reaches a session. */
export const HANDOFF_TEXT = 'The code driver reached a procedure step; claim the job and run the step loop.';
/** Where that resume comes from: a resume from here always goes to a session, never back to the driver. */
const HANDOFF_FROM = 'code-driver';

/** A turn in flight: the loop's state and the promise that settles once it ended and let everything go. */
interface Running {
  t: Turn;
  done: Promise<void>;
}

/** The Session a scope runs as: a plain session for the inbox, the office and chats, the code driver for a job. */
export const createScopeSession = (root: string, scope: string, ctx: SessionContext, o: SessionOptions): Session => (sharedScope(scope) ? createSession(root, scope, ctx, o) : createCodeDriver(root, scope, ctx, o));

export function createCodeDriver(root: string, scope: string, ctx: SessionContext, o: SessionOptions): Session {
  const files = sessionFiles(root, scope);
  // Before the inner session reads the record: every write it makes spreads what it read, so the id survives.
  let driverId = driverIdOf(readInfo(files.info));
  if (driverId === null) {
    driverId = crypto.randomUUID();
    if (fs.existsSync(root)) {
      try {
        writeJsonAtomic(files.info, { ...readInfo(files.info), driverId });
      } catch {}
    }
  }
  const id: string = driverId;

  let current: Running | null = null;
  /** Spawned under the code driver: the scope counts as running until its turn is written. */
  let armed = false;
  let closed = false;
  let lastError: string | null = null;
  /** No code turn starts before this (ms): a usage limit's reset, or a backoff. */
  let retryAt: number | null = null;
  let limitFailures = 0;
  let inner: Session | null = null;

  const changed = () => {
    if (!closed) ctx.emit({ kind: 'state', scope, state: state() });
  };
  // The dashboard sees the wrapper's view, never the inner session's own over a code turn.
  const innerCtx: SessionContext = { ...ctx, emit: (e) => ctx.emit(e.kind === 'state' && inner ? { kind: 'state', scope, state: state() } : e) };
  const session: Session = createSession(root, scope, innerCtx, o);
  inner = session;
  const log = (event: string, message: string, extra: Record<string, unknown> = {}) => {
    if (!closed) session.logEvent(event, { message, ...extra });
  };
  const fail = (message: string) => {
    lastError = message;
    log('error', message);
  };
  const relay = createRelay({ root, scope, config: () => ctx.config(), o, logEvent: (event, extra) => void (!closed && session.logEvent(event, extra)), changed });
  const deps: TurnDeps = { root, scope, id, ctx, o, relay, log, fail };

  const isCode = (c: Config | null): boolean => c?.daemon?.driver === 'code';
  const readConfig = (): Config | null => {
    try {
      return ctx.config();
    } catch {
      return null;
    }
  };

  /**
   * Why `ids` go to the session rather than the code driver, or null when the driver takes them: only the turn holding
   * the driver's own hand-off resume does. Requests that can't be read go to the driver, whose claim and apply say why.
   */
  function fallbackReason(ids: readonly string[]): string | null {
    const wanted = new Set(ids);
    let reqs: ForgeRequest[];
    try {
      reqs = listRequests(root).filter((r) => wanted.has(r.id));
    } catch {
      return null;
    }
    return reqs.some((r) => r.from === HANDOFF_FROM) ? 'a procedure step the driver handed off' : null;
  }

  /** Lets go of everything the turn held, closes its requests unless they must run again, and hands the scope back. */
  async function finish(t: Turn, why: TurnEnd): Promise<void> {
    await stopRunners(deps, t);
    relay.clear();
    const c = readConfig() ?? defaults();
    const released = releaseSession(root, [id], { reason: `code-driver: ${why}`, config: c });
    for (const j of released.jobs) {
      if (j.lost.length) log('agents-lost', `marked ${j.lost.join(', ')} lost`, { job: j.job, roles: j.lost });
      if (j.expired) log('lease-expired', `released ${j.job}`, { job: j.job, session: j.expired, reason: why });
    }
    for (const message of released.errors) log('error', message);
    // After a limit or a stop the requests run again; a refused claim closed its own.
    if (why !== 'limit' && why !== 'stopped' && why !== 'refused') {
      const closedIds = closeResumes(root, scope, t.ids, [id]);
      if (closedIds.length) log('requests-closed', `closed ${closedIds.length} resume request${closedIds.length === 1 ? '' : 's'} as taken up`, { requests: closedIds });
    }
    if (why === 'limit') {
      const backoff = Math.min(o.retryMinMs * 2 ** limitFailures, o.retryMaxMs);
      limitFailures++;
      retryAt = t.limitAt ?? Date.now() + backoff;
      log('retry', `a usage limit: the next turn waits until ${new Date(retryAt).toISOString()}`, { at: new Date(retryAt).toISOString(), reason: 'limit', attempt: limitFailures });
    } else if (why !== 'stopped') limitFailures = 0;
    let handedTo: string | null = null;
    if (why === 'handoff') {
      try {
        handedTo = enqueue(root, null, { type: 'resume', job: scope, text: HANDOFF_TEXT, from: HANDOFF_FROM }).id;
      } catch (e) {
        fail(`code driver: the hand-off resume could not be queued: ${(e as Error).message}`);
      }
      log('handoff', `procedure ${oneLine(t.reference, 120)}: handed to a session`, { reference: oneLine(t.reference, 120), request: handedTo });
    }
    log('driver-end', `the turn ended: ${why}`, { why });
    current = null;
    armed = false;
    // Unless the session can't start now: the queued resume then routes to it at the next tick (fallbackReason).
    if (handedTo !== null && !closed && ctx.poolWanted() && session.wanted && session.spawn(c, 'handoff')) session.writeTurn([handedTo]);
    changed();
    if (!closed && !session.running) ctx.onExit(scope);
  }

  async function runTurn(t: Turn): Promise<void> {
    let why: TurnEnd = 'stopped';
    try {
      log('driver-start', `driving ${t.ids.length} request${t.ids.length === 1 ? '' : 's'} in code`, { requests: t.ids.length });
      // The driver and the inner session never run at once: a session left from a fallback turn stops first.
      if (session.running) await session.kill('stop', true, 'code-driver');
      why = await driveTurn(deps, t);
    } catch (e) {
      fail(`code driver: ${(e as Error).message}`);
      // Its requests stay pending: the next turn waits, so a fault that repeats can't spin a turn every tick.
      retryAt = Date.now() + o.retryMinMs;
    }
    try {
      await finish(t, why);
    } catch (e) {
      fail(`code driver: ending the turn failed: ${(e as Error).message}`);
      current = null;
      armed = false;
      changed();
    }
  }

  function startTurn(ids: string[]): void {
    const t = newTurn(ids);
    armed = false;
    retryAt = null;
    let settle!: () => void;
    current = { t, done: new Promise<void>((r) => (settle = r)) };
    changed();
    void runTurn(t).finally(settle);
  }

  /** A stop: SIGTERM to every forge child (a runner interrupts its role child), SIGKILL after the grace; its requests stay pending. */
  async function stopTurn(event: string, reason?: string): Promise<void> {
    const run = current;
    if (!run) return;
    if (!run.t.stopping) {
      run.t.stopping = true;
      log(event, `stopping the code turn${reason ? ` (${reason})` : ''}`, reason ? { reason } : {});
      changed();
      run.t.wake?.();
      await Promise.all([...run.t.children].map((c) => c.stop()));
    }
    await run.done;
  }

  function state(): DaemonSessionState {
    const s = session.state();
    const timedOut = relay.timedOut();
    if (!current && !armed && lastError === null && !timedOut.length) return s;
    const merged = { ...s, lastError: lastError ?? s.lastError, timedOut: [...timedOut, ...(s.timedOut ?? [])] };
    if (!current && !armed) return merged;
    return {
      ...merged,
      running: true,
      status: current ? (current.t.stopping ? 'stopping' : 'busy') : 'idle',
      sessionId: id,
      pid: null,
      lastTurnAt: current?.t.startedAt ?? s.lastTurnAt,
      permissions: [...relay.permissions(), ...s.permissions],
      permissionMode: null,
      effort: null,
      contextTokens: null,
    };
  }

  return {
    scope,
    get wanted() {
      return session.wanted;
    },
    get running() {
      return Boolean(current) || armed || session.running;
    },
    get status() {
      if (current) return current.t.stopping ? 'stopping' : 'busy';
      return armed ? 'idle' : session.status;
    },
    get waiting() {
      return session.waiting;
    },
    get held() {
      return session.held;
    },
    get lastError() {
      return lastError ?? session.lastError;
    },
    get lastResultAt() {
      return session.lastResultAt;
    },
    get kept() {
      return session.kept;
    },
    refreshKept: () => session.refreshKept(),
    keptBy: (at) => session.keptBy(at),
    state,
    facts(): SessionFacts {
      const f = session.facts();
      // The driver's own id is always one of the scope's: a lease a crashed turn left under it is this session's to judge.
      const ids = [...f.ids, id];
      if (current) return { ids, status: current.t.stopping ? 'stopping' : 'busy', background: -1, idleSince: null };
      return { ...f, ids };
    },
    route(c, pending, repo) {
      const r = session.route(c, pending, repo);
      if (retryAt !== null && Date.now() < retryAt) return { eligible: r.eligible, fresh: false };
      return r;
    },
    spawn(c, reason) {
      if (closed) return false;
      if (!isCode(c) || session.running) return session.spawn(c, reason);
      armed = true;
      changed();
      return true;
    },
    writeTurn(ids) {
      if (current) return;
      const c = readConfig();
      const why = isCode(c) ? fallbackReason(ids) : 'session';
      if (why === null) return startTurn(ids);
      if (why !== 'session') log('fallback', `a session takes this turn: ${why}`, { reason: why, requests: ids.length });
      const wasArmed = armed;
      armed = false;
      if (!session.running && !(wasArmed && c && session.spawn(c, 'work'))) return changed();
      session.writeTurn(ids);
    },
    writeChat: (text) => session.writeChat(text),
    answerPermission(promptId, decision, actor) {
      return relay.answer(promptId, decision, actor) ?? session.answerPermission(promptId, decision, actor);
    },
    setPermissionMode: (mode) => session.setPermissionMode(mode),
    async kill(event, endStdin, reason) {
      const ours = armed || current !== null;
      armed = false;
      await stopTurn(event, reason);
      await session.kill(event, endStdin, reason);
      if (ours) changed();
    },
    logEvent: (event, extra) => session.logEvent(event, extra),
    setWaiting: (w) => session.setWaiting(w),
    setWanted: (w) => session.setWanted(w),
    reset() {
      retryAt = null;
      lastError = null;
      limitFailures = 0;
      session.reset();
    },
    recent: (after) => session.recent(after),
    async close() {
      armed = false;
      await stopTurn('stop');
      closed = true;
      relay.clear();
      await session.close();
    },
    killSync() {
      if (current) killTurnSync(current.t);
      session.killSync();
    },
  };
}
