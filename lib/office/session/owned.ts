// What a session answers for: whether its job's agents keep it (sessionAgents, which `forge daemon status`
// reads without loading the supervisor), the reconciler's facts, the one release
// (lib/office/driver.ts releaseSession) its exit runs over every id it has had, and the resumes its working turns took up.
import { defaults } from '#core/config/load.ts';
import { AGENT_LEASE_MS, loadJob } from '#core/job/store.ts';
import { INBOX_SCOPE, RESUME_TAKEN_UP, closeIfOpen, sharedScope, validJobId } from '#core/job/requests.ts';
import type { SessionFacts } from '../reconcile.ts';
import { drivenBy, recordIds, releaseSession } from '../driver.ts';
import type { SessionCore } from './contract.ts';
import type { Config, ForgeRequest, JobAgent } from '#core/types.ts';

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
 * The agents a job session drives: those in its job.json, only while the job's lease driver is one
 * of this session's ids (recordIds). Another driver's agents (a human's terminal session, say), the
 * inbox, and a missing or unreadable job all give none, so a session can never be kept on the
 * strength of agents it doesn't drive. A running agent keeps it only for AGENT_LEASE_MS
 * after its start, the lease agent start gives, so a phantom can't hold a slot forever.
 */
export function sessionAgents(root: string, scope: string, ids: readonly string[], at = Date.now()): SessionAgents {
  // The office's and a chat's scopes are not job ids either, so they never have agents to keep them.
  if (scope === INBOX_SCOPE || !validJobId(scope) || !ids.length) return noAgents();
  let job;
  try {
    job = loadJob(root, scope);
  } catch {
    return noAgents();
  }
  if (!drivenBy(job, ids)) return noAgents();
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

export function createOwned(core: SessionCore) {
  const { root, scope, o } = core;
  const agents = (at?: number) => sessionAgents(root, scope, recordIds(core.info), at);

  function computeKept(): 'agents' | null {
    return core.child && core.status !== 'stopping' && agents().keeps ? 'agents' : null;
  }

  function keptBy(at = Date.now()): 'agents' | null {
    return agents(at).keeps ? 'agents' : null;
  }

  function facts(): SessionFacts {
    const background = core.child?.meta.background;
    return { ids: recordIds(core.info), status: core.status, background: typeof background === 'number' ? background : -1, idleSince: core.status === 'idle' ? core.lastResultAt : null };
  }

  /**
   * The child is gone, so nothing it held is driven: every job one of its ids drives has its running
   * agents marked lost (the next session's step respawns or retries them instead of waiting on
   * phantoms) and its live lease expired, and requests it claimed go back to pending. No claim-age
   * rule: this session can't see which of the pool's others are mid-turn; the pool's reconciler can.
   * Never throws: an exit must finish.
   */
  function release(reason: string): void {
    let cfg: Config;
    try {
      cfg = o.readConfig(root).config;
    } catch {
      cfg = defaults();
    }
    const r = releaseSession(root, recordIds(core.info), { reason, config: cfg });
    for (const j of r.jobs) {
      if (j.lost.length) core.logEvent('agents-lost', { job: j.job, roles: j.lost });
      if (j.expired) core.logEvent('lease-expired', { job: j.job, session: j.expired, reason });
    }
    if (r.requeued.length || r.rejected.length) core.logEvent('requeued', { requests: r.requeued, rejected: r.rejected });
    for (const message of r.errors) core.logEvent('error', { message });
  }

  /**
   * A working turn written for `ids` has ended: each of them that is a `resume` for this job, still pending or claimed
   * under one of this session's own ids, is closed `done`, so it no longer reads as a decision in flight. Read under the
   * requests lock: another type, another session's claim and an ack already made are left as they are. The inbox,
   * office and chat close nothing. Never throws.
   */
  function takeUp(ids: readonly string[]): void {
    const closed = closeResumes(root, scope, ids, recordIds(core.info));
    if (closed.length) core.logEvent('requests-closed', { requests: closed });
  }

  return { agents, computeKept, keptBy, facts, release, takeUp };
}

/**
 * Closes `done` (RESUME_TAKEN_UP) each of `ids` that is a `resume` for job `scope`, still pending or claimed under one of
 * `mine`, and returns the ids it closed: a session's working turn (takeUp) or a code turn (lib/office/code/job-driver.ts)
 * took them up. Read under the requests lock: another type, another driver's claim and an ack already made are left as
 * they are. The inbox, office and chat scopes close nothing. Never throws.
 */
export function closeResumes(root: string, scope: string, ids: readonly string[], mine: readonly string[]): string[] {
  if (sharedScope(scope) || !validJobId(scope)) return [];
  const ours = (r: ForgeRequest) => r.type === 'resume' && r.job === scope && (r.status === 'pending' || (typeof r.session === 'string' && mine.includes(r.session)));
  const closed: string[] = [];
  for (const id of ids) {
    try {
      if (closeIfOpen(root, id, ours, { status: 'done', result: RESUME_TAKEN_UP })) closed.push(id);
    } catch {}
  }
  return closed;
}
