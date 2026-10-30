// forge dash's office runner: runs each pending `draft` or `direct` request in code, one office run at a time,
// as the Foreman, with the CLI steps as children (./cli.ts) and one-shot model children (./child.ts) for the
// drafter, the surveyors and at most one director call. A run claims the request as `office-run:<uuid>`, runs
// its steps (./draft.ts, ./direct.ts) and acks. It never leaves a request claimed: a failed run requeues it
// (counted, once), a stop, a usage limit, a refused launch or the office cap gives the claim back. It shares
// the office's daily cap with the gate runs and keeps a JSON-lines log, `_office.log`. The pool never starts an
// `_office` session (OFFICE_NO_SESSION). docs/architecture/foreman.md › Office runs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MANDATE_ID_SOURCE, OFFICE_SCOPE } from '#api/constants.ts';
import { ForgeError } from '#core/errors.ts';
import { REQUEUE_REJECTED, ackRequest, claimRequest, listRequests, releaseClaim } from '#core/job/requests.ts';
import { requeueOrphanedRequests } from '#core/job/store.ts';
import { openAppend, sessionFiles } from '#core/job/session-files.ts';
import { now } from '#core/utils.ts';
import { cleanReason } from '../verdict.ts';
import { officeCapRefusal } from '../../session/meter.ts';
import type { SessionContext, SessionOptions } from '../../session/contract.ts';
import type { ChildStop } from '../../sync-child.ts';
import { officeArgv, officeChildEnv, officeCliResult, runOfficeCli, type OfficeCliRun } from './cli.ts';
import { startOfficeChild, type OfficeChild } from './child.ts';
import { runDraft } from './draft.ts';
import { runDirect } from './direct.ts';
import { GiveBack, RunFailed, type StepDeps } from './steps.ts';
import type { Config, ForgeRequest, OfficeRunOutcome, OfficeRunState, OfficeRunsState } from '#core/types.ts';

/** What the pool answers a start or a permission mode for `_office`: no session serves it any more. */
export const OFFICE_NO_SESSION = 'the office runs no session: forge dash runs its draft and direct requests in code (office runs)';

/** The runs the list keeps. */
const KEPT = 50;
/** An ack's result and a run's reason are cut to this many characters. */
const RESULT_MAX = 200;
const SESSION_PREFIX = 'office-run:';
const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
const TYPES = ['draft', 'direct'];

/** The runner the pool owns: take() each tick, the live claim for the reconciler, the log, and the stops. */
export interface OfficeRunner {
  /** Starts the oldest pending draft or direct request in `pending` (this tick's `_office` group, oldest first) when no run is live. */
  take(config: Config, pending: ForgeRequest[]): void;
  /** The config the pool read last, so state() says whether runs are on before the first tick. */
  configure(config: Config): void;
  /** The claim session of the live run: the reconciler's claim-age rule counts it busy. */
  sessions(): string[];
  /** At a fresh start: requeues (counted) every draft or direct request an earlier dash's run left in progress. */
  recover(): void;
  /** One line to the office log, never claude's text or a CLI child's stdout. */
  log(event: string, extra?: Record<string, unknown>): void;
  state(): OfficeRunsState;
  /** Kills the live run's children and gives its claim back without counting it. */
  stop(): Promise<void>;
  close(): Promise<void>;
  killSync(): void;
}

/** Whether the runner takes office requests: daemon.enabled and foreman.enabled. */
export const officeRunsEnabled = (c: Config | null): boolean => c?.daemon?.enabled === true && c.foreman?.enabled === true;

const cut = (s: string): string => (s.length > RESULT_MAX ? s.slice(0, RESULT_MAX) : s);
const errText = (e: unknown): string => cleanReason(e instanceof Error ? e.message : String(e)) || 'error';

interface Live {
  session: string;
  state: OfficeRunState;
  children: Set<OfficeChild>;
  /** Aborted by a stop: a running CLI child gets SIGTERM, then SIGKILL. */
  abort: AbortController;
  flow: Promise<void>;
  stopping: boolean;
}

export function createOfficeRunner(root: string, deps: { ctx: SessionContext; o: SessionOptions; cli?: (root: string, env: NodeJS.ProcessEnv, argv: string[], stop?: ChildStop) => Promise<OfficeCliRun> }): OfficeRunner {
  const { ctx, o } = deps;
  const runCli = deps.cli ?? runOfficeCli;
  const logFile = sessionFiles(root, OFFICE_SCOPE).log;
  let live: Live | null = null;
  let done: OfficeRunState[] = [];
  let lastConfig: Config | null = null;
  let closed = false;
  let holdUntil: number | null = null;
  let holdReason: 'retry' | 'limit' = 'retry';
  let capHeld: string | null = null;
  /** Failed runs in a row: the backoff exponent. Reset by any run that reached its ack. */
  let streak = 0;
  const stopped = (entry: Live) => closed || entry.stopping;

  /** One JSON line to `_office.log`, opened without following a link or blocking on a FIFO. Never throws. */
  function log(event: string, extra: Record<string, unknown> = {}): void {
    if (!fs.existsSync(root)) return;
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fd = openAppend(logFile);
      fs.writeSync(fd, JSON.stringify({ type: 'forge-office', at: now(), event, ...extra }) + '\n');
    } catch {
      // A planted link or FIFO: the run goes on without its log line.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  const retryWait = (failures: number) => Math.min(o.retryMaxMs, o.retryMinMs * 2 ** Math.max(0, failures - 1));

  function hold(reason: 'retry' | 'limit', until: number): void {
    holdReason = reason;
    holdUntil = until;
    log('office-held', { reason, until: new Date(until).toISOString() });
  }

  function ack(id: string, status: 'done' | 'rejected', result: string): void {
    try {
      ackRequest(root, id, { status, result: cut(result) });
    } catch (e) {
      log('error', { message: `ack ${id}: ${errText(e)}` });
    }
  }

  /** The cap's refusal now, or null; a meter that can't be read refuses (fails closed). */
  function capRefusal(c: Config): string | null {
    try {
      return officeCapRefusal(root, c, Date.now())?.message ?? null;
    } catch (e) {
      return `the office's daily cap can't be checked: ${errText(e)}`;
    }
  }

  /** A stop, a limit, a refused launch or the cap: the claim goes back uncounted, and a limit holds new runs until it resets. */
  function giveBack(r: ForgeRequest, session: string, e: GiveBack): [OfficeRunOutcome, string] {
    try {
      releaseClaim(root, r.id, session);
    } catch (err) {
      log('error', { message: `release ${r.id}: ${errText(err)}` });
    }
    if (e.limit) {
      const t0 = Date.now();
      hold('limit', e.limit.resetsAt !== null && e.limit.resetsAt > t0 ? e.limit.resetsAt : t0 + retryWait(Math.max(1, streak)));
    }
    return ['requeued', e.message];
  }

  /** A failed run: requeued (counted), or rejected when it had been requeued before. Then the backoff. */
  function failed(r: ForgeRequest, session: string, message: string): [OfficeRunOutcome, string] {
    streak++;
    hold('retry', Date.now() + retryWait(streak));
    let out: { rejected: ForgeRequest[] } = { rejected: [] };
    try {
      out = requeueOrphanedRequests(root, { exited: [session], byAge: false });
    } catch (e) {
      log('error', { message: `requeue ${r.id}: ${errText(e)}` });
    }
    return out.rejected.some((x) => x.id === r.id) ? ['failed', `${message}; ${REQUEUE_REJECTED}`] : ['requeued', message];
  }

  /** The children and the log a run's steps get, bound to its entry, its env and the config its launch check read. */
  function stepDeps(r: ForgeRequest, entry: Live, launch: { env: NodeJS.ProcessEnv; config: Config }): StepDeps {
    return {
      root,
      config: launch.config,
      request: r,
      log,
      async cli(cmd, args = {}) {
        const argv = officeArgv(cmd, args);
        if (stopped(entry)) throw new GiveBack('the pool stopped');
        const res = await runCli(root, launch.env, argv, { signal: entry.abort.signal, graceMs: o.graceMs });
        log('office-step', { run: entry.session, step: cmd, exit: res.exit });
        if (stopped(entry)) throw new GiveBack('the pool stopped');
        const out = officeCliResult(res);
        if (out.kind === 'crash') throw new RunFailed(`${cmd}: ${out.message}`);
        return out;
      },
      async child(call) {
        if (stopped(entry)) throw new GiveBack('the pool stopped');
        // Checked again before each model child: the gate runs share the cap and may have reached it meanwhile.
        const refusal = capRefusal(launch.config);
        if (refusal) {
          capHeld = refusal;
          log('office-held', { reason: 'daily-cap', until: null });
          throw new GiveBack(`the office's daily cap holds the run: ${refusal}`);
        }
        entry.state.calls++;
        const child = startOfficeChild(root, ctx, o, { ...call, log });
        entry.children.add(child);
        log('office-child', { run: entry.session, agent: call.agent, pid: child.pid, model: call.model, effort: call.effort });
        const res = await child.done;
        entry.children.delete(child);
        Object.assign(entry.state, { usd: entry.state.usd + res.usd, tokens: entry.state.tokens + res.tokens });
        if (!('failure' in res)) return { text: res.text, sessionId: res.sessionId };
        if (res.failure === 'failed') throw new RunFailed(res.message);
        throw new GiveBack(res.message, res.failure === 'limit' ? { resetsAt: res.resetsAt } : null);
      },
    };
  }

  /** One office run, claim to ack. Never rejects. */
  async function run(r: ForgeRequest, entry: Live): Promise<void> {
    const { session, state: s } = entry;
    let outcome: OfficeRunOutcome = 'failed';
    let reason = '';
    try {
      if (stopped(entry)) throw new GiveBack('the pool stopped');
      const launch = officeChildEnv(root, ctx, o);
      if (!launch) throw new GiveBack('the launch checks refused the office run');
      const d = stepDeps(r, entry, launch);
      const end = s.type === 'draft' ? await runDraft(s.mandate!, d) : await runDirect(d);
      streak = 0;
      ack(r.id, end.status, end.result);
      [outcome, reason] = [end.outcome, end.result];
    } catch (e) {
      if (e instanceof GiveBack) [outcome, reason] = giveBack(r, session, e);
      else if (e instanceof ForgeError) {
        // A refusal in-process (a link at the drafts dir, say): the request is answered, not retried.
        ack(r.id, 'rejected', e.message);
        [outcome, reason] = ['refused', e.message];
      } else {
        // A crashed CLI child, a model child that ended without a result, or a bug: the counted requeue.
        log('error', { message: errText(e) });
        [outcome, reason] = failed(r, session, errText(e));
      }
    } finally {
      live = null;
      Object.assign(s, { status: 'done', outcome, reason: cut(cleanReason(reason)) || null, endedAt: now() });
      done = [s, ...done].slice(0, KEPT);
      log('office-end', { run: session, request: r.id, type: s.type, mandate: s.mandate, outcome, reason: s.reason, calls: s.calls, usd: s.usd, tokens: s.tokens, startedAt: s.startedAt });
      // A run that ends before its first await runs this inside the pool's own tick: the poke waits for it to return.
      queueMicrotask(() => {
        if (!closed) ctx.poke();
      });
    }
  }

  function start(r: ForgeRequest): void {
    const session = `${SESSION_PREFIX}${crypto.randomUUID()}`;
    try {
      claimRequest(root, r.id, session);
    } catch {
      // Lost to another claimant, or done meanwhile: skipped.
      return;
    }
    const mandate = r.args?.mandate;
    const valid = r.type === 'direct' || (r.type === 'draft' && typeof mandate === 'string' && MANDATE_ID.test(mandate));
    if (!valid) {
      ack(r.id, 'rejected', 'invalid office request');
      log('error', { message: `invalid office request ${r.id}` });
      return;
    }
    const state: OfficeRunState = {
      request: r.id,
      type: r.type as 'draft' | 'direct',
      mandate: r.type === 'draft' ? (mandate as string) : null,
      status: 'running',
      outcome: null,
      reason: null,
      startedAt: now(),
      endedAt: null,
      calls: 0,
      usd: 0,
      tokens: 0,
    };
    const entry: Live = { session, state, children: new Set(), abort: new AbortController(), flow: Promise.resolve(), stopping: false };
    live = entry;
    log('office-start', { run: session, request: r.id, type: state.type, mandate: state.mandate });
    entry.flow = run(r, entry);
  }

  async function stopLive(): Promise<void> {
    const entry = live;
    if (!entry) return;
    entry.stopping = true;
    entry.abort.abort();
    await Promise.all([...entry.children].map((c) => c.stop()));
    await entry.flow;
  }

  return {
    take(config, pending) {
      lastConfig = config;
      if (closed || config.foreman?.enabled !== true) return;
      const waiting = pending.filter((r) => TYPES.includes(r.type));
      // Nothing waits: no meter read, and no cap hold left showing.
      if (!waiting.length) {
        capHeld = null;
        return;
      }
      const t0 = Date.now();
      if (holdUntil !== null) {
        if (t0 < holdUntil) return;
        holdUntil = null;
      }
      const refusal = capRefusal(config);
      if (refusal !== capHeld) {
        capHeld = refusal;
        if (refusal) log('office-held', { reason: 'daily-cap', until: null });
      }
      if (refusal || live) return;
      start(waiting[0]);
    },
    configure(config) {
      lastConfig = config;
    },
    sessions: () => (live ? [live.session] : []),
    recover() {
      const left = listRequests(root, { status: 'in-progress' }).filter((r) => TYPES.includes(r.type) && typeof r.session === 'string' && r.session.startsWith(SESSION_PREFIX) && live?.state.request !== r.id);
      if (!left.length) return;
      try {
        requeueOrphanedRequests(root, { exited: left.map((r) => r.session!), byAge: false });
      } catch (e) {
        log('error', { message: `recover: ${errText(e)}` });
      }
    },
    log,
    state() {
      const t0 = Date.now();
      const held: OfficeRunsState['held'] =
        holdUntil !== null && t0 < holdUntil
          ? { reason: holdReason, until: new Date(holdUntil).toISOString(), message: holdReason === 'limit' ? 'a usage limit: office runs wait for it to reset' : 'an office run failed: the next waits out its backoff' }
          : capHeld
            ? { reason: 'daily-cap', until: null, message: capHeld }
            : null;
      const running = live ? [{ ...live.state }] : [];
      return { enabled: officeRunsEnabled(lastConfig), live: live ? 1 : 0, held, runs: [...running, ...done].slice(0, KEPT) };
    },
    stop: stopLive,
    async close() {
      closed = true;
      await stopLive();
    },
    killSync() {
      if (!live) return;
      live.abort.abort();
      for (const c of live.children) c.killSync();
    },
  };
}
