// Display names for stages and waiting reasons, typed as complete Records so tsc demands a label for every value lib/schema.mjs defines.
import type { Stage, WaitingOn } from './types.ts';

export const STAGE_LABEL: Record<Stage, string> = { backlog: 'Queued', plan: 'Plan', spec: 'Spec', design: 'Design', build: 'Build', verify: 'Verify', review: 'Review', decide: 'Decide', integrate: 'Integrate', pr: 'PR', done: 'Done' };
export const WAIT_LABEL: Record<WaitingOn, string> = {
  'spec-approval': 'Spec approval',
  input: 'Question for you',
  escalation: 'Escalated',
  infra: 'Infra steps',
  conflicts: 'Merge conflicts',
  'rounds-exhausted': 'Review rounds exhausted',
  'pr-review': 'PR review',
  external: 'External dependency',
  budget: 'Budget exceeded',
};
