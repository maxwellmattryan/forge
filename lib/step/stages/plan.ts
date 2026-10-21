// Plan: the planner decides one job or a split, and a split waits on a human unless split is auto.
import type { StepAction, StepInput } from '../../types.ts';
import { park, procedure, set, spawn, toStage } from '../actions.ts';
import { after, agent, ended, human, p, splitMode } from '../facts.ts';
import { generic } from '../generic.ts';

export function plan(x: StepInput): StepAction {
  const j = x.job;
  const planner = agent(x, 'planner');
  if (!ended(planner) || after(human(x, 'revise-split')?.ts, planner.startedAt) || after(human(x, 'reject-repos')?.ts, planner.startedAt)) return spawn(x, 'P1', 'planner');
  const g = generic(x, 'planner');
  if (g) return g;
  if (x.plan.verdict === 'SPLIT') {
    if (splitMode(x) === 'auto') return procedure(x, 'P2', 'split.md', 'PLAN: SPLIT under pipeline.split auto');
    // An approved split (a human's or the foreman's) sends the job back to plan/running: create the jobs.
    if (after(human(x, 'approve-split')?.ts, planner.endedAt)) return procedure(x, 'P2', 'split.md', 'PLAN: SPLIT approved');
    return set(x, 'P3', { stage: 'plan', state: 'waiting', waitingOn: 'split-approval', reason: `planner proposes ${x.plan.jobs} jobs` }, 'a human decides the split');
  }
  if (x.plan.verdict === 'SINGLE') return toStage(x, 'P4', 'spec', 'one job: write the spec', { tell: x.plan.recommendSplit ? `${j.id} plan recommends splitting: ${p(x, 'plan')}` : undefined });
  return park(x, 'P5', 'escalation', 'plan.md has no PLAN line');
}
