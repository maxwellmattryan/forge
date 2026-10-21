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

/** When the job last entered its current stage from another one: transitions within a stage (a gate and back) don't count. */
export function stageSince(x: StepInput): string | null {
  const t = lastEvent(x, (e) => {
    if (e.type !== 'transition') return false;
    const to = e.to as { stage?: string } | null;
    const from = e.from as { stage?: string } | null;
    return to?.stage === x.job.stage && from?.stage !== x.job.stage;
  });
  return t?.ts ?? null;
}

export const isPrRework = (x: StepInput) => x.job.pr?.state === 'OPEN';

export const stageOf = (side: unknown) => (side as { stage?: string; state?: string; waitingOn?: string | null } | null) ?? {};

/** When the job last left review for another stage, or null for a job whose transitions predate the log. */
export function reviewedAt(x: StepInput): string | null {
  return lastEvent(x, (e) => e.type === 'transition' && stageOf(e.from).stage === 'review' && stageOf(e.to).stage !== 'review')?.ts ?? null;
}

/** A gate (any waiting or blocked state) was entered after `ts`. */
export const waitedSince = (x: StepInput, ts: string) =>
  x.events.some((e) => e.type === 'transition' && after(e.ts, ts) && ['waiting', 'blocked'].includes(String(stageOf(e.to).state)));

/**
 * The human `approve` events that answered one of the gates in `on`: the job was parked there (in
 * `stage`, when given) when the human approved. An approve answers the gate it was given at, so a
 * budget acknowledgement never clears an escalation or a runbook.
 */
export function gateApprovals(x: StepInput, on: readonly WaitingOn[], stage?: string): JobEvent[] {
  return x.events.filter((e, i) => {
    if (e.type !== 'human' || e.action !== 'approve') return false;
    const park = stageOf(x.events.slice(0, i).findLast((t) => t.type === 'transition')?.to);
    return park.state === 'waiting' && on.includes(park.waitingOn as WaitingOn) && (!stage || park.stage === stage);
  });
}

/** Gates whose human approve means "ship it": an escalation, exhausted rounds, an infra runbook. */
const SHIP_GATES: readonly WaitingOn[] = ['escalation', 'rounds-exhausted', 'infra'];

/**
 * Someone already said ship it since the last review: the approver (a non-ESCALATE `decision`), or
 * a human `approve` at a ship gate that sent the job into this integrate episode, such as one
 * clearing a rounds-exhausted or approver escalation. An approve inside the episode (IG4 `ask`)
 * only lets the integrator fix conflicts.
 */
export function approvedSinceReview(x: StepInput): boolean {
  const reviewed = reviewedAt(x);
  if (x.events.some((e) => e.type === 'decision' && e.decision !== 'ESCALATE' && after(e.ts, reviewed))) return true;
  const since = stageSince(x);
  return gateApprovals(x, SHIP_GATES).some((e) => after(e.ts, reviewed) && !after(e.ts, since));
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

export function lastConflicts(x: StepInput): JobEvent | undefined {
  return lastEvent(x, (e) => e.type === 'integrate-conflicts');
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
