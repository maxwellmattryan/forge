// Display names for stages and waiting reasons, typed as complete Records so tsc demands a label for every value lib/core/job/schema.ts defines.
import type { Stage, WaitingOn } from './types.ts';

export const STAGE_LABEL: Record<Stage, string> = { backlog: 'Queued', plan: 'Plan', spec: 'Spec', design: 'Design', build: 'Build', verify: 'Verify', review: 'Review', decide: 'Decide', integrate: 'Integrate', pr: 'PR', done: 'Done' };
export const WAIT_LABEL: Record<WaitingOn, string> = {
  'spec-approval': 'Spec approval',
  'split-approval': 'Split approval',
  'issue-link': 'Issue to link',
  input: 'Question for you',
  escalation: 'Escalated',
  infra: 'Infra steps',
  conflicts: 'Merge conflicts',
  'rounds-exhausted': 'Review rounds exhausted',
  'pr-review': 'PR review',
  external: 'External dependency',
  budget: 'Budget exceeded',
  human: 'Human check',
  shelved: 'Shelved',
};
/** A dependency park's state chip: an external wait the engine set itself, so it needs no human. */
export const PARK_LABEL = 'Dependencies';
/** A budget wait the repo cap set (isRepoHold), not the job's own limits. */
export const REPO_HOLD_LABEL = 'Repo budget';
