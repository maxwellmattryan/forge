// Decide: the gate reasons (DC12), then the approver (Forge's own APPROVE on a clean pass; for an eval, the judge and the
// grade), then on to integrate and pr. What holds the merge (the approver's ESCALATE and the gate reasons, on one
// escalation park, and a missing recall eval) holds it after the push: the pr table checks them once the PR is open (PR15, PR17).
import { autoMerge } from '#core/config/load.ts';
import { pastTotalCeiling } from '../../moves/foreman-gates.ts';
import { gateSince } from '../../moves/escalation.ts';
import { cleanDecidedSince, cleanPass } from '../../moves/clean-pass.ts';
import type { JobAgent, WaitingOn } from '#core/types.ts';
import { park, procedure, run, spawn, toStage } from '../actions.ts';
import { recallEvents, recallRecorded } from '../recall.ts';
import { REVIEWED_HEAD_NOTE, after, afterIdx, agent, ended, gateApprovals, isPrRework, lastEvent, lastIdx, stageOf, startedIn, waitedSince } from '../facts.ts';
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
   * (an integrate-stage escalation) isn't parked again on the same missing decision line. Only an
   * approve at that gate counts: acknowledging a budget stop doesn't.
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
    // The gate reasons of this review, as data the approver reads as facts: once per review, before anything decides.
    {
      id: 'DC12',
      when: ({ x, f, exhausted }) => !exhausted && gateSince(x.events, f.reviewedAt) === null,
      then: ({ x }) => run(x, 'DC12', ['job', 'gate', x.job.id], 'compute the gate reasons before the approver decides'),
    },
    // Only without auto-merge: with it on, a PR or CI rework goes back through the approver (DC1), so
    // the decision PR4 merges on is recorded for the new head.
    { id: 'DC10', when: (c) => !evalJob(c) && isPrRework(c.x) && !autoMerge(c.x.config), then: ({ x }) => toStage(x, 'DC10', 'pr', 'the PR is open: nothing to decide') },
    // The diff changes reviewer prompts: a recall eval for exactly these prompts comes before the
    // approver, at most twice. With still no record (or fixtures that do not load, so no start could
    // ever be logged), the approver runs anyway and PR17 holds the merge on a human.
    {
      id: 'RC1',
      when: (c) => recallOpen(c) && c.x.recall!.pluginHash !== null && !c.x.recall!.invalidFixtures && recallEvents(c.x, 'start').length < 2,
      then: ({ x }) => procedure(x, 'RC1', 'recall.md', 'the diff changes reviewer prompts: run the recall eval on them before the approver'),
    },
    // approver.skipWhenClean: every lens passed and the gate check found nothing, so Forge records the APPROVE itself.
    {
      id: 'DC13',
      when: (c) => !c.exhausted && !afterIdx(lastIdx(c.x, (e) => e.type === 'decision'), c.f.reviewedAt) && cleanPass(c.x, c.f).ok,
      then: ({ x }) => run(x, 'DC13', ['job', 'decision', x.job.id, '--clean'], 'every lens passed and nothing escalates: Forge records the APPROVE'),
    },
    { id: 'DC1', when: ({ x, f, ap, exhausted }) => !exhausted && (!startedIn(ap, x.job.round) || !ended(ap)) && !cleanDecidedSince(x, f), then: ({ x }) => spawn(x, 'DC1', 'approver') },
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
    // An ESCALATE and the gate reasons go on too: the PR opens, then the pr table holds the merge on
    // them, all on one escalation park (PR15).
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
