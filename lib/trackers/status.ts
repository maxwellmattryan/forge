import type { Job } from '../types.ts';

/**
 * Collapses Forge's stage/state into the handful of statuses trackers understand.
 * Adapters map these keys to labels, project columns, Jira transitions, etc.
 */
export function statusKey(job: Pick<Job, 'state' | 'stage'> & { waitingOn?: Job['waitingOn'] }): 'queued' | 'in-progress' | 'review' | 'blocked' | 'done' | 'cancelled' {
  if (job.state === 'done') return 'done';
  if (job.state === 'cancelled') return 'cancelled';
  if (job.stage === 'pr') return job.waitingOn === 'conflicts' ? 'blocked' : 'review';
  if (['waiting', 'blocked', 'failed'].includes(job.state)) return 'blocked';
  if (job.state === 'queued' || job.stage === 'backlog') return 'queued';
  return 'in-progress';
}

export const STATUS_KEYS = ['queued', 'in-progress', 'review', 'blocked', 'done', 'cancelled'];
