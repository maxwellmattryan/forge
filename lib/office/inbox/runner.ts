// forge dash's intake runner: answers the inbox's requests in code, one at a time, oldest first, instead of
// turning a headless inbox session. A run passes checkLaunch, claims the request under the inbox's stable
// intake session id, runs its plan's `forge` calls (./handlers.ts) each as its own `bin/forge` child in the
// `_inbox` scope (./children.ts), and acks with a fixed one-line result. A stop gives the claim back uncounted;
// a child that never answered requeues it, counted (once), and holds new runs for the backoff. Its facts lie
// over the inbox session's state, and it logs to the inbox's log. docs/architecture/daemon.md › Intake runner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { REQUEUE_REJECTED, INBOX_SCOPE, ackRequest, claimRequest, releaseClaim } from '#core/job/requests.ts';
import { readInfo, sessionFiles } from '#core/job/session-files.ts';
import { requeueOrphanedRequests } from '#core/job/store.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { paths } from '#core/paths.ts';
import { oneLineTitle } from '#core/text.ts';
import { now } from '#core/utils.ts';
import type { RoleRun } from '#integrations/claude/role.ts';
import { intakeIdOf } from '../driver.ts';
import { checkLaunch } from '../session/launch.ts';
import type { Session, SessionContext, SessionOptions } from '../session/contract.ts';
import { callError, intakeEnv, type ForgeCall, type ForgeCaller } from './children.ts';
import { handle, handles, type Call, type Outcome } from './handlers.ts';
import { runTriage } from './triage.ts';
import type { Config, DaemonSessionState, ForgeRequest } from '#core/types.ts';

/** The runner the pool owns: take() each tick, its claim id for the reconciler, its facts over the inbox's state, and the stops. */
export interface IntakeRunner {
  /** The intake session id every claim and hand-off is made under. */
  readonly id: string;
  /** Starts a run for the first request it handles in `pending` (this tick's inbox group, oldest first), unless one is live or held. */
  take(config: Config, pending: ForgeRequest[]): void;
  /** Whether it answers `r` (./handlers.ts). */
  handles(r: ForgeRequest): boolean;
  /**
   * Takes the requests it handles out of this tick's `_inbox` group and returns them, oldest first: only the rest
   * reach the inbox session, each logged `intake-fallback` once.
   */
  split(groups: Map<string, ForgeRequest[]>): ForgeRequest[];
  /** The intake session id while a run is live: the reconciler's claim-age rule counts it busy. */
  sessions(): string[];
  /** The inbox session's state with the runner's facts laid over it. */
  state(base: DaemonSessionState): DaemonSessionState;
  /** Stops a live run: its child gets SIGTERM, then SIGKILL after the grace period, and the claim goes back uncounted. */
  stop(): Promise<void>;
  close(): Promise<void>;
  killSync(): void;
}

/**
 * The intake session id in the inbox's record: created once (a uuid) and kept across `forge dash` restarts. The
 * inbox session's own writes spread the record, so the field survives them. A record that can't be written leaves
 * an id in memory, with the error for the caller to log.
 */
export function ensureIntakeSessionId(root: string): { id: string; error: string | null } {
  const f = sessionFiles(root, INBOX_SCOPE);
  const info = readInfo(f.info);
  const have = intakeIdOf(info);
  if (have) return { id: have, error: null };
  const id = crypto.randomUUID();
  try {
    // A checkout without .forge/ runs no daemon: nothing is written there until it is set up.
    if (fs.existsSync(paths(root).dir)) {
      fs.mkdirSync(f.dir, { recursive: true });
      writeJsonAtomic(f.info, { ...info, intakeSessionId: id });
    }
    return { id, error: null };
  } catch (e) {
    return { id, error: `the intake session id could not be saved: ${(e as Error).message}` };
  }
}

interface Live {
  abort: AbortController;
  triage: RoleRun | null;
  flow: Promise<void>;
}

const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);
const errText = (e: unknown): string => callError(e instanceof Error ? e.message : String(e)) ?? 'error';

export function createIntakeRunner(
  root: string,
  deps: { ctx: SessionContext; o: SessionOptions; runForge: ForgeCaller; inbox: Session; id: { id: string; error: string | null }; changed: () => void },
): IntakeRunner {
  const { ctx, o, runForge, inbox } = deps;
  const S = deps.id.id;
  if (deps.id.error) inbox.logEvent('error', { message: deps.id.error });
  let live: Live | null = null;
  let closed = false;
  /** Finished runs, for the inbox's `turns`. */
  let turns = 0;
  let lastTurnAt: string | null = null;
  let lastResultAt: string | null = null;
  /** Runs in a row whose child never answered: the backoff exponent. Reset by any run that got an answer. */
  let streak = 0;
  let lastError: string | null = null;
  /** No new run before this time (ms): a failed run's backoff. */
  let holdUntil: number | null = null;
  const fellBack = new Set<string>();

  const retryWait = (failures: number) => Math.min(o.retryMaxMs, o.retryMinMs * 2 ** Math.max(0, failures - 1));
  const log = (event: string, extra: Record<string, unknown>) => {
    if (!closed) inbox.logEvent(event, extra);
  };

  function ack(r: ForgeRequest, status: 'done' | 'rejected', result: string): void {
    try {
      ackRequest(root, r.id, { status, result });
    } catch (e) {
      log('error', { message: `ack ${r.id}: ${errText(e)}` });
    }
  }

  /** Back to pending, counted; rejected with REQUEUE_REJECTED when it was requeued once before. Then the backoff. */
  function requeue(r: ForgeRequest, message: string): { status: string; result: string } {
    streak++;
    lastError = message;
    holdUntil = Date.now() + retryWait(streak);
    log('intake-held', { until: new Date(holdUntil).toISOString(), failures: streak });
    let rejected = false;
    try {
      rejected = requeueOrphanedRequests(root, { exited: [S], byAge: false }).rejected.some((x) => x.id === r.id);
    } catch (e) {
      log('error', { message: `requeue ${r.id}: ${errText(e)}` });
    }
    return rejected ? { status: 'rejected', result: `${message}; ${REQUEUE_REJECTED}` } : { status: 'requeued', result: message };
  }

  /** One run, claim to ack. Never rejects. */
  async function run(r: ForgeRequest, c: Config, trusted: string, entry: Live): Promise<void> {
    const claimedAt = Date.now();
    lastTurnAt = new Date(claimedAt).toISOString();
    log('intake-start', { request: r.id, type: r.type });
    deps.changed();
    const env = intakeEnv(root, o.env, c, trusted);
    const stop = { signal: entry.abort.signal, graceMs: o.graceMs };
    const call: Call = async (args) => {
      let res: ForgeCall;
      if (entry.abort.signal.aborted) return { code: null, signal: 'SIGTERM', json: null, error: 'the pool stopped', ms: 0 };
      try {
        res = await runForge(args, { env, stop });
      } catch (e) {
        res = { code: null, signal: null, json: null, error: errText(e), ms: 0 };
      }
      log('intake-call', { args, code: res.code, ms: res.ms });
      return res;
    };
    const triage = () =>
      runTriage(root, { ctx, o, config: c, trusted, call, log, started: (t) => void (entry.triage = t), stopped: () => entry.abort.signal.aborted || closed });
    let outcome: Outcome;
    try {
      outcome = await handle(r, call, S, { triage, now: () => new Date() });
    } catch (e) {
      outcome = { infra: errText(e) };
    }
    let end: { status: string; result: string };
    let waitMs: number | null = null;
    if (entry.abort.signal.aborted || 'stopped' in outcome) {
      // A stop, close or human Stop (or a protected path that changed): no fault of the request, nothing acked.
      releaseClaim(root, r.id, S);
      end = { status: 'released', result: 'the run was stopped' };
    } else if ('infra' in outcome) {
      end = requeue(r, outcome.infra);
    } else {
      streak = 0;
      lastError = null;
      ack(r, outcome.status, outcome.result);
      end = outcome;
      turns++;
      lastResultAt = now();
      const created = Date.parse(r.createdAt ?? '');
      waitMs = Number.isFinite(created) ? Date.now() - created : null;
    }
    live = null;
    log('intake-end', { request: r.id, type: r.type, status: end.status, result: end.result, waitMs, runMs: end.status === 'released' ? null : Date.now() - claimedAt });
    deps.changed();
    // The next request starts at once; the poke waits for the tick this run may have started in.
    queueMicrotask(() => {
      if (!closed) ctx.poke();
    });
  }

  async function stopRun(): Promise<void> {
    const entry = live;
    if (!entry) return;
    entry.abort.abort();
    entry.triage?.stop('SIGTERM');
    await entry.flow;
  }

  return {
    id: S,
    take(config, pending) {
      if (closed || live || !inbox.wanted) return;
      if (holdUntil !== null) {
        if (Date.now() < holdUntil) return;
        holdUntil = null;
      }
      const r = pending.find((x) => handles(x));
      if (!r) return;
      // Trust, config and daemon.enabled are checked again before each request; a refusal has stopped the pool.
      const launch = checkLaunch(root, ctx, o);
      if (!launch) return;
      try {
        claimRequest(root, r.id, S);
      } catch {
        // Lost to another claimant (exit 3), or done meanwhile: skipped.
        return;
      }
      const entry: Live = { abort: new AbortController(), triage: null, flow: Promise.resolve() };
      live = entry;
      entry.flow = run(r, launch.config, launch.trusted, entry);
    },
    handles,
    split(groups) {
      const all = groups.get(INBOX_SCOPE) ?? [];
      const rest = all.filter((r) => !handles(r));
      if (rest.length) groups.set(INBOX_SCOPE, rest);
      else groups.delete(INBOX_SCOPE);
      const ids = new Set(rest.map((r) => r.id));
      for (const x of [...fellBack]) if (!ids.has(x)) fellBack.delete(x);
      for (const r of rest) {
        if (fellBack.has(r.id)) continue;
        fellBack.add(r.id);
        log('intake-fallback', { request: r.id, type: oneLineTitle(String(r.type)).slice(0, 40) });
      }
      return all.filter((r) => handles(r));
    },
    sessions: () => (live ? [S] : []),
    state(base) {
      const busy = live !== null;
      const idle = !base.running && ctx.poolWanted() && inbox.wanted;
      return {
        ...base,
        status: busy ? 'busy' : idle ? 'idle' : base.status,
        turns: base.turns + turns,
        lastTurnAt: later(base.lastTurnAt, lastTurnAt),
        lastResultAt: later(base.lastResultAt, lastResultAt),
        failures: base.failures + streak,
        lastError: lastError ?? base.lastError,
      };
    },
    stop: stopRun,
    async close() {
      // First, so a run the close stops logs nothing to the closing inbox log and pokes no closed pool.
      closed = true;
      await stopRun();
    },
    killSync() {
      live?.abort.abort();
      live?.triage?.stop('SIGTERM');
    },
  };
}
