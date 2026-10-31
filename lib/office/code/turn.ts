// One code turn of the code driver (./job-driver.ts): the claim, `forge job apply` for each request of the turn, then
// `forge job advance` and one `forge job agent run` per spawn as child processes, acting on each child's end through the
// moves table (./moves.ts) until a gate, `done`, a park, a takeover, a usage limit, a procedure hand-off or a stop. Every
// forge child passes the launch checks first and gets a job session's env in the job's own scope.
import { TRUST_ENV } from '#core/config/load.ts';
import { SCOPE_ENV, closeIfOpen, listRequests, validRequestId } from '#core/job/requests.ts';
import { loadJob } from '#core/job/store.ts';
import { sessionEnv } from '#integrations/claude/argv.ts';
import { spawnConfinement } from '../session/confine.ts';
import { checkLaunch } from '../session/launch.ts';
import { startForge, type ForgeExit, type ForgeRun } from './children.ts';
import { afterAdvance, afterRunner, parkReason, type Move, type TurnState } from './moves.ts';
import type { Relay } from './relay.ts';
import type { SessionContext, SessionOptions } from '../session/contract.ts';
import type { ForgeRequest } from '#core/types.ts';

/** How a code turn ended: a moves-table end, the claim's refusal, a usage limit, or a procedure handed to the session. */
export type TurnEnd = 'gate' | 'done' | 'parked' | 'taken-over' | 'stopped' | 'refused' | 'limit' | 'handoff';

/** Advances in one turn before the driver parks the job: far past any real stretch between gates. */
const MAX_ADVANCES = 200;
/** The role failures step's L1 respawns: the second in a turn parks (moves.ts). */
const RETRIED = ['auth', 'budget', 'error', 'timeout'];

/** One role run of the turn: its runner child and what it reported. */
interface Runner {
  role: string;
  run: ForgeRun;
  /** Settles on the runner's `started` message, or its exit. */
  started: Promise<void>;
  markStarted: () => void;
  /** The role child's pid, as the runner reported it (the leader of its own group); only this runner's report counts. */
  childPid: number | null;
  /** When the runner exit that led to this spawn happened (ms); null for a turn's first role. */
  handoffFrom: number | null;
  replied: boolean;
}

export interface Turn {
  ids: string[];
  epoch: number;
  stopping: boolean;
  /** The children running now: runners and the forge calls between them. */
  children: Set<ForgeRun>;
  runners: Map<string, Runner>;
  /** Runner ends not yet acted on, oldest first. */
  ended: { runner: Runner; end: ForgeExit }[];
  wake: (() => void) | null;
  failedAdvances: number;
  capped: number;
  failedRoles: Set<string>;
  /** Roles the driver ended `lost` in this turn: one still running after that parks instead. */
  endedLost: Set<string>;
  advances: number;
  /** The last runner exit acted on, for the next spawn's hand-off time. */
  lastExitAt: number | null;
  /** A usage limit's reset (ms), or null for a backoff the driver picks; set with the `limit` end. */
  limitAt: number | null;
  /** Set when the loop hands off: the procedure step's reference. */
  reference: string | null;
  startedAt: string;
}

/** What a turn needs from its driver. */
export interface TurnDeps {
  root: string;
  scope: string;
  /** The driver's stable id: the session every claim, advance and run names. */
  id: string;
  ctx: SessionContext;
  o: SessionOptions;
  relay: Relay;
  /** A `forge-daemon` line in the scope's log. */
  log(event: string, message: string, extra?: Record<string, unknown>): void;
  /** The driver's lastError, which the dashboard shows. */
  fail(message: string): void;
}

export function newTurn(ids: readonly string[]): Turn {
  return {
    ids: [...ids],
    epoch: 0,
    stopping: false,
    children: new Set(),
    runners: new Map(),
    ended: [],
    wake: null,
    failedAdvances: 0,
    capped: 0,
    failedRoles: new Set(),
    endedLost: new Set(),
    advances: 0,
    lastExitAt: null,
    limitAt: null,
    reference: null,
    startedAt: new Date().toISOString(),
  };
}

const record = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
export const oneLine = (s: unknown, max = 200): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** A job session's env for a forge child, after the launch checks; null when one refused (the pool then stops itself). */
function childEnv(d: TurnDeps): NodeJS.ProcessEnv | null {
  const launch = checkLaunch(d.root, d.ctx, d.o);
  if (!launch) return null;
  const c = launch.config;
  return { ...sessionEnv(d.o.env, c.daemon.auth), ...spawnConfinement(d.root, c).env, FORGE_ROOT: d.root, [TRUST_ENV]: launch.trusted, [SCOPE_ENV]: d.scope };
}

function timeoutMs(d: TurnDeps): number | null {
  if (d.o.turnTimeoutMs !== null) return d.o.turnTimeoutMs;
  let minutes: unknown;
  try {
    minutes = d.ctx.config().daemon?.turnTimeoutMinutes;
  } catch {}
  return typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : null;
}

/** One forge call of the turn, waited for; null when the launch checks refused it or the turn is stopping. */
async function forge(d: TurnDeps, t: Turn, args: string[]): Promise<ForgeExit | null> {
  if (t.stopping) return null;
  const env = childEnv(d);
  if (!env) return null;
  const run = startForge(d.root, args, { env, timeoutMs: timeoutMs(d), graceMs: d.o.graceMs });
  t.children.add(run);
  try {
    return await run.done;
  } finally {
    t.children.delete(run);
  }
}

function startRunner(d: TurnDeps, t: Turn, role: string): Runner | null {
  const env = childEnv(d);
  if (!env) return null;
  let markStarted!: () => void;
  const started = new Promise<void>((r) => (markStarted = r));
  const runner: Runner = { role, run: null as unknown as ForgeRun, started, markStarted, childPid: null, handoffFrom: t.lastExitAt, replied: false };
  runner.run = startForge(d.root, ['job', 'agent', 'run', d.scope, '--session', d.id, '--epoch', String(t.epoch), '--role', role, '--ipc'], {
    env,
    // The runner bounds its own child by daemon.turnTimeoutMinutes; a stop is how the driver ends it.
    timeoutMs: null,
    graceMs: d.o.graceMs,
    onMessage: (m) => onRunnerMessage(d, runner, m),
  });
  t.children.add(runner.run);
  t.runners.set(role, runner);
  d.log('role-start', `started ${role}'s role run (pid ${runner.run.pid ?? 'none'})`, { role, pid: runner.run.pid });
  void runner.run.done.then((end) => {
    t.children.delete(runner.run);
    t.runners.delete(role);
    runner.markStarted();
    d.relay.drop(runner.run);
    t.ended.push({ runner, end });
    t.wake?.();
  });
  return runner;
}

function onRunnerMessage(d: TurnDeps, runner: Runner, msg: unknown): void {
  const m = record(msg);
  if (m.type !== 'forge-role') return;
  switch (m.event) {
    case 'started':
      return runner.markStarted();
    case 'child':
      // Never this server's own process or its parent's: a group the driver may later signal.
      if (runner.childPid === null && Number.isInteger(m.pid) && m.pid > 1 && m.pid !== process.pid && m.pid !== process.ppid) runner.childPid = m.pid;
      return;
    case 'reply': {
      if (runner.replied) return;
      runner.replied = true;
      // The hand-off metric: from the runner exit that led to this spawn to this child's first assistant message.
      const handoffMs = runner.handoffFrom === null ? null : Math.max(0, Date.now() - runner.handoffFrom);
      return d.log('role-reply', `${runner.role} replied${handoffMs === null ? '' : ` ${handoffMs} ms after the last role ended`}`, { role: runner.role, handoffMs });
    }
    default:
      return d.relay.message(runner.run, runner.role, msg);
  }
}

/** SIGTERM to a dead runner's role child group, SIGKILL after the grace: only a pid that runner itself reported. */
function killChildGroup(d: TurnDeps, pid: number | null): void {
  if (pid === null) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {}
  };
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), d.o.graceMs).unref?.();
}

/** The next runner end, waiting for one; null when no runner is left to end. */
async function nextEnd(t: Turn): Promise<{ runner: Runner; end: ForgeExit } | null> {
  while (!t.ended.length) {
    if (!t.runners.size) return null;
    await new Promise<void>((r) => (t.wake = r));
    t.wake = null;
  }
  return t.ended.shift()!;
}

const view = (t: Turn): TurnState => ({
  // A runner whose end is not acted on yet is still in flight: its role is not spawned twice.
  inFlight: [...t.runners.keys(), ...t.ended.map((e) => e.runner.role)],
  failedAdvances: t.failedAdvances,
  capped: t.capped,
  failedRoles: t.failedRoles,
  stopping: t.stopping,
});

/** A runner's end into the log; a runner killed by a signal also has its role child's group stopped. */
function logEnd(d: TurnDeps, runner: Runner, end: ForgeExit): Record<string, any> {
  const out = record(end.json);
  const failure = record(out.failure);
  const how = end.signal ? `killed by ${end.signal}` : `exit ${end.exit}`;
  const status = typeof out.status === 'string' ? out.status : null;
  d.log('role-end', `${runner.role}'s role run ended (${how}${status ? `, ${status}` : ''}${typeof failure.class === 'string' ? `: ${failure.class}` : ''})`, { role: runner.role, exit: end.exit, signal: end.signal, status });
  if (end.signal !== null) killChildGroup(d, runner.childPid);
  return failure;
}

/** One runner's end, logged and turned into the next move. */
async function runnerMove(d: TurnDeps, t: Turn): Promise<Move> {
  const next = await nextEnd(t);
  if (!next) return { move: 'advance' };
  const failure = logEnd(d, next.runner, next.end);
  const m = afterRunner({ role: next.runner.role, ...next.end }, view(t));
  if (RETRIED.includes(String(failure.class))) t.failedRoles.add(next.runner.role);
  t.lastExitAt = Date.now();
  return m;
}

/** Waits for every runner of the turn to end. */
async function waitRunners(d: TurnDeps, t: Turn): Promise<void> {
  for (let next = await nextEnd(t); next; next = await nextEnd(t)) logEnd(d, next.runner, next.end);
}

/** Every child of the turn stopped (SIGTERM, then SIGKILL after the grace), and every runner's end waited for. */
export async function stopRunners(d: TurnDeps, t: Turn): Promise<void> {
  await Promise.all([...t.children].map((c) => c.stop()));
  await waitRunners(d, t);
}

/** Last resort from a process `exit` handler: SIGTERM to every child's group. */
export function killTurnSync(t: Turn): void {
  for (const c of t.children) {
    if (c.pid === null) continue;
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {}
  }
}

/** Ends a role nothing runs as `lost`, with the driver's summary, through the CLI. */
async function endLost(d: TurnDeps, t: Turn, role: string, summary: string): Promise<void> {
  const r = await forge(d, t, ['job', 'agent', d.scope, 'end', '--role', role, '--status', 'lost', `--summary=${summary}`, '--epoch', String(t.epoch)]);
  if (r && r.exit !== 0) d.log('error', `could not end ${role} lost: ${oneLine(r.stderr) || `exit ${r.exit}`}`);
}

/** Parks the job for a person or the Foreman, through the CLI; never silent when it can't. */
async function park(d: TurnDeps, t: Turn, m: Extract<Move, { move: 'park' }>): Promise<void> {
  let state: string | null = null;
  try {
    state = loadJob(d.root, d.scope).state;
  } catch {}
  if (state !== 'running') return d.fail(`code driver: not parked (the job is ${state ?? 'unreadable'}): ${m.reason}`);
  d.log('park', `parking on ${m.waitingOn}: ${m.reason}`, { waitingOn: m.waitingOn, reason: m.reason });
  const r = await forge(d, t, ['job', 'set', d.scope, '--state', 'waiting', '--waiting-on', m.waitingOn, `--reason=${m.reason}`, '--epoch', String(t.epoch)]);
  if (r !== null && r.exit !== 0) d.fail(`code driver: parking the job failed (${oneLine(r.stderr) || `exit ${r.exit}`}): ${m.reason}`);
}

/** The turn's requests, oldest first; [] when they can't be read (the driver's lastError says so). */
function turnRequests(d: TurnDeps, t: Turn): ForgeRequest[] {
  const wanted = new Set(t.ids);
  try {
    return listRequests(d.root)
      .filter((r) => wanted.has(r.id))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id));
  } catch (e) {
    d.fail(`code driver: the requests can't be read: ${oneLine((e as Error).message)}`);
    return [];
  }
}

/** A request of the turn this driver may still act on: this job's, open, and claimed by no other session. */
const ours = (d: TurnDeps) => (q: ForgeRequest): boolean => q.job === d.scope && (q.status === 'pending' || (q.status === 'in-progress' && q.session === d.id));

/**
 * Each request of the turn (those `only` keeps), oldest first, through `forge job apply`, which records it by the
 * human-command table and acks it, or gives a plain resume back pending. Only the job id and a request id in the
 * request grammar reach argv. A failure is logged and the turn goes on.
 */
async function applyRequests(d: TurnDeps, t: Turn, only: (q: ForgeRequest) => boolean = () => true): Promise<void> {
  for (const q of turnRequests(d, t).filter(ours(d)).filter(only)) {
    if (!validRequestId(q.id)) continue;
    const r = await forge(d, t, ['job', 'apply', d.scope, '--request', q.id, '--session', d.id]);
    if (r === null) return;
    const out = record(r.json);
    const type = oneLine(q.type, 20);
    if (r.signal === null && r.exit === 0) {
      const status = oneLine(out.status, 20);
      const result = oneLine(out.result);
      // `requestType`, not `type`: every log line's own `type` is forge-daemon.
      d.log('applied', `${type} request ${q.id}: ${status}: ${result}`, { request: q.id, requestType: type, status, result, createdAt: oneLine(q.createdAt, 40) });
    } else if (r.signal === null && r.exit === 3) d.log('apply-skipped', `${type} request ${q.id}: another session is handling it`, { request: q.id, requestType: type });
    else d.fail(`code driver: applying ${type} request ${q.id} failed: ${oneLine(record(out.error).message || r.stderr || `exit ${r.exit ?? r.signal}`)}`);
  }
}

/** Closes each request of the turn still open: `close` for a resume, `others` for any other type. */
function closeTurnRequests(d: TurnDeps, t: Turn, close: { status: 'done' | 'rejected'; result: string }, others = close): void {
  const open = ours(d);
  for (const q of turnRequests(d, t)) {
    try {
      closeIfOpen(d.root, q.id, open, q.type === 'resume' ? close : others);
    } catch {}
  }
}

/** The claim; null when it held, else how the turn ends (its requests already closed). */
async function claim(d: TurnDeps, t: Turn): Promise<TurnEnd | null> {
  const r = await forge(d, t, ['job', 'claim', d.scope, '--session', d.id]);
  if (r === null) return 'stopped';
  const out = record(r.json);
  if (r.signal === null && r.exit === 0 && Number.isInteger(out.epoch)) {
    t.epoch = out.epoch;
    d.log('claim', `claimed the job at epoch ${t.epoch}`, { epoch: t.epoch });
    return null;
  }
  const message = oneLine(record(out.error).message || r.stderr || `exit ${r.exit ?? r.signal}`, 500);
  let close: { status: 'done' | 'rejected'; result: string };
  if (r.signal === null && r.exit === 3) {
    let other = 'another session';
    try {
      other = loadJob(d.root, d.scope).lease.driver ?? other;
    } catch {}
    close = { status: 'rejected', result: `job is driven by session ${other}` };
    closeTurnRequests(d, t, close);
  } else if (r.signal === null && r.exit === 4) {
    // Blocked (a dependency, the repo budget): a person's decision still lands, and the resumes have nothing to drive.
    close = { status: 'done', result: message };
    await applyRequests(d, t, (q) => q.type !== 'resume');
    closeTurnRequests(d, t, close, { status: 'rejected', result: message });
  } else {
    close = { status: 'rejected', result: message };
    d.fail(`code driver: the claim failed: ${message}`);
    closeTurnRequests(d, t, close);
  }
  d.log('claim', `not claimed: ${close.result}`, { claimed: false });
  return 'refused';
}

/** The claim, then the driver's moves until the turn ends. */
export async function driveTurn(d: TurnDeps, t: Turn): Promise<TurnEnd> {
  const refused = await claim(d, t);
  if (refused !== null) return refused;
  // A person's decisions and the dashboard's Resume buttons land before step is asked; plain resumes stay pending.
  await applyRequests(d, t);
  let m: Move = { move: 'advance' };
  for (;;) {
    if (t.stopping) return 'stopped';
    switch (m.move) {
      case 'advance': {
        // A loop step can't settle (a role that keeps going stale, say) must end with a person, never spin.
        if (++t.advances > MAX_ADVANCES) {
          m = { move: 'park', waitingOn: 'escalation', reason: parkReason(`advanced ${MAX_ADVANCES} times in one turn without reaching a gate`) };
          continue;
        }
        const a = await forge(d, t, ['job', 'advance', d.scope, '--session', d.id, '--epoch', String(t.epoch)]);
        if (a === null || t.stopping) return 'stopped';
        const data = record(a.json);
        if (a.signal === null && a.exit === 1 && data.failed === true) t.failedAdvances++;
        if (a.signal === null && a.exit === 0 && data.capped === true) t.capped++;
        for (const r of Array.isArray(data.ran) ? data.ran.slice(0, 50) : []) {
          const e = record(r);
          const command = `forge ${(Array.isArray(e.command) ? e.command : []).slice(0, 3).map((w: unknown) => oneLine(w, 60)).join(' ')}`;
          d.log('ran', `${oneLine(e.rule, 12)}: ${command}${e.ok === true ? '' : ' failed'}`, { rule: oneLine(e.rule, 12), command, ok: e.ok === true });
        }
        m = afterAdvance(a, view(t));
        continue;
      }
      case 'spawn': {
        const fresh: Runner[] = [];
        for (const role of m.roles) {
          const runner = startRunner(d, t, role);
          if (!runner) return 'stopped';
          fresh.push(runner);
        }
        // All in one tick, then each must report its start (or exit) before step is asked again.
        await Promise.all(fresh.map((r) => r.started));
        if (t.stopping) return 'stopped';
        m = m.parallel ? { move: 'advance' } : await runnerMove(d, t);
        continue;
      }
      case 'wait-runners':
        m = await runnerMove(d, t);
        continue;
      case 'end-lost': {
        const again: string[] = m.roles.filter((role) => t.endedLost.has(role));
        if (again.length) {
          m = { move: 'park', waitingOn: 'escalation', reason: parkReason(`${again.join(', ')} still running after the driver ended it lost`) };
          continue;
        }
        for (const role of m.roles) {
          t.endedLost.add(role);
          await endLost(d, t, role, parkReason(`${role} was running with no runner of this driver`));
        }
        m = { move: 'advance' };
        continue;
      }
      case 'handoff':
        await waitRunners(d, t);
        t.reference = m.reference;
        return 'handoff';
      case 'end':
        if (m.why === 'taken-over') await stopRunners(d, t);
        return m.why;
      case 'retry-later':
        // The other runners finish their work; the turn's requests stay pending for the next one.
        await waitRunners(d, t);
        t.limitAt = m.at;
        return 'limit';
      case 'untrusted':
        d.ctx.untrusted();
        return 'stopped';
      case 'park':
        if (m.endLost) await endLost(d, t, m.endLost, m.reason);
        await stopRunners(d, t);
        await park(d, t, m);
        return 'parked';
    }
  }
}
