// forge dash's gate runner: decides each pending `gate` request in code, as the Foreman, with one fresh
// forge:assistant process (./attempt.ts) as its model call, and a senior pass's one more (./senior.ts). A run claims the request, hands off a
// reserved one, runs assist, parses the verdict strictly (./verdict.ts), records the gate table's decision
// through the policy checks (./policy.ts, ./decide.ts) with the runner's ForemanAuthority, queues the
// job's resume and acks. Under foreman.escalations: foreman, an escalate or a refused decision at a job's gate
// gets one senior pass (./senior.ts) that decides it or shelves the job. It never leaves a request claimed: a
// failed run requeues it (counted, once), a usage limit or a stop gives the claim back. It shares the office's
// daily cap and keeps a JSON-lines gate log. docs/architecture/foreman.md › Gate runs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { GATE_RUN_OUTCOMES, MANDATE_ID_SOURCE } from '#api/constants.ts';
import { ForgeError } from '#core/errors.ts';
import { GATES_SCOPE, MAX_GATE_RUNS, REQUEUE_REJECTED, ackRequest, claimRequest, enqueue, issueForemanAuthority, listRequests, releaseClaim, validJobId } from '#core/job/requests.ts';
import { loadJob, readEvents, requeueOrphanedRequests } from '#core/job/store.ts';
import { openAppend, openRead, readLogPage, sessionFiles } from '#core/job/session-files.ts';
import { now } from '#core/utils.ts';
import { gateClassFor, isGateClass } from '#engine/pipeline/moves/foreman-gates.ts';
import { pendingReleaseHash } from '#engine/release/approval.ts';
import { approveMandateRelease, mandateReleaseState } from '#engine/release/mandate.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { assistDraft, decideDraft } from '../mandates/gate.ts';
import { officeCapRefusal } from '../session/meter.ts';
import type { SessionContext, SessionOptions } from '../session/contract.ts';
import { startAttempt, type Attempt, type AttemptResult } from './attempt.ts';
import { assistMandateRelease, mandateReleaseRefusal } from './policy.ts';
import { gateAssist, recordForemanDecision, recordHandoff, titleOnlyRevise, writeTitleOnlyFeedback } from './decide.ts';
import { escalationsMode, recordForemanShelve, recordSeniorPass, seniorGate, seniorStart, type SeniorFirst } from './senior.ts';
import { cleanReason, gateMove, type SeniorVerdict, type Verdict } from './verdict.ts';
import type { Config, Effort, ForgeRequest, GateClass, GateRunOutcome, GateRunState, GateRunsState, HandoffClass } from '#core/types.ts';

/** The runs the list keeps, and the gate log seeds it with. */
const KEPT = 50;
/** An ack's result and a refusal's text are cut to this many characters. */
const RESULT_MAX = 200;
const DEFAULT_PARALLEL = 2;
const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
const SESSION_PREFIX = 'gate-run:';

/** The runner the pool owns: take() each tick, the live claims for the reconciler, and the stops. */
export interface GateRunner {
  /** Starts runs for `pending` (this tick's gate group, oldest first) up to foreman.assistants.parallel. */
  take(config: Config, pending: ForgeRequest[]): void;
  /** The config the pool read last, so state() says whether runs are on before the first tick (a pool not started yet). */
  configure(config: Config): void;
  /** The claim sessions of the live runs: the reconciler's claim-age rule counts them busy. */
  sessions(): string[];
  /** At a fresh start: requeues (counted) every gate request an earlier dash's run left in progress. */
  recover(): void;
  state(): GateRunsState;
  /** Kills live runs and gives their claims back without counting them. */
  stop(): Promise<void>;
  close(): Promise<void>;
  killSync(): void;
}

/** foreman.assistants.parallel: an integer 1-16, else the default (validation reports a bad value). */
export function gateParallel(c: Config | null): number {
  const n: unknown = (c?.foreman?.assistants as { parallel?: unknown } | undefined)?.parallel;
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_GATE_RUNS ? (n as number) : DEFAULT_PARALLEL;
}

/** Whether the runner takes gate requests: foreman.enabled and foreman.assistants.enabled. */
export const gateRunsEnabled = (c: Config | null): boolean => c?.foreman?.enabled === true && c.foreman.assistants?.enabled === true;

const cut = (s: string): string => (s.length > RESULT_MAX ? s.slice(0, RESULT_MAX) : s);
const errText = (e: unknown): string => cleanReason(e instanceof Error ? e.message : String(e)) || 'error';

interface Live {
  session: string;
  state: GateRunState;
  attempt: Attempt | null;
  flow: Promise<void>;
  /** A stop reached this run: no senior pass starts after it. */
  stopping: boolean;
}

type Target = { gate: GateClass; job: string | null; mandate: string | null };

/** A gate request's target as validated before any path or argv is built from it, or null. */
function targetOf(r: ForgeRequest): { gate: GateClass; job: string | null; mandate: string | null } | null {
  const gate = r.args?.gate;
  if (!isGateClass(gate)) return null;
  // A goal mandate's milestone draft, or an `until: released` mandate's release plan: job-less, naming the mandate.
  if ((gate === 'milestone-approval' || gate === 'release') && (r.job === null || r.job === undefined)) {
    const m = r.args?.mandate;
    return typeof m === 'string' && MANDATE_ID.test(m) && m !== 'none' ? { gate, job: null, mandate: m } : null;
  }
  return validJobId(r.job) ? { gate, job: r.job, mandate: null } : null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);

/** One `gate-end` line of the gate log as a finished run, or null when any field fails: the log is a local file anyone can write. */
export function seededRun(raw: unknown): GateRunState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.event !== 'gate-end' || !(GATE_RUN_OUTCOMES as readonly unknown[]).includes(r.outcome) || !isGateClass(r.gate)) return null;
  if (typeof r.request !== 'string' || !/^\d+-[A-Za-z0-9]{1,40}$/.test(r.request)) return null;
  const job = r.job === null ? null : validJobId(r.job) ? r.job : undefined;
  const mandate = r.mandate === null ? null : typeof r.mandate === 'string' && MANDATE_ID.test(r.mandate) ? r.mandate : undefined;
  if (job === undefined || mandate === undefined || (job === null) === (mandate === null)) return null;
  const startedAt = isoOrNull(r.startedAt);
  const endedAt = isoOrNull(r.at);
  if (!startedAt || !endedAt || !finite(r.attempts) || !Number.isInteger(r.attempts) || r.attempts > 4 || !finite(r.usd) || !finite(r.tokens)) return null;
  if (!(r.reason === null || typeof r.reason === 'string')) return null;
  return {
    request: r.request,
    gate: r.gate,
    job,
    mandate,
    status: 'done',
    outcome: r.outcome as GateRunOutcome,
    reason: typeof r.reason === 'string' ? cleanReason(r.reason) || null : null,
    startedAt,
    endedAt,
    attempts: r.attempts,
    usd: r.usd,
    tokens: r.tokens,
  };
}

/** The newest KEPT valid `gate-end` records of the gate log, newest first; none when it is missing, a link or not a file. */
function seed(file: string): GateRunState[] {
  let fd: number | undefined;
  try {
    fd = openRead(file);
    const page = readLogPage(fd, fs.fstatSync(fd).size, 0, { maxLines: 2000, maxBytes: 4 * 1024 * 1024, lineCap: 16 * 1024 });
    const out: GateRunState[] = [];
    for (const { line } of page.lines.toReversed()) {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }
      const run = seededRun(raw);
      if (run) out.push(run);
      if (out.length >= KEPT) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function createGateRunner(root: string, deps: { ctx: SessionContext; o: SessionOptions }): GateRunner {
  const { ctx, o } = deps;
  const authority = issueForemanAuthority();
  const logFile = sessionFiles(root, GATES_SCOPE).log;
  const live = new Map<string, Live>();
  let done: GateRunState[] = seed(logFile);
  let lastConfig: Config | null = null;
  let closed = false;
  /** No new run before this time (ms): a failure's backoff or a usage limit. */
  let holdUntil: number | null = null;
  let holdReason: 'retry' | 'limit' = 'retry';
  /** The daily-cap refusal the last take() saw. */
  let capHeld: string | null = null;
  /** Failed runs in a row: the backoff exponent. Reset by any run that got a verdict. */
  let streak = 0;

  /** One JSON line to `_gates.log`, opened without following a link or blocking on a FIFO. Never throws, never claude's text. */
  function log(event: string, extra: Record<string, unknown> = {}): void {
    if (!fs.existsSync(root)) return;
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fd = openAppend(logFile);
      fs.writeSync(fd, JSON.stringify({ type: 'forge-gates', at: now(), event, ...extra }) + '\n');
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
    log('gate-held', { reason, until: new Date(until).toISOString() });
  }

  function ack(id: string, status: 'done' | 'rejected', result: string): void {
    try {
      ackRequest(root, id, { status, result });
    } catch (e) {
      log('error', { message: `ack ${id}: ${errText(e)}` });
    }
  }

  /** A hand-off at the job's current gate; skipped for release and a milestone draft, and never fatal (the job may have moved on). */
  function handoff(t: { gate: GateClass; job: string | null }, cls: HandoffClass, reason: string): void {
    if (t.job === null || t.gate === 'release' || t.gate === 'milestone-approval') return;
    try {
      recordHandoff(root, loadJob(root, t.job), cls, reason, authority);
    } catch (e) {
      log('error', { message: `hand-off on ${t.job}: ${errText(e)}` });
    }
  }

  function resume(job: string): void {
    try {
      enqueue(root, lastConfig, { type: 'resume', job, from: 'forge' });
    } catch (e) {
      log('error', { message: `resume ${job}: ${errText(e)}` });
    }
  }

  /** Whether the job still waits on the gate the run decided (for release: its plan, or its mandate's, is still pending). */
  function stillAt(t: { gate: GateClass; job: string | null; mandate: string | null }): boolean {
    try {
      if (t.job === null) return t.gate !== 'release' || (lastConfig !== null && mandateReleaseState(root, lastConfig, t.mandate!, (x) => mandateReleaseRefusal(root, lastConfig!, x)).status === 'pending');
      return t.gate === 'release' ? pendingReleaseHash(root, t.job, readEvents(root, t.job)) !== null : gateClassFor(root, loadJob(root, t.job)) === t.gate;
    } catch {
      return false;
    }
  }

  /** A stop or a usage limit: the claim goes back uncounted, and a limit holds new runs until it resets. */
  function giveBack(r: ForgeRequest, session: string, res: { limit?: { resetsAt: number | null }; message: string }): [GateRunOutcome, string] {
    releaseClaim(root, r.id, session);
    if (res.limit) {
      const t0 = Date.now();
      hold('limit', res.limit.resetsAt !== null && res.limit.resetsAt > t0 ? res.limit.resetsAt : t0 + retryWait(Math.max(1, streak)));
    }
    return ['requeued', res.message];
  }

  /** Shelves the job as the Foreman and acks; a refused shelve falls back to today's hand-off, so a person still sees it. */
  async function shelve(r: ForgeRequest, t: Target, c: Config, reason: string): Promise<[GateRunOutcome, string]> {
    try {
      const out = await recordForemanShelve(root, c, { id: t.job! }, t.gate, reason, authority);
      ack(r.id, 'done', cut(`shelved: ${out.shelved.reason}`));
      return ['shelved', out.shelved.reason];
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      if (!stillAt(t)) {
        ack(r.id, 'done', 'stale');
        return ['stale', 'the job moved off the gate'];
      }
      const why = cut(`shelve refused: ${errText(e)}`);
      handoff(t, 'escalated', why);
      ack(r.id, 'rejected', why);
      return ['escalated', why];
    }
  }

  /**
   * The senior pass (./senior.ts): seniorStart's checks, then its marker, one more forge:assistant on the senior's model
   * and effort, and its verdict recorded through the same checks; whatever it can't settle shelves the job.
   */
  async function escalate(r: ForgeRequest, t: Target, c: Config, entry: Live, first: SeniorFirst): Promise<[GateRunOutcome, string]> {
    const start = seniorStart(root, c, loadJob(root, t.job!), t.gate, first, Date.now());
    if (start.kind === 'stale') {
      ack(r.id, 'done', 'stale');
      return ['stale', 'the job no longer waits on this gate'];
    }
    if (start.kind === 'reserved') {
      handoff(t, 'reserved', `reserved: ${start.reason}`);
      ack(r.id, 'rejected', `reserved: ${start.reason}`);
      return ['reserved', cleanReason(start.reason)];
    }
    if (start.kind === 'shelve') return shelve(r, t, c, start.reason);
    if (closed || entry.stopping) return giveBack(r, entry.session, { message: 'the pool stopped' });
    const a = start.assist;
    recordSeniorPass(root, { id: t.job! }, t.gate, first.first, authority);
    const attempt = startAttempt(root, ctx, o, { brief: a.brief, model: a.model, effort: a.effort as Effort | null, log, senior: true });
    entry.attempt = attempt;
    log('senior-start', { run: entry.session, request: r.id, gate: t.gate, job: t.job, mandate: t.mandate, model: a.model, effort: a.effort, pid: attempt.pid });
    const res = await attempt.done;
    const s = entry.state;
    Object.assign(s, { attempts: s.attempts + res.attempts, usd: s.usd + res.usd, tokens: s.tokens + res.tokens });
    if ('failure' in res) {
      if (res.failure === 'stopped' || res.failure === 'spawn-refused' || res.limit) return giveBack(r, entry.session, res);
      return shelve(r, t, c, `senior pass failed: ${res.message}`);
    }
    return seniorDecide(r, t, c, res.verdict, res.reason, a.repos);
  }

  /** The senior's verdict, by the Behaviour table in docs/architecture/foreman.md › Senior pass. */
  async function seniorDecide(r: ForgeRequest, t: Target, c: Config, verdict: SeniorVerdict, reason: string, repos: string[] | undefined): Promise<[GateRunOutcome, string]> {
    if (verdict === 'shelve') return shelve(r, t, c, `senior pass: ${reason}`);
    const move = gateMove(t.gate, verdict);
    const note = cleanReason(`senior pass: ${reason}`);
    if (move === 'no-action') {
      ack(r.id, 'done', `no action: ${note}`);
      return ['no-action', note];
    }
    if (move === 'escalate' || !('action' in move)) return shelve(r, t, c, `senior pass escalated: ${reason}`);
    try {
      recordForemanDecision(root, c, loadJob(root, t.job!), move.action, note, repos ? { repos } : {}, authority);
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      if (!stillAt(t)) {
        ack(r.id, 'done', 'stale');
        return ['stale', 'the job moved off the gate'];
      }
      return shelve(r, t, c, `senior pass refused: ${cut(e.message)}`);
    }
    resume(t.job!);
    ack(r.id, 'done', `${verdict}: ${note}`);
    return [verdict as GateRunOutcome, note];
  }

  /** Records the verdict's decision and acks; returns the outcome and its reason. Throws only a non-ForgeError. */
  async function decide(r: ForgeRequest, t: Target, c: Config, entry: Live, verdict: Verdict, reason: string, malformed: boolean, repos: string[] | undefined): Promise<[GateRunOutcome, string]> {
    // Under escalations: foreman, a job gate's escalate or refused decision goes to the senior pass instead of a person.
    const senior = escalationsMode(c) === 'foreman' && seniorGate(t);
    let move = gateMove(t.gate, verdict);
    let note = reason;
    let shown: Verdict = verdict;
    // A thin request is not by itself a reason to escalate: once per person's decision, it comes back as revise-spec.
    if (move === 'escalate' && !malformed && t.gate === 'spec-approval' && t.job !== null && titleOnlyRevise(root, { id: t.job })) {
      writeTitleOnlyFeedback(root, t.job);
      move = { action: 'revise-spec' };
      note = cleanReason(`title-only request: ${reason}`);
      shown = 'revise';
    }
    if (move === 'escalate') {
      if (senior) return escalate(r, t, c, entry, { first: 'escalate', reason });
      handoff(t, 'escalated', reason);
      ack(r.id, 'rejected', `escalated: ${reason}`);
      return ['escalated', reason];
    }
    if (move === 'no-action') {
      ack(r.id, 'done', `no action: ${reason}`);
      return ['no-action', reason];
    }
    try {
      if ('draft' in move) await decideDraft(root, c, t.mandate!, move.draft, { note, foreman: true, actor: FOREMAN_ACTOR, tracker: () => loadTracker(root, c), env: {}, by: authority });
      else if (t.job === null) approveMandateRelease(root, c, t.mandate!, note, (x) => mandateReleaseRefusal(root, c, x), authority);
      else recordForemanDecision(root, c, loadJob(root, t.job!), move.action, note, repos ? { repos } : {}, authority);
    } catch (e) {
      if (!(e instanceof ForgeError)) throw e;
      if (!stillAt(t)) {
        ack(r.id, 'done', 'stale');
        return ['stale', 'the job moved off the gate'];
      }
      const why = cut(e.message);
      if (senior) return escalate(r, t, c, entry, { first: 'refused', reason: why });
      handoff(t, 'refused', why);
      ack(r.id, 'rejected', why);
      return ['refused', why];
    }
    if (t.job !== null && t.gate !== 'release') resume(t.job);
    ack(r.id, 'done', `${shown}: ${note}`);
    return [shown as GateRunOutcome, note];
  }

  /** A failed run: requeued (counted), or rejected when it had been requeued before, then a hand-off. Then the backoff. */
  function failed(r: ForgeRequest, t: { gate: GateClass; job: string | null }, session: string, message: string): [GateRunOutcome, string] {
    streak++;
    hold('retry', Date.now() + retryWait(streak));
    let out: { requeued: ForgeRequest[]; rejected: ForgeRequest[] } = { requeued: [], rejected: [] };
    try {
      out = requeueOrphanedRequests(root, { exited: [session], byAge: false });
    } catch (e) {
      log('error', { message: `requeue ${r.id}: ${errText(e)}` });
    }
    if (out.rejected.some((x) => x.id === r.id)) {
      handoff(t, 'escalated', 'its gate run failed twice');
      return ['failed', `${message}; ${REQUEUE_REJECTED}`];
    }
    return ['requeued', message];
  }

  /** One gate run, start to ack. Never rejects. */
  async function run(r: ForgeRequest, c: Config, entry: Live): Promise<void> {
    const { session, state: s } = entry;
    const t = { gate: s.gate, job: s.job, mandate: s.mandate };
    let outcome: GateRunOutcome = 'failed';
    let reason = '';
    try {
      // assist re-checks everything the request claims; reserved is recomputed, never taken from the file alone.
      let brief: string;
      let model: string | null;
      let effort: Effort | null;
      let repos: string[] | undefined;
      try {
        if (t.job === null) {
          const a = t.gate === 'release' ? assistMandateRelease(root, c, t.mandate!, r.id) : assistDraft(root, c, t.mandate!, r.id);
          if (a.stale) {
            ack(r.id, 'done', `stale: ${a.reason ?? ''}`);
            [outcome, reason] = ['stale', cleanReason(a.reason) || 'stale'];
            return;
          }
          if (a.reserved) {
            ack(r.id, 'rejected', `reserved: ${a.reserved}`);
            [outcome, reason] = ['reserved', cleanReason(a.reserved)];
            return;
          }
          [brief, model, effort] = [a.brief ?? '', a.model, a.effort as Effort | null];
        } else {
          const a = gateAssist(root, c, loadJob(root, t.job), t.gate);
          if (a.stale) {
            ack(r.id, 'done', 'stale');
            [outcome, reason] = ['stale', 'the job no longer waits on this gate'];
            return;
          }
          if (a.reserved) {
            handoff(t, 'reserved', `reserved: ${a.reserved}`);
            ack(r.id, 'rejected', `reserved: ${a.reserved}`);
            [outcome, reason] = ['reserved', cleanReason(a.reserved)];
            return;
          }
          [brief, model, effort, repos] = [a.brief, a.model, a.effort as Effort | null, a.repos];
        }
      } catch (e) {
        if (!(e instanceof ForgeError)) throw e;
        ack(r.id, 'rejected', cut(e.message));
        [outcome, reason] = ['refused', cut(e.message)];
        return;
      }
      if (closed) {
        releaseClaim(root, r.id, session);
        [outcome, reason] = ['requeued', 'the pool stopped'];
        return;
      }
      s.attempts = 0;
      const attempt = startAttempt(root, ctx, o, { brief, model, effort, log });
      entry.attempt = attempt;
      // Logged once the child is spawned, so the record carries its pid (null when the launch was refused).
      log('gate-start', { run: session, request: r.id, gate: t.gate, job: t.job, mandate: t.mandate, model, effort, pid: attempt.pid });
      const res: AttemptResult = await attempt.done;
      Object.assign(s, { attempts: res.attempts, usd: res.usd, tokens: res.tokens });
      if ('failure' in res) {
        [outcome, reason] = res.failure === 'stopped' || res.failure === 'spawn-refused' || res.limit ? giveBack(r, session, res) : failed(r, t, session, res.message);
        reason = cleanReason(reason);
        return;
      }
      // A verdict resets the backoff's exponent; a hold another run's failure set expires on its own.
      streak = 0;
      // Only a senior's parser takes shelve: the assistant's never returns it.
      const verdict: Verdict = res.verdict === 'shelve' ? 'escalate' : res.verdict;
      [outcome, reason] = await decide(r, t, c, entry, verdict, res.reason, res.malformed, repos);
    } catch (e) {
      // A non-ForgeError is an infrastructure failure: the request goes back through the counted requeue.
      log('error', { message: errText(e) });
      [outcome, reason] = failed(r, t, session, errText(e));
    } finally {
      live.delete(r.id);
      Object.assign(s, { status: 'done', outcome, reason: cut(reason) || null, endedAt: now() });
      done = [s, ...done].slice(0, KEPT);
      log('gate-end', { run: session, request: r.id, gate: t.gate, job: t.job, mandate: t.mandate, outcome, reason: s.reason, attempts: s.attempts, usd: s.usd, tokens: s.tokens, startedAt: s.startedAt });
      // A run that ends before its first await (stale, reserved, refused) runs this inside the pool's own tick, which
      // has no re-entrancy guard: the poke waits for that tick to return.
      queueMicrotask(() => {
        if (!closed) ctx.poke();
      });
    }
  }

  function start(r: ForgeRequest, c: Config): void {
    const session = `${SESSION_PREFIX}${crypto.randomUUID()}`;
    try {
      claimRequest(root, r.id, session);
    } catch {
      // Lost to another claimant (exit 3), or done meanwhile: skipped.
      return;
    }
    const t = targetOf(r);
    if (!t) {
      ack(r.id, 'rejected', 'invalid gate request: its gate class, job or mandate is not valid');
      return;
    }
    const state: GateRunState = { request: r.id, gate: t.gate, job: t.job, mandate: t.mandate, status: 'running', outcome: null, reason: null, startedAt: now(), endedAt: null, attempts: 0, usd: 0, tokens: 0 };
    const entry: Live = { session, state, attempt: null, flow: Promise.resolve(), stopping: false };
    live.set(r.id, entry);
    // The request's own reserved hit: handed off before assist, with no child spawned.
    const reserved = typeof r.args?.reserved === 'string' && r.args.reserved ? cleanReason(r.args.reserved) || 'reserved' : null;
    if (reserved) {
      entry.flow = (async () => {
        handoff(t, 'reserved', `reserved: ${reserved}`);
        ack(r.id, 'rejected', `reserved: ${reserved}`);
        live.delete(r.id);
        Object.assign(state, { status: 'done', outcome: 'reserved', reason: reserved, endedAt: now() });
        done = [state, ...done].slice(0, KEPT);
        log('gate-end', { run: session, request: r.id, gate: t.gate, job: t.job, mandate: t.mandate, outcome: 'reserved', reason: reserved, attempts: 0, usd: 0, tokens: 0, startedAt: state.startedAt });
      })();
      return;
    }
    entry.flow = run(r, c, entry);
  }

  async function stopAll(): Promise<void> {
    const entries = [...live.values()];
    // Marked first: a run whose assistant is settling must not start its senior pass once the stop has passed it.
    for (const e of entries) e.stopping = true;
    await Promise.all(entries.map((e) => e.attempt?.stop()));
    await Promise.all(entries.map((e) => e.flow));
  }

  return {
    take(config, pending) {
      lastConfig = config;
      if (closed || !gateRunsEnabled(config)) return;
      // Nothing waits: no meter read, and no cap hold left showing for a request a person has since decided.
      if (!pending.some((r) => r.type === 'gate')) {
        capHeld = null;
        return;
      }
      const t0 = Date.now();
      if (holdUntil !== null) {
        if (t0 < holdUntil) return;
        holdUntil = null;
      }
      // Fails closed: a meter that can't be read holds every run, as a reached cap does.
      let refusal: string | null;
      try {
        refusal = officeCapRefusal(root, config, t0)?.message ?? null;
      } catch (e) {
        refusal = `the office's daily cap can't be checked: ${errText(e)}`;
      }
      if (refusal !== capHeld) {
        capHeld = refusal;
        if (refusal) log('gate-held', { reason: 'daily-cap', until: null });
      }
      if (refusal) return;
      const parallel = gateParallel(config);
      for (const r of pending) {
        if (live.size >= parallel || closed || holdUntil !== null) break;
        if (r.type !== 'gate' || live.has(r.id)) continue;
        start(r, config);
      }
    },
    configure(config) {
      lastConfig = config;
    },
    sessions: () => [...live.values()].map((e) => e.session),
    recover() {
      const left = listRequests(root, { status: 'in-progress' }).filter((r) => r.type === 'gate' && typeof r.session === 'string' && r.session.startsWith(SESSION_PREFIX) && !live.has(r.id));
      if (!left.length) return;
      try {
        const out = requeueOrphanedRequests(root, { exited: left.map((r) => r.session!), byAge: false });
        for (const r of out.rejected) {
          const t = targetOf(r);
          if (t) handoff(t, 'escalated', 'its gate run failed twice');
        }
      } catch (e) {
        log('error', { message: `recover: ${errText(e)}` });
      }
    },
    state() {
      const t0 = Date.now();
      const held: GateRunsState['held'] =
        holdUntil !== null && t0 < holdUntil
          ? { reason: holdReason, until: new Date(holdUntil).toISOString(), message: holdReason === 'limit' ? 'a usage limit: gate runs wait for it to reset' : 'a gate run failed: the next waits out its backoff' }
          : capHeld
            ? { reason: 'daily-cap', until: null, message: capHeld }
            : null;
      const running = [...live.values()].map((e) => ({ ...e.state })).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      return { enabled: gateRunsEnabled(lastConfig), parallel: gateParallel(lastConfig), live: live.size, held, runs: [...running, ...done].slice(0, KEPT) };
    },
    stop: stopAll,
    async close() {
      closed = true;
      await stopAll();
    },
    killSync() {
      for (const e of live.values()) e.attempt?.killSync();
    },
  };
}
