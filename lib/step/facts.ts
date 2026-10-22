// What step reads off a StepInput: agent records, events and the facts derived from them.
import path from 'node:path';
import type { JobAgent, JobEvent, StepInput, VerifyRun, WaitingOn } from '../types.ts';

export const ended = (a: JobAgent | undefined): a is JobAgent => Boolean(a?.endedAt && a.status !== 'running');
export const endedIn = (a: JobAgent | undefined, round: number): a is JobAgent => ended(a) && a.round === round;
export const startedIn = (a: JobAgent | undefined, round: number) => Boolean(a?.startedAt && a.round === round);
/** `ts` happened, after `than` (or `than` never did). ISO timestamps from now() order as strings. */
export const after = (ts: string | null | undefined, than: string | null | undefined): boolean => Boolean(ts) && (!than || (ts as string) > than);

export const agent = (x: StepInput, role: string): JobAgent | undefined => x.job.agents[role];
export const lastEvent = (x: StepInput, pred: (e: JobEvent) => boolean): JobEvent | undefined => x.events.findLast(pred);
export const human = (x: StepInput, action: string) => lastEvent(x, (e) => e.type === 'human' && e.action === action);
export const lastVerify = (x: StepInput): VerifyRun | undefined => x.job.verifyRuns.filter((r) => r.round === x.job.round).at(-1);
export const p = (x: StepInput, key: string) => String(x.paths[key]);
export const ref = (x: StepInput, name: string) => path.join(x.pluginRoot, 'skills', 'forge', 'reference', name);

export const isPrRework = (x: StepInput) => x.job.pr?.state === 'OPEN';

type Side = { stage?: string; state?: string; waitingOn?: string | null };
export const stageOf = (side: unknown) => (side as Side | null) ?? {};

/**
 * Event `i` came after event `j` in the log (or `j` never happened). Positions, not timestamps: two
 * events in one millisecond, or a clock that stepped back, keep their log order. -1 means `i` never happened.
 */
export const afterIdx = (i: number, j: number | null): boolean => i >= 0 && (j === null || i > j);
/** The position of the last event matching `pred`, or -1. */
export const lastIdx = (x: StepInput, pred: (e: JobEvent) => boolean): number => x.events.findLastIndex(pred);
/** A position as afterIdx's `j`: null when the event never happened. */
export const orNull = (i: number): number | null => (i < 0 ? null : i);

/** One human decision, the park the latest transition before it entered, and that transition's position (-1: none). */
export interface Approval {
  i: number;
  e: JobEvent;
  park: Side;
  parkAt: number;
}

/** What step reads off the event log, once per call: positions in `x.events`, which keeps log order. */
export interface Facts {
  /** The last transition into the job's stage from another one (a gate and back doesn't count), and its ts for agent records. */
  stageEntry: { i: number; ts: string } | null;
  /** The last transition out of review for another stage; null for a job whose transitions predate the log. */
  reviewedAt: number | null;
  /** The position of the last transition; null when the log has none. */
  lastTransition: number | null;
  /** Every `human` event (any action) with the park it was given at, in one pass. */
  decisions: Approval[];
  /** The `approve` subset of `decisions`. */
  approvals: Approval[];
}

export function computeFacts(x: StepInput): Facts {
  let entry = -1;
  let reviewed = -1;
  let last = -1;
  let park: Side = {};
  const decisions: Approval[] = [];
  x.events.forEach((e, i) => {
    if (e.type === 'transition') {
      const from = stageOf(e.from);
      const to = stageOf(e.to);
      if (to.stage === x.job.stage && from.stage !== x.job.stage) entry = i;
      if (from.stage === 'review' && to.stage !== 'review') reviewed = i;
      park = to;
      last = i;
    } else if (e.type === 'human') decisions.push({ i, e, park, parkAt: last });
  });
  return {
    stageEntry: entry < 0 ? null : { i: entry, ts: x.events[entry].ts },
    reviewedAt: orNull(reviewed),
    lastTransition: orNull(last),
    decisions,
    approvals: decisions.filter((d) => d.e.action === 'approve'),
  };
}

/**
 * The decision that answers the park the job waits at now: the last `human` event with one of
 * `actions`, given after the job's last transition, which entered exactly this park. Positions, not
 * timestamps, so a decision at an earlier park (or another gate) never moves a later one.
 */
export function gateAnswer(x: StepInput, f: Facts, actions: readonly string[]): Approval | null {
  if (x.job.state !== 'waiting' || f.lastTransition === null) return null;
  const d = f.decisions.findLast((a) => a.parkAt === f.lastTransition);
  if (!d || d.park.state !== 'waiting' || d.park.waitingOn !== x.job.waitingOn || d.park.stage !== x.job.stage) return null;
  return actions.includes(String(d.e.action)) ? d : null;
}

/** A gate (any waiting or blocked state) was entered after event `i`. */
export const waitedSince = (x: StepInput, i: number) =>
  x.events.some((e, k) => k > i && e.type === 'transition' && ['waiting', 'blocked'].includes(String(stageOf(e.to).state)));

/**
 * The human approves that answered one of the gates in `on`: the job was parked there (in `stage`,
 * when given) when the human approved. An approve answers the gate it was given at, so a budget
 * acknowledgement never clears an escalation or a runbook.
 */
export function gateApprovals(f: Facts, on: readonly WaitingOn[], stage?: string): Approval[] {
  return f.approvals.filter((a) => a.park.state === 'waiting' && on.includes(a.park.waitingOn as WaitingOn) && (!stage || a.park.stage === stage));
}

/** Gates whose human approve means "ship it": an escalation, exhausted rounds, an infra runbook. */
const SHIP_GATES: readonly WaitingOn[] = ['escalation', 'rounds-exhausted', 'infra'];

/**
 * Someone already said ship it since the last review: the approver (a non-ESCALATE `decision`), or
 * a human `approve` at a ship gate that sent the job into this integrate episode, such as one
 * clearing a rounds-exhausted or approver escalation. An approve inside the episode (IG4 `ask`)
 * only lets the integrator fix conflicts.
 */
export function approvedSinceReview(x: StepInput, f: Facts): boolean {
  const reviewed = f.reviewedAt;
  if (x.events.some((e, i) => e.type === 'decision' && e.decision !== 'ESCALATE' && afterIdx(i, reviewed))) return true;
  const entry = f.stageEntry;
  return entry !== null && gateApprovals(f, SHIP_GATES).some((a) => afterIdx(a.i, reviewed) && a.i < entry.i);
}

export const splitMode = (x: StepInput) => x.job.splitMode ?? x.config.pipeline.split;

/** A parked job still holding something to stop: a running environment record or a background process. */
export const parkedRunning = (x: StepInput): boolean => x.environment === 'running' || x.runtime.length > 0;
export const runningRoles = (x: StepInput) => Object.keys(x.job.agents).filter((r) => x.job.agents[r].status === 'running').sort();

/** This round's latest `verifiers` event newer than the round's last verify run. */
export function latestVerifiers(x: StepInput): JobEvent | undefined {
  const lv = lastVerify(x);
  return lastEvent(x, (e) => e.type === 'verifiers' && e.round === x.job.round && after(e.ts, lv?.at));
}

/** The `run` event the verifier agent answers, while its answers are not recorded yet. */
export function pendingVerifiers(x: StepInput): JobEvent | null {
  const e = latestVerifiers(x);
  return e?.phase === 'run' ? e : null;
}

export function outputMissing(x: StepInput, role: string): boolean {
  const a = agent(x, role);
  if (!ended(a)) return false;
  if (a.outputMissing !== undefined) return a.outputMissing;
  // A record from before agent end checked outputs: fall back to the review file's own state.
  if (role.startsWith('reviewer:')) {
    const v = x.job.stage === 'integrate' ? x.verdicts.integration : x.verdicts.round;
    return v?.reviewers[role.slice('reviewer:'.length)]?.verdict === 'MISSING';
  }
  return false;
}
