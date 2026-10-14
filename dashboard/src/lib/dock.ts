// The job drawer's action dock: whether it shows and what it holds. The pure half of ActionDock.svelte.
import { pendingPrompts } from './permissions.ts';
import type { PendingPrompt } from './permissions.ts';
import { isDependencyPark, needsHuman, resumeModel } from './view.ts';
import type { ResumeModel } from './view.ts';
import type { DaemonPoolState, Job, OwnerStatus } from './types.ts';

export interface DockModel {
  show: boolean;
  /** This job's own session's prompts; the inbox's and other jobs' belong elsewhere. */
  prompts: PendingPrompt[];
  /** The gate's JobActions apply: a person must decide, or the job failed or is blocked. */
  actionable: boolean;
  resume: ResumeModel;
}

export function dockModel(job: Pick<Job, 'id' | 'state' | 'kind' | 'waitingOn' | 'reason'> & { ownerStatus?: OwnerStatus | null }, pool: Partial<DaemonPoolState> | null | undefined): DockModel {
  const prompts = pendingPrompts(pool, job.id);
  const actionable = needsHuman(job) || isDependencyPark(job) || job.state === 'failed' || job.state === 'blocked';
  const resume = resumeModel(job);
  return { show: prompts.length > 0 || actionable || resume.show, prompts, actionable, resume };
}
