// Plan: the planner decides one job or a split, and a split waits on a human unless split is auto.
import type { StepInput } from '../../types.ts';
import { park, run, set, spawn, toStage } from '../actions.ts';
import { after, agent, ended, human, p, splitMode } from '../facts.ts';
import { genericRows } from '../generic.ts';
import { inStage } from '../rules.ts';
import type { Ctx, RuleId, Table } from '../rules.ts';

const planner = ({ x }: Ctx) => agent(x, 'planner');
const split = ({ x }: Ctx) => x.plan.verdict === 'SPLIT';
/** P2 and P2b: `forge job split` creates the children, parks this job as their umbrella and queues their resumes. */
const splitRun = (x: StepInput, rule: RuleId, why: string) => run(x, rule, ['job', 'split', x.job.id], why, `${x.job.id} splits into ${x.plan.jobs} jobs`);

export const PLAN: Table = {
  name: 'plan',
  applies: inStage('plan'),
  rules: [
    {
      id: 'P1',
      when: (c) => {
        const a = planner(c);
        return !ended(a) || after(human(c.x, 'revise-split')?.ts, a.startedAt) || after(human(c.x, 'reject-repos')?.ts, a.startedAt);
      },
      then: ({ x }) => spawn(x, 'P1', 'planner'),
    },
    ...genericRows('planner'),
    { id: 'P2', when: (c) => split(c) && splitMode(c.x) === 'auto', then: ({ x }) => splitRun(x, 'P2', 'PLAN: SPLIT under pipeline.split auto') },
    // An approved split (a human's or the foreman's) sends the job back to plan/running: create the jobs.
    { id: 'P2b', when: (c) => split(c) && after(human(c.x, 'approve-split')?.ts, planner(c)?.endedAt), then: ({ x }) => splitRun(x, 'P2b', 'PLAN: SPLIT approved') },
    {
      id: 'P3',
      when: split,
      then: ({ x }) => set(x, 'P3', { stage: 'plan', state: 'waiting', waitingOn: 'split-approval', reason: `planner proposes ${x.plan.jobs} jobs` }, 'a human decides the split'),
    },
    {
      id: 'P4',
      when: ({ x }) => x.plan.verdict === 'SINGLE',
      then: ({ x }) => toStage(x, 'P4', 'spec', 'one job: write the spec', { tell: x.plan.recommendSplit ? `${x.job.id} plan recommends splitting: ${p(x, 'plan')}` : undefined }),
    },
    { id: 'P5', when: () => true, then: ({ x }) => park(x, 'P5', 'escalation', 'plan.md has no PLAN line') },
  ],
};
