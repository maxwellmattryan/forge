// Decide: the approver (or, for an eval, the judge and the grade) and the gates its decision opens.
import { pastTotalCeiling } from '../../foreman.ts';
import type { StepAction, StepInput, WaitingOn } from '../../types.ts';
import { park, run, spawn, toStage } from '../actions.ts';
import { after, afterIdx, agent, ended, gateApprovals, isPrRework, lastEvent, lastIdx, stageOf, startedIn, waitedSince } from '../facts.ts';
import type { Facts } from '../facts.ts';
import { protectedPark } from '../gates.ts';
import { missingOutput } from '../generic.ts';

export function decideStage(x: StepInput, f: Facts): StepAction {
  const j = x.job;
  if (j.kind !== 'eval' && isPrRework(x)) return toStage(x, 'DC10', 'pr', 'the PR is open: nothing to decide');
  const ap = agent(x, 'approver');
  // B6 sent a rounds-exhausted eval job here: the approver would only ESCALATE a branch that never
  // passed review, and skipping it keeps escalationRate an approver-only metric.
  const exhausted = j.kind === 'eval' && (j.round > j.maxRounds || pastTotalCeiling(x.config, j));
  if (!exhausted) {
    if (!startedIn(ap, j.round) || !ended(ap)) return spawn(x, 'DC1', 'approver');
    const m = missingOutput(x, 'approver');
    if (m) return m;
    if (x.decision.decision && !after(lastEvent(x, (e) => e.type === 'decision')?.ts, ap.endedAt)) return run(x, 'DC2', ['job', 'decision', j.id], 'record the approver\'s decision');
  }
  if (j.kind === 'eval') {
    const judge = agent(x, 'judge');
    const needsJudge = Boolean(x.evalTask && (x.evalTask.rubric || x.evalTask.reference));
    // No M1/M2 for the judge: a missing eval-judge.md grades as `judge: null`, which is the honest result.
    if (needsJudge && !(ended(judge) && after(judge.endedAt, ap?.endedAt))) return spawn(x, 'DC4', 'judge');
    if (!lastEvent(x, (e) => e.type === 'eval-graded')) return run(x, 'DC5', ['eval', 'grade', j.id], 'grade the eval task');
    return toStage(x, 'DC6', 'done', 'the eval task is graded');
  }
  // A human approve given at this gate after the approver ended cleared it, so a job sent back here
  // (an integrate-stage escalation) isn't parked again on the same stale ESCALATE or runbook. Only
  // an approve at that gate counts: acknowledging a budget stop clears neither.
  const cleared = (on: WaitingOn) => gateApprovals(f, [on], 'decide').some((a) => after(a.e.ts, ap?.endedAt));
  if (!x.decision.decision && !cleared('escalation')) return park(x, 'DC3', 'escalation', 'decision.md has no APPROVE/ESCALATE line');
  if (x.decision.decision === 'ESCALATE' && !cleared('escalation')) return park(x, 'DC7', 'escalation', 'approver escalated: see decision.md');
  if (x.runbookBeforeMerge && !cleared('infra')) return park(x, 'DC8', 'infra', 'runbook: steps before merge');
  // An APPROVE, or a cleared escalation, still waits for a human on protected paths.
  const guarded = protectedPark(x);
  if (guarded) return guarded;
  // No loop: after integrate → decide with no wait since, this goes to pr. After a wait (or for an
  // older job that never integrated since review), integrate's IG3/IG5/IG10 reach pr, because the
  // decision or approval now counts there.
  const left = lastIdx(x, (e) => e.type === 'transition' && stageOf(e.from).stage === 'integrate' && stageOf(e.to).stage === 'decide');
  if (afterIdx(left, f.reviewedAt) && !waitedSince(x, left)) return toStage(x, 'DC9', 'pr', 'approved on an up-to-date branch');
  return toStage(x, 'DC9', 'integrate', 'approved: bring the branch up to date');
}
