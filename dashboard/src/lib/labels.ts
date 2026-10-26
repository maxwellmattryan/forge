// Display names for stages and waiting reasons, typed as complete Records so tsc demands a label for every value lib/core/job/schema.ts defines.
import type { GateClass, Stage, WaitingOn } from './types.ts';

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
};
/** A gate class's name, for a gate run: the waiting reason's label where the class is one, else its own. */
export const GATE_LABEL: Record<GateClass, string> = {
  'spec-approval': WAIT_LABEL['spec-approval'],
  'split-approval': WAIT_LABEL['split-approval'],
  escalation: WAIT_LABEL.escalation,
  'rounds-exhausted': WAIT_LABEL['rounds-exhausted'],
  conflicts: WAIT_LABEL.conflicts,
  'pr-feedback': 'PR feedback',
  'repo-proposal': 'Repo proposal',
  release: 'Release plan',
  'milestone-approval': 'Milestone draft',
};
/** A dependency park's state chip: an external wait the engine set itself, so it needs no human. */
export const PARK_LABEL = 'Dependencies';
/** A budget wait the repo cap set (isRepoHold), not the job's own limits. */
export const REPO_HOLD_LABEL = 'Repo budget';
