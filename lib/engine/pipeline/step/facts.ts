// What step reads off a StepInput: agent records, events and the facts derived from them, whether a rework spawn
// resumes its role's last session, and the park reason NP1b writes for a prompt nobody answered in time, with its
// parser (brief.ts reads it without the step rows).
import path from 'node:path';
import { SAFE_TOOL } from '#core/text.ts';
import { UUID } from '#core/job/session-files.ts';
import type { JobAgent, JobEvent, VerifyRun, WaitingOn } from '#core/types.ts';
import type { StepInput } from '../types.ts';
import { lastRun } from '../../verify/record.ts';

export const ended = (a: JobAgent | undefined): a is JobAgent => Boolean(a?.endedAt && a.status !== 'running');
export const endedIn = (a: JobAgent | undefined, round: number): a is JobAgent => ended(a) && a.round === round;
export const startedIn = (a: JobAgent | undefined, round: number) => Boolean(a?.startedAt && a.round === round);
/** `ts` happened, after `than` (or `than` never did). ISO timestamps from now() order as strings. */
export const after = (ts: string | null | undefined, than: string | null | undefined): boolean => Boolean(ts) && (!than || (ts as string) > than);

export const agent = (x: StepInput, role: string): JobAgent | undefined => x.job.agents[role];
export const lastEvent = (x: StepInput, pred: (e: JobEvent) => boolean): JobEvent | undefined => x.events.findLast(pred);
export const human = (x: StepInput, action: string) => lastEvent(x, (e) => e.type === 'human' && e.action === action);
export const lastVerify = (x: StepInput): VerifyRun | undefined => lastRun(x.job);
export const p = (x: StepInput, key: string) => String(x.paths[key]);
export const ref = (x: StepInput, name: string) => path.join(x.pluginRoot, 'skills', 'forge', 'reference', name);

export const isPrRework = (x: StepInput) => x.job.pr?.state === 'OPEN';

/** The roles a timed-out prompt may park the job for: the ones that write the job's plan, spec or code. */
export const PROMPT_TIMEOUT_ROLES: readonly string[] = ['planner', 'spec-writer', 'builder', 'integrator'];
const PROMPT_TIMEOUT_REASON = /^prompt timed out: ([a-z-]+) needed (.+), nobody answered it in time$/;

/**
 * The park reason NP1b writes. It says "prompt", never "permission": the default foreman.reserved holds
 * every gate whose reason names `permission`, which would keep these parks from the Foreman.
 */
export const promptTimeoutReason = (role: string, tool: string): string => `prompt timed out: ${role} needed ${tool}, nobody answered it in time`;

/** The role and tool of a reason promptTimeoutReason wrote; null for any other reason, an unknown role or an unsafe tool. */
export function parsePromptTimeoutReason(reason: unknown): { role: string; tool: string } | null {
  const m = typeof reason === 'string' ? PROMPT_TIMEOUT_REASON.exec(reason) : null;
  if (!m || !PROMPT_TIMEOUT_ROLES.includes(m[1]) || !SAFE_TOOL.test(m[2])) return null;
  return { role: m[1], tool: m[2] };
}

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

/** The stage the job's last entry into its current stage came from; undefined when the log has no entry. */
export const enteredFrom = (x: StepInput, f: Facts): string | undefined => (f.stageEntry ? stageOf(x.events[f.stageEntry.i].from).stage : undefined);

/** DC11's and PR12's `--note`: plain words only, so it stays inside SAFE_ELEMENT. */
export const REVIEWED_HEAD_NOTE = 'a commit after review: the new head goes back to review';

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

/** A session whose last context is above this many tokens is not resumed: a fresh run reads less than it would carry. */
export const RESUME_CONTEXT_CEILING = 120_000;
/** Why a rework spawn does not resume its role's last session, in the order reworkResume checks them. */
export const RESUME_SKIPS = ['off', 'last run failed', 'no session', 'model changed', 'spec changed', 'no transcript', 'context unknown', 'context over ceiling'] as const;
export type ResumeSkip = (typeof RESUME_SKIPS)[number];

/**
 * Whether a rework spawn of `role` at `model` continues the role's last run (`resume`: its session id) or why not
 * (`skipped`, the first check that applies); null for the role's first run, which never had one.
 */
export function reworkResume(x: StepInput, role: string, model: string): { resume: string } | { skipped: ResumeSkip } | null {
  const a = agent(x, role);
  if (!ended(a)) return null;
  const skip = (skipped: ResumeSkip) => ({ skipped });
  if (!x.config.pipeline.resumeRework) return skip('off');
  if (a.status !== 'done') return skip('last run failed');
  const id = a.agentId;
  const last = x.lastSessions[role];
  if (typeof id !== 'string' || !UUID.test(id) || last?.session !== id) return skip('no session');
  const started = lastEvent(x, (e) => e.type === 'agent-start' && e.role === role);
  const lastModel = typeof started?.model === 'string' ? started.model : a.model;
  if (lastModel !== model) return skip('model changed');
  const revised = x.events.some((e) => e.type === 'human' && e.action === 'revise-spec' && after(e.ts, a.startedAt));
  if (revised || after(agent(x, 'spec-writer')?.endedAt, a.startedAt)) return skip('spec changed');
  if (!last.transcript) return skip('no transcript');
  if (last.context === null) return skip('context unknown');
  if (last.context > RESUME_CONTEXT_CEILING) return skip('context over ceiling');
  return { resume: id };
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
