// A stranded job: job.json says `running`, so no gate holds it, while nothing drives it. Two checks
// keep one from sitting unseen: `forge job advance` parks a job whose same command failed twice with
// no progress between (lib/commands/advance.ts), and the pool checks every job session's turn end
// (lib/daemon-pool.ts): a turn that leaves its job running and undriven gets one resume, and a second
// such turn with no progress parks it on escalation, which the foreman decides.
// docs/ARCHITECTURE.md "Stranded jobs".
import type { Job, JobEvent, OwnerStatus } from './types.ts';

/** Event types that mean the pipeline moved; heartbeats, syncs, notes and failures don't count. */
export const PROGRESS_EVENTS: ReadonlySet<string> = new Set(['transition', 'round', 'verify', 'agent-start', 'agent-end', 'human', 'integrated', 'integration-review', 'pr-opened', 'pr-updated', 'pr-head-pulled', 'verdicts']);

/** The newest progress event's time, or null: what a later turn end or failure compares against. */
export function progressMark(events: Pick<JobEvent, 'type' | 'ts'>[]): string | null {
  return events.findLast((e) => PROGRESS_EVENTS.has(e.type))?.ts ?? null;
}

/**
 * A job session's turn ended with its job still `running` and nothing else to drive it: no request
 * pending, no agents running, and no live owner but the session itself (a person who
 * took the job over drives it).
 */
export function strandedAfterTurn(x: { job: Pick<Job, 'state'>; requested: boolean; agents: boolean; owner: Pick<OwnerStatus, 'status' | 'jobSession'> }): boolean {
  if (x.job.state !== 'running' || x.requested || x.agents) return false;
  return !(x.owner.status === 'live' && !x.owner.jobSession);
}

/**
 * What the pool does about a stranded turn end, given the progress mark at the last resume it queued
 * for the job: resume the first time, escalate when the resume's turn ended stranded with no progress.
 */
export function strandedAction(lastResumeMark: string | null | undefined, mark: string | null): 'resume' | 'escalate' {
  return lastResumeMark !== undefined && lastResumeMark === mark ? 'escalate' : 'resume';
}
