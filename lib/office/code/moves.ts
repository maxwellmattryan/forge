// The code driver's moves: what it does after each `forge job advance` and each `forge job agent run` child ends, as
// pure functions of the child's exit and output and the turn's counters. lib/office/code/job-driver.ts acts on them;
// docs/architecture/daemon-runtime.md "Code driver" has the table in prose.
import { safeText } from '#core/text.ts';

/** How one forge child ended (startForge in ./children.ts). */
export interface ChildEnd {
  exit: number | null;
  signal: string | null;
  json: unknown;
  stderr: string;
}

/** A runner's end, with the role it ran. */
export interface RunnerEnd extends ChildEnd {
  role: string;
}

/** What the turn has seen so far: its runners in flight, and the failures and caps that count toward a park. */
export interface TurnState {
  /** The roles this driver has a runner for, in start order. */
  inFlight: readonly string[];
  /** Advances that failed in this turn, this one included. */
  failedAdvances: number;
  /** Advances that stopped at --max in this turn, this one included. */
  capped: number;
  /** Roles whose run already failed (auth, budget, error or timeout) once in this turn, before this end. */
  failedRoles: ReadonlySet<string>;
  /** The turn is being stopped (a pool or session stop): nothing more starts. */
  stopping: boolean;
}

export type EndWhy = 'gate' | 'done' | 'parked' | 'taken-over' | 'stopped';

export type Move =
  | { move: 'spawn'; roles: string[]; parallel: boolean }
  | { move: 'wait-runners' }
  | { move: 'end-lost'; roles: string[] }
  | { move: 'advance' }
  | { move: 'handoff'; reference: string }
  | { move: 'end'; why: EndWhy }
  /** Wait until `at` (ms), or a backoff when null; the turn's requests stay pending. */
  | { move: 'retry-later'; at: number | null }
  | { move: 'untrusted' }
  | { move: 'park'; waitingOn: 'escalation' | 'human'; reason: string; endLost?: string };

/** Failed advances in one turn before the driver parks the job. */
export const MAX_FAILED_ADVANCES = 3;
/** Advances that stop at their --max in one turn before the driver parks the job: a loop that never reaches a spawn. */
export const MAX_CAPPED = 10;
const REASON_CHARS = 200;
/** The role failures step's L1 respawns once in a turn before the driver parks. */
const RETRIED = new Set(['auth', 'budget', 'error', 'timeout']);

const record = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** A park reason: `code driver: …`, one line of at most 200 characters, with no control characters or backticks. */
export function parkReason(what: string): string {
  return safeText(`code driver: ${what}`.replace(/\s+/g, ' ').trim(), REASON_CHARS);
}

const park = (what: string, extra: { waitingOn?: 'escalation' | 'human'; endLost?: string } = {}): Move => ({ move: 'park', waitingOn: extra.waitingOn ?? 'escalation', reason: parkReason(what), ...(extra.endLost ? { endLost: extra.endLost } : {}) });

/** The CLI's error code on stdout (`{error: {code}}`), or null. */
const errorCode = (json: unknown): string | null => {
  const code = record(record(json).error).code;
  return typeof code === 'string' ? code : null;
};

/** What a failed child said: its stderr's last line, else its JSON error's message, else nothing. */
function detail(r: ChildEnd): string {
  const line = r.stderr.trim().split('\n').pop()?.trim();
  if (line) return line;
  return str(record(record(r.json).error).message);
}

/** How a child ended, for a reason: `exit N` or `signal S`, then what it said. */
const howEnded = (r: ChildEnd): string => [r.signal ? `signal ${r.signal}` : `exit ${r.exit}`, detail(r)].filter(Boolean).join(': ');

/** A secret scan refused what a child wrote: a person decides, never the Foreman. */
const secretPark = (command: string): Move => park(`secret scan blocked forge ${command}`, { waitingOn: 'human' });

/** The move after one `forge job advance --json` child ended. */
export function afterAdvance(r: ChildEnd, s: TurnState): Move {
  if (errorCode(r.json) === 'secret_found') return secretPark('job advance');
  if (r.signal === null && r.exit === 3) return { move: 'end', why: 'taken-over' };
  const a = record(r.json);
  if (r.signal === null && r.exit === 1 && a.failed === true) {
    if (a.parked === true) return { move: 'end', why: 'parked' };
    if (s.failedAdvances < MAX_FAILED_ADVANCES) return { move: 'advance' };
    return park(`advance failed ${s.failedAdvances} times: ${str(a.error) || howEnded(r)}`);
  }
  if (r.signal !== null || r.exit !== 0 || r.json === null) return park(`forge job advance: ${howEnded(r)}`);
  if (a.capped === true) return s.capped < MAX_CAPPED ? { move: 'advance' } : park(`advance capped ${MAX_CAPPED} times`);
  switch (a.action) {
    case 'spawn': {
      const list = [a, ...(Array.isArray(a.spawns) ? a.spawns : [])].map((x) => str(record(x).role)).filter(Boolean);
      const roles = list.filter((role, i) => !s.inFlight.includes(role) && list.indexOf(role) === i);
      if (!list.length) return park(`advance returned a spawn with no role (${str(a.rule)})`);
      return roles.length ? { move: 'spawn', roles, parallel: a.parallel === true } : { move: 'wait-runners' };
    }
    case 'wait': {
      if (a.waitingOn !== 'agents') return { move: 'end', why: 'gate' };
      if (s.inFlight.length) return { move: 'wait-runners' };
      const running = (Array.isArray(a.running) ? a.running : []).filter((x: unknown): x is string => typeof x === 'string' && x.length > 0);
      // Nothing runs them and nothing is said to run: advance again would only return the same wait.
      return running.length ? { move: 'end-lost', roles: running } : park(`advance waits on agents (${str(a.rule)}) but none is running`);
    }
    case 'procedure':
      return s.inFlight.length ? { move: 'wait-runners' } : { move: 'handoff', reference: str(a.reference) };
    case 'done':
      return { move: 'end', why: 'done' };
    default:
      return park(`forge job advance returned an action the driver can't take (${safeText(str(a.action), 40) || 'none'})`);
  }
}

/** The move after one `forge job agent run --json` child ended. */
export function afterRunner(r: RunnerEnd, s: TurnState): Move {
  if (s.stopping) return { move: 'end', why: 'stopped' };
  if (errorCode(r.json) === 'secret_found') return secretPark('job agent run');
  const o = record(r.json);
  const failure = record(o.failure);
  const cls = str(failure.class);
  const reason = str(failure.reason);
  if (r.signal === null) {
    if (r.exit === 3) return { move: 'end', why: 'taken-over' };
    if (r.exit === 0 && o.status === 'done') return { move: 'advance' };
    if (r.exit === 1 && errorCode(r.json) === 'stale_step') return { move: 'advance' };
    // Refused before anything was written (a missing worktree, a moved trust digest): no role ran, so none is lost.
    if (r.exit === 1 && errorCode(r.json) !== null) return park(`forge job agent run ${r.role}: ${howEnded(r)}`);
    if (r.exit === 1 && o.status === 'failed') {
      if (cls === 'limit') {
        const at = typeof failure.resetsAt === 'string' ? Date.parse(failure.resetsAt) : NaN;
        return { move: 'retry-later', at: Number.isFinite(at) ? at : null };
      }
      if (cls === 'untrusted') return { move: 'untrusted' };
      if (cls === 'interrupted') return park(`${r.role} interrupted: ${reason}`);
      if (RETRIED.has(cls)) return s.failedRoles.has(r.role) ? park(`${r.role} failed twice: ${cls}: ${reason}`) : { move: 'advance' };
    }
    if (r.exit === 5 && o.status === 'failed' && (cls === 'exit' || cls === 'spawn')) return park(`role child ${r.role} ${cls}: ${reason}`);
  }
  return park(`forge job agent run ${r.role}: ${howEnded(r)}`, { endLost: r.role });
}
