// Intake (backlog): find an issue, create the worktree, adopt a PR and act on what it says, then plan or spec.
import { issueLinkStatus } from '#core/job/issue-link.ts';
import type { StepInput } from '../../types.ts';
import { park, run, set, toStage } from '../actions.ts';
import { lastEvent, prSyncedSince } from '../facts.ts';
import { inStage } from '../rules.ts';
import type { Table } from '../rules.ts';

// Under `auto` the spec-writer answers the planner's question first (splitCheck), and SP8 brings the planner in on a split.
const planningNeeded = (x: StepInput): boolean => x.config.pipeline.plan === 'always';
/** The PR's number for a reason or tell: digits only, since both reach argv (SAFE_ELEMENT has no `#`). */
const prNumber = (x: StepInput): string => (Number.isSafeInteger(Number(x.job.pr?.number)) && Number(x.job.pr?.number) > 0 ? String(Number(x.job.pr?.number)) : 'unknown');
const STATE_WORDS: Record<string, string> = { CLOSED: 'closed', MERGED: 'merged' };

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
    // An adopted PR: read it first, again after a person's decision, then act on what GitHub said.
    { id: 'I6', when: ({ x }) => Boolean(x.job.pr) && !prSyncedSince(x), then: ({ x }) => run(x, 'I6', ['pr', 'sync', x.job.id], 'read the adopted PR before continuing it') },
    // Sync leaves a closed PR at intake to this park rather than cancelling the job: a person reopens it or cancels.
    {
      id: 'I6b',
      when: ({ x }) => Boolean(x.job.pr) && x.job.pr!.state !== 'OPEN',
      then: ({ x }) => park(x, 'I6b', 'human', `adopted PR ${prNumber(x)} is ${STATE_WORDS[String(x.job.pr!.state)] ?? 'in an unknown state'}: reopen it on GitHub and approve, or cancel the job`),
    },
    {
      id: 'I6c',
      when: ({ x }) => Boolean(x.job.pr) && (x.job.pr!.conflicts === true || (x.job.pr!.behindBy ?? 0) > 0),
      then: ({ x }) => set(x, 'I6c', { stage: 'integrate', state: 'running' }, 'the adopted PR is behind or conflicts with its base: integrate it'),
    },
    {
      id: 'I6d',
      when: ({ x }) => Boolean(x.job.pr),
      then: ({ x }) =>
        set(
          x,
          'I6d',
          { stage: 'pr', state: 'waiting', waitingOn: 'pr-review', reason: `adopted PR ${prNumber(x)} waits on review` },
          'the adopted PR is open and up to date',
          `${x.job.id}: adopted PR ${prNumber(x)} waits on review; feedback or failing checks are answered from the PR row (Rework, Fix CI, Re-run) or by the pr-feedback gate`,
        ),
    },
    { id: 'I7', when: ({ x }) => planningNeeded(x), then: ({ x }) => toStage(x, 'I7', 'plan', 'pipeline.plan always: plan first') },
    { id: 'I8', when: () => true, then: ({ x }) => toStage(x, 'I8', 'spec', 'spec next: under plan auto the spec-writer checks for a split first') },
  ],
};
