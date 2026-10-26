// Decide: the approver (or, for an eval, the judge and the grade) and the gates its decision opens.
import { autoMerge } from '#core/config/load.ts';
import { pastTotalCeiling } from '../../moves/foreman-gates.ts';
import type { JobAgent, WaitingOn } from '#core/types.ts';
import { park, procedure, run, spawn, toStage } from '../actions.ts';
import { recallEvents, recallReason, recallRecorded, recallWaived } from '../recall.ts';
import { REVIEWED_HEAD_NOTE, after, afterIdx, agent, ended, gateApprovals, isPrRework, lastEvent, lastIdx, stageOf, startedIn, waitedSince } from '../facts.ts';
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

/** The diff changes reviewer prompts and no recall record matches them; a null hash never matches. */
const recallOpen = ({ x }: Ctx) => Boolean(x.recall?.required) && !recallRecorded(x);

export const DECIDE: Table<DecideCtx> = {
  name: 'decide',
  applies: inStage('decide'),
  context,
  rules: [
    // A commit after the review panel is unreviewed: nothing below may decide on it (reviewCurrent).
    { id: 'DC11', when: ({ x }) => x.reviewCurrent === false, then: ({ x }) => toStage(x, 'DC11', 'review', 'a commit after review is unreviewed: review the new head', { note: REVIEWED_HEAD_NOTE }) },
    // Only without auto-merge: with it on, a PR or CI rework goes back through the approver (DC1), so
    // the decision PR4 merges on is recorded for the new head.
    { id: 'DC10', when: (c) => !evalJob(c) && isPrRework(c.x) && !autoMerge(c.x.config, c.x.job), then: ({ x }) => toStage(x, 'DC10', 'pr', 'the PR is open: nothing to decide') },
    // The diff changes reviewer prompts: a recall eval for exactly these prompts comes before the
    // approver. Two starts with no record park on a human, who runs it again or waives it; so do
    // fixtures that do not load, since no start could ever be logged.
    {
      id: 'RC1',
      when: (c) => recallOpen(c) && c.x.recall!.pluginHash !== null && !c.x.recall!.invalidFixtures && recallEvents(c.x, 'start').length < 2,
      then: ({ x }) => procedure(x, 'RC1', 'recall.md', 'the diff changes reviewer prompts: run the recall eval on them before the approver'),
    },
    { id: 'RC2', when: (c) => recallOpen(c) && !recallWaived(c.x), then: ({ x }) => park(x, 'RC2', 'human', recallReason(x.recall!.pluginHash)) },
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
