// Intake (backlog): find an issue, create the worktree, adopt a PR, then plan or spec.
import { issueLinkStatus } from '../../core/job/issue-link.ts';
import type { StepInput } from '../../core/types.ts';
import { procedure, run, set, toStage } from '../actions.ts';
import { lastEvent } from '../facts.ts';
import { PLAN_AUTO_CHARS, PLAN_AUTO_LINES } from '../input.ts';
import { inStage } from '../rules.ts';
import type { Table } from '../rules.ts';

function planningNeeded(x: StepInput): boolean {
  const mode = x.config.pipeline.plan;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return x.request.length > PLAN_AUTO_CHARS || x.request.listLines >= PLAN_AUTO_LINES;
}

export const INTAKE: Table = {
  name: 'backlog',
  applies: inStage('backlog'),
  rules: [
    // Intake only searches: the human picks the issue at the spec gate (SP5), or before build (SP7).
    { id: 'I1', when: ({ x }) => issueLinkStatus(x.job, x.config) === 'missing' && !x.files.issueCandidates, then: ({ x }) => run(x, 'I1', ['job', 'link', x.job.id, '--suggest'], 'every job needs an issue: look for candidates') },
    { id: 'I3', when: ({ x }) => !x.worktreeExists, then: ({ x }) => run(x, 'I3', ['worktree', 'create', x.job.id], 'the job needs its worktree') },
    {
      id: 'I4',
      // By position, not timestamp: a backing failure can land in the same millisecond as its worktree event.
      when: ({ x }) => x.events.findLastIndex((e) => e.type === 'worktree-setup-failed') > x.events.findLastIndex((e) => e.type === 'worktree'),
      then: ({ x }) => set(x, 'I4', { state: 'failed', reason: 'worktree setup failed' }, 'the worktree setup command failed'),
    },
    {
      id: 'I5',
      when: ({ x }) => x.config.pr.enabled && x.job.kind !== 'eval' && !x.job.pr && !lastEvent(x, (e) => e.type === 'pr-find' || e.type === 'pr-adopted'),
      then: ({ x }) => run(x, 'I5', ['pr', 'find', x.job.id], 'continue an existing PR instead of forking it'),
    },
    { id: 'I6', when: ({ x }) => Boolean(x.job.pr), then: ({ x }) => procedure(x, 'I6', 'pr-lifecycle.md', 'PR exists') },
    { id: 'I7', when: ({ x }) => planningNeeded(x), then: ({ x }) => toStage(x, 'I7', 'plan', 'the request needs a plan') },
    { id: 'I8', when: () => true, then: ({ x }) => toStage(x, 'I8', 'spec', 'the request is small enough to spec directly') },
  ],
};
