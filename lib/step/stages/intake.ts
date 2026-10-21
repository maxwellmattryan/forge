// Intake (backlog): find an issue, create the worktree, adopt a PR, then plan or spec.
import { issueLinkStatus } from '../../issue-link.ts';
import type { StepAction, StepInput } from '../../types.ts';
import { procedure, run, set, toStage } from '../actions.ts';
import { lastEvent } from '../facts.ts';
import { PLAN_AUTO_CHARS, PLAN_AUTO_LINES } from '../input.ts';

function planningNeeded(x: StepInput): boolean {
  const mode = x.config.pipeline.plan;
  if (mode === 'always') return true;
  if (mode === 'never') return false;
  return x.request.length > PLAN_AUTO_CHARS || x.request.listLines >= PLAN_AUTO_LINES;
}

export function intake(x: StepInput): StepAction {
  const j = x.job;
  // Intake only searches: the human picks the issue at the spec gate (SP5), or before build (SP7).
  if (issueLinkStatus(j, x.config) === 'missing' && !x.files.issueCandidates) return run(x, 'I1', ['job', 'link', j.id, '--suggest'], 'every job needs an issue: look for candidates');
  if (!x.worktreeExists) return run(x, 'I3', ['worktree', 'create', j.id], 'the job needs its worktree');
  // By position, not timestamp: a backing failure can land in the same millisecond as its worktree event.
  const wt = x.events.findLastIndex((e) => e.type === 'worktree');
  const failed = x.events.findLastIndex((e) => e.type === 'worktree-setup-failed');
  if (failed >= 0 && failed > wt) return set(x, 'I4', { state: 'failed', reason: 'worktree setup failed' }, 'the worktree setup command failed');
  if (x.config.pr.enabled && j.kind !== 'eval' && !j.pr && !lastEvent(x, (e) => e.type === 'pr-find' || e.type === 'pr-adopted')) return run(x, 'I5', ['pr', 'find', j.id], 'continue an existing PR instead of forking it');
  if (j.pr) return procedure(x, 'I6', 'pr-lifecycle.md', 'PR exists');
  if (planningNeeded(x)) return toStage(x, 'I7', 'plan', 'the request needs a plan');
  return toStage(x, 'I8', 'spec', 'the request is small enough to spec directly');
}
