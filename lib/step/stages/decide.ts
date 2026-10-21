// Decide: the approver (or, for an eval, the judge and the grade) and the gates its decision opens.
import { pastTotalCeiling } from '../../foreman.ts';
import type { JobAgent, WaitingOn } from '../../types.ts';
import { park, run, spawn, toStage } from '../actions.ts';
import { after, afterIdx, agent, ended, gateApprovals, isPrRework, lastEvent, lastIdx, stageOf, startedIn, waitedSince } from '../facts.ts';
import { PP1 } from '../gates.ts';
import { missingOutputRows } from '../generic.ts';
import { inStage } from '../rules.ts';
import type { Ctx, Table } from '../rules.ts';

interface DecideCtx extends Ctx {
  ap: JobAgent | undefined;
  /** B6 sent a rounds-exhausted eval job here: the approver would only ESCALATE a branch that never
   *  passed review, and skipping it keeps escalationRate an approver-only metric. */
  exhausted: boolean;
  /**
   * A human approve given at this gate after the approver ended cleared it, so a job sent back here
   * (an integrate-stage escalation) isn't parked again on the same stale ESCALATE or runbook. Only an
   * approve at that gate counts: acknowledging a budget stop clears neither.
   */
  cleared: (on: WaitingOn) => boolean;
}

function context(c: Ctx): DecideCtx {
  const { x, f } = c;
  const j = x.job;
  const ap = agent(x, 'approver');
  return {
    ...c,
    ap,
    exhausted: j.kind === 'eval' && (j.round > j.maxRounds || pastTotalCeiling(x.config, j)),
    cleared: (on) => gateApprovals(f, [on], 'decide').some((a) => after(a.e.ts, ap?.endedAt)),
  };
}

const evalJob = ({ x }: Ctx) => x.job.kind === 'eval';

export const DECIDE: Table<DecideCtx> = {
  name: 'decide',
  applies: inStage('decide'),
  context,
  rules: [
    { id: 'DC10', when: (c) => !evalJob(c) && isPrRework(c.x), then: ({ x }) => toStage(x, 'DC10', 'pr', 'the PR is open: nothing to decide') },
    { id: 'DC1', when: ({ x, ap, exhausted }) => !exhausted && (!startedIn(ap, x.job.round) || !ended(ap)), then: ({ x }) => spawn(x, 'DC1', 'approver') },
    missingOutputRows<DecideCtx>((c) => (c.exhausted ? null : 'approver')),
    {
      id: 'DC2',
      when: ({ x, ap, exhausted }) => !exhausted && Boolean(x.decision.decision) && !after(lastEvent(x, (e) => e.type === 'decision')?.ts, ap?.endedAt),
      then: ({ x }) => run(x, 'DC2', ['job', 'decision', x.job.id], "record the approver's decision"),
    },
    // No M1/M2 for the judge: a missing eval-judge.md grades as `judge: null`, which is the honest result.
    {
      id: 'DC4',
      when: (c) => {
        const judge = agent(c.x, 'judge');
        const needsJudge = Boolean(c.x.evalTask && (c.x.evalTask.rubric || c.x.evalTask.reference));
        return evalJob(c) && needsJudge && !(ended(judge) && after(judge.endedAt, c.ap?.endedAt));
      },
      then: ({ x }) => spawn(x, 'DC4', 'judge'),
    },
    { id: 'DC5', when: (c) => evalJob(c) && !lastEvent(c.x, (e) => e.type === 'eval-graded'), then: ({ x }) => run(x, 'DC5', ['eval', 'grade', x.job.id], 'grade the eval task') },
    { id: 'DC6', when: evalJob, then: ({ x }) => toStage(x, 'DC6', 'done', 'the eval task is graded') },
    { id: 'DC3', when: ({ x, cleared }) => !x.decision.decision && !cleared('escalation'), then: ({ x }) => park(x, 'DC3', 'escalation', 'decision.md has no APPROVE/ESCALATE line') },
    { id: 'DC7', when: ({ x, cleared }) => x.decision.decision === 'ESCALATE' && !cleared('escalation'), then: ({ x }) => park(x, 'DC7', 'escalation', 'approver escalated: see decision.md') },
    { id: 'DC8', when: ({ x, cleared }) => x.runbookBeforeMerge && !cleared('infra'), then: ({ x }) => park(x, 'DC8', 'infra', 'runbook: steps before merge') },
    // An APPROVE, or a cleared escalation, still waits for a human on protected paths.
    PP1,
    // No loop: after integrate → decide with no wait since, this goes to pr. After a wait (or for an
    // older job that never integrated since review), integrate's IG3/IG5/IG10 reach pr, because the
    // decision or approval now counts there.
    {
      id: 'DC9',
      when: ({ x, f }) => {
        const left = lastIdx(x, (e) => e.type === 'transition' && stageOf(e.from).stage === 'integrate' && stageOf(e.to).stage === 'decide');
        return afterIdx(left, f.reviewedAt) && !waitedSince(x, left);
      },
      then: ({ x }) => toStage(x, 'DC9', 'pr', 'approved on an up-to-date branch'),
    },
    { id: 'DC9b', when: () => true, then: ({ x }) => toStage(x, 'DC9b', 'integrate', 'approved: bring the branch up to date') },
  ],
};
