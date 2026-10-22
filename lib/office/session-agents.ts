// What a job session's agents say about keeping it. Apart from daemon.ts so `forge daemon status`
// reads it without loading the supervisor.
import { AGENT_LEASE_MS, loadJob } from '../core/job/store.ts';
import { INBOX_SCOPE, validJobId } from '../core/job/requests.ts';
import type { JobAgent } from '../core/types.ts';

/** What a job session's agents say about keeping it: sessionAgents. */
export interface SessionAgents {
  /** Roles of its owned agents marked running, sorted. */
  running: string[];
  /** A running agent started under AGENT_LEASE_MS ago: the session keeps its slot and isn't idle-stopped. */
  keeps: boolean;
  /** The latest endedAt across its owned agents, whatever their status. */
  lastEndAt: string | null;
  /** `role@startedAt` of each running agent that keeps it, sorted: one agent run, across rounds. */
  keeping: string[];
}

const noAgents = (): SessionAgents => ({ running: [], keeps: false, lastEndAt: null, keeping: [] });
/**
 * How far ahead of now a job.json time may be and still count (clock skew between writers).
 * job.json is the session's own to write, so a time further ahead is ignored: a future startedAt
 * would otherwise dodge the AGENT_LEASE_MS ceiling, and a future endedAt would hold the idle window
 * open for as long as it says.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * The agents a job session drives: those in its job.json, only while the job's lease driver is this
 * session. Another driver's agents (a human's terminal session, say), the inbox, and a missing or
 * unreadable job all give none, so a session can never be kept, or have agents marked lost, on
 * the strength of agents it doesn't drive. A running agent keeps it only for AGENT_LEASE_MS
 * after its start, the lease agent start gives, so a phantom can't hold a slot forever.
 */
export function sessionAgents(root: string, scope: string, sessionId: string | null, at = Date.now()): SessionAgents {
  // The office's scope is not a job id either, so it never has agents to keep it.
  if (scope === INBOX_SCOPE || !validJobId(scope) || !sessionId) return noAgents();
  let job;
  try {
    job = loadJob(root, scope);
  } catch {
    return noAgents();
  }
  if (job.lease.driver !== sessionId) return noAgents();
  const running: string[] = [];
  const keeping: string[] = [];
  let lastEnd = -Infinity;
  let lastEndAt: string | null = null;
  for (const [role, a] of Object.entries(job.agents ?? {}) as [string, JobAgent | undefined][]) {
    if (a?.status === 'running') {
      running.push(role);
      const started = typeof a.startedAt === 'string' ? Date.parse(a.startedAt) : NaN;
      if (Number.isFinite(started) && started <= at + CLOCK_SKEW_MS && at - started < AGENT_LEASE_MS) keeping.push(`${role}@${a.startedAt}`);
    }
    const endedAt = a?.endedAt;
    const ended = typeof endedAt === 'string' ? Date.parse(endedAt) : NaN;
    if (Number.isFinite(ended) && ended <= at + CLOCK_SKEW_MS && ended > lastEnd) {
      lastEnd = ended;
      lastEndAt = endedAt!;
    }
  }
  return { running: running.sort(), keeps: keeping.length > 0, lastEndAt, keeping: keeping.sort() };
}
