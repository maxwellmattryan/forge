// The Foreman's session side: who owns a gate for the dashboard, the checks on a foreman decision
// and on an office or assistant foreman session's `forge job set`, and hand-offs; the gate policy is
// lib/engine/pipeline/moves/foreman-gates.ts. With `foreman.enabled`, a job parking on a gate the
// foreman decides becomes a `gate` request routed to `_assistants`, which an assistant foreman session
// claims, hands to a forge:assistant sub-agent and records the verdict of with `forge job human …
// --actor foreman`. The CLI, not the prompt, holds the authority line: checkForemanDecision runs before
// any write. docs/architecture/foreman.md.
import { isForemanActor, readEvents } from '#core/job/store.ts';
import { inAssistant, listRequests } from '#core/job/requests.ts';
import { HANDOFF_CLASSES } from '#core/job/schema.ts';
import { ACTIONS_BY_GATE, classReservation, decides, foremanEnabled, gateClass, gateClassFor, isGateRequest, listedDecides, reservedFor } from '#engine/pipeline/moves/foreman-gates.ts';
import { ForgeError } from '#core/errors.ts';
import { safeText } from '#core/text.ts';
import { jobMandateDecides } from './mandates/store.ts';
import type { Config, ForemanHandoff, ForgeRequest, GateClass, GateOwner, HandoffClass, Job, JobEvent } from '#core/types.ts';

export { OFFICE_GATES } from '#core/job/schema.ts';

const SHA = /^[0-9a-f]{40}$/;

/**
 * Who owns a waiting job's gate, for the dashboard: `foreman` when the foreman is on and the gate is
 * one it decides and isn't reserved (or refused by the foreman already), `human` for every other
 * gate (every gate while no assistant foreman runs to take it), null when the job waits on nothing or the foreman is off.
 */
export function gateOwner(root: string, config: Config, job: Job, requests: ForgeRequest[] = listRequests(root)): GateOwner {
  if (!foremanEnabled(config) || job.state !== 'waiting') return null;
  if (config.foreman?.assistants?.enabled !== true) return 'human';
  const gate = gateClassFor(root, job);
  if (!gate || !decides(config).includes(gate)) return 'human';
  // A job in a mandate: only what the mandate delegates, and nothing when its file can't be read.
  const m = jobMandateDecides(root, config, job);
  if (m && ('problem' in m || !m.decides.includes(gate))) return 'human';
  if (reservedFor(root, config, job, gate)) return 'human';
  const latest = requests.filter((r) => isGateRequest(r, job.id, gate) && (gate !== 'pr-feedback' || r.args?.key === job.pr?.headOid)).at(-1);
  // pr-feedback is the foreman's only once sync queued a gate for this head (trusted feedback or failing checks).
  if (gate === 'pr-feedback' && !latest) return 'human';
  return latest?.status === 'rejected' ? 'human' : 'foreman';
}

/** A pending or in-progress pr-feedback gate request for the job's current PR head exists. */
function queuedPrFeedbackGate(root: string, job: Pick<Job, 'id' | 'pr'>, requests: ForgeRequest[] = listRequests(root)): boolean {
  const head = job.pr?.headOid;
  if (typeof head !== 'string' || !SHA.test(head)) return false;
  return requests.some((r) => isGateRequest(r, job.id, 'pr-feedback') && r.args?.key === head && (r.status === 'pending' || r.status === 'in-progress'));
}

/**
 * Why a job's mandate leaves `gate` with a human, or null when the job is in no mandate or the mandate
 * delegates the class. Read from the CLI's record of the job, which a session can't edit, whatever the
 * mandate's status: a mandate only ever narrows, and one that can't be read delegates nothing.
 */
export function mandateRefusal(root: string, config: Config, job: Job, gate: GateClass): string | null {
  const m = jobMandateDecides(root, config, job);
  if (!m) return null;
  if ('problem' in m) return `mandate ${m.id} can't be read (${m.problem}): left for a human`;
  return m.decides.includes(gate) ? null : `${gate} is not in mandate ${m.id}'s decides: left for a human`;
}

/**
 * mandateRefusal for the `release` class, plus its status: a paused or closed mandate delegates no
 * release, because publishing can't be undone. The other classes keep "whatever the status" until the
 * director loop (#538). Asked at approval time and again at release run and status time, so an approval
 * stops counting once the mandate that allowed it narrows, pauses, closes or can't be read.
 */
export function releaseMandateRefusal(root: string, config: Config, job: Job): string | null {
  const narrowed = mandateRefusal(root, config, job, 'release');
  if (narrowed) return narrowed;
  const m = jobMandateDecides(root, config, job);
  if (m && !('problem' in m) && (m.mandate.status === 'paused' || m.mandate.status === 'closed')) return `mandate ${m.id} is ${m.mandate.status}: release left for a human`;
  return null;
}

/**
 * Every check on a foreman decision, before anything is written: an assistant foreman scope, no --link or
 * --reason, a job waiting on a gate the foreman decides (and, in a mandate, one the mandate's decides
 * names), an action that belongs to that gate, for
 * pr-feedback a queued gate request for the current PR head, and no reserved pattern in the reason,
 * decision.md or the note. Throws ForgeError (exit 1). The `release` class has its own checks
 * (checkReleaseDecision), which take the same mandate refusal from `mandateRefusal`.
 */
export function checkForemanDecision(
  root: string,
  config: Config,
  job: Job,
  action: string,
  note: string | null | undefined,
  flags: { link?: unknown; reason?: unknown },
  env: NodeJS.ProcessEnv = process.env,
): GateClass {
  const refuse = (why: string): never => {
    throw new ForgeError(`--actor foreman refused: ${why}`, 1);
  };
  if (!inAssistant(env)) refuse('only an assistant foreman session records foreman decisions');
  if (flags.link !== undefined || flags.reason !== undefined) refuse('linking an issue stays a human call (no --link or --reason)');
  if (typeof note !== 'string' || !note.trim()) refuse('a foreman decision needs --note with its reason');
  const gate = gateClassFor(root, job);
  if (!gate) refuse(`job ${job.id} is not waiting on a gate the foreman decides`);
  if (!foremanEnabled(config)) refuse('foreman.enabled is false');
  if (!listedDecides(config).includes(gate!)) refuse(`${gate} is not in foreman.decides`);
  const held = classReservation(config, gate!);
  if (held) refuse(`${gate} is reserved (${held}): left for a human`);
  const narrowed = mandateRefusal(root, config, job, gate!);
  if (narrowed) refuse(narrowed);
  if (!ACTIONS_BY_GATE[gate!].includes(action)) refuse(`${action} is not a ${gate} action (${ACTIONS_BY_GATE[gate!].join(', ')})`);
  // pr-feedback is the foreman's only once sync armed it for this head (trusted feedback or failing
  // checks): a queued gate request keyed by the PR's current head sha must exist.
  if (gate === 'pr-feedback' && !queuedPrFeedbackGate(root, job)) refuse(`no queued pr-feedback gate request for ${job.id}'s current PR head`);
  const reserved = reservedFor(root, config, job, gate, [note], { action });
  if (reserved) refuse(`reserved (${reserved}): left for a human`);
  return gate!;
}

/**
 * The stages a `forge job set --state running` may move a job to right after each foreman action: the
 * second column of the gate table in skills/forge/reference/foreman.md. undefined: the stage stays.
 */
const SET_AFTER: Record<string, readonly (string | undefined)[]> = {
  'approve-spec': [undefined, 'spec'],
  'revise-spec': ['spec'],
  'approve-split': ['plan'],
  'revise-split': ['plan'],
  approve: ['integrate', 'decide'],
  rework: ['build'],
  'approve-repos': [undefined],
  'reject-repos': [undefined],
};

/** Only these `forge job` subcommands run in the office and assistant foreman sessions: they read, decide and note, nothing more. */
export const OFFICE_JOB_COMMANDS: readonly string[] = ['assist', 'human', 'set', 'note', 'handoff', 'show', 'get', 'list', 'step'];

/** The longest hand-off reason kept, after safeText. */
const HANDOFF_REASON_MAX = 200;

/** The reason as `forge job handoff` stores it: control characters and backticks removed, trimmed, at most 200 characters. */
export const cleanHandoffReason = (reason: unknown): string => (typeof reason === 'string' ? safeText(reason, HANDOFF_REASON_MAX).trim() : '');

const isHandoffClass = (c: unknown): c is HandoffClass => (HANDOFF_CLASSES as readonly unknown[]).includes(c);

/**
 * The Foreman hand-off standing at the job's current park, derived from events (job.json has no field
 * for it): the latest `foreman-handoff` for the gate class the job waits on, logged after its last
 * transition, with no `human` event (any actor or action) after it. Null when the job isn't waiting
 * on a Foreman gate, was never handed off there, parked again since or was decided since, or when the
 * event's class or reason doesn't validate (events.jsonl is appendable, so it is checked on read too).
 */
export function foremanHandoff(job: Pick<Job, 'state' | 'waitingOn' | 'reason' | 'repos'>, events: JobEvent[]): ForemanHandoff | null {
  const gate = gateClass(job, events);
  if (!gate) return null;
  const park = events.findLastIndex((e) => e.type === 'transition');
  const at = events.findLastIndex((e, i) => i > park && e.type === 'foreman-handoff' && e.gate === gate);
  if (at < 0 || events.some((e, i) => i > at && e.type === 'human')) return null;
  const e = events[at];
  const reason = cleanHandoffReason(e.reason);
  if (!isHandoffClass(e.class) || !reason || typeof e.ts !== 'string') return null;
  return { gate, class: e.class, reason, at: e.ts };
}

/** foremanHandoff with the job's events read from disk, only for a waiting job. */
export function foremanHandoffFor(root: string, job: Pick<Job, 'id' | 'state' | 'waitingOn' | 'reason' | 'repos'>): ForemanHandoff | null {
  return job.state === 'waiting' ? foremanHandoff(job, readEvents(root, job.id)) : null;
}

/**
 * In the office and assistant foreman sessions, `forge job set` only carries out a foreman decision: the job still waits, its latest
 * `human` event is the foreman's and came after the job parked, and the change is that action's
 * `--state running` (with its stage) and nothing else. So a misled foreman or assistant can't move a job
 * off a gate the CLI refused it, or that a human owns. Throws ForgeError (exit 1) before any write.
 */
function checkOfficeSet(
  job: Pick<Job, 'id' | 'state'>,
  events: JobEvent[],
  change: { stage?: unknown; state?: unknown; waitingOn?: unknown; reason?: unknown; fields?: Record<string, unknown> },
): void {
  const refuse = (why: string): never => {
    throw new ForgeError(`a foreman session may only carry out a recorded foreman decision with forge job set: ${why}`, 1);
  };
  if (change.fields && Object.keys(change.fields).length) refuse('no --field');
  if (change.waitingOn !== undefined || change.reason !== undefined) refuse('no --waiting-on or --reason');
  if (job.state !== 'waiting') refuse(`job ${job.id} is not waiting on a gate`);
  if (change.state !== 'running') refuse('only --state running');
  const decision = [...events].reverse().find((e) => e.type === 'human');
  const park = [...events].reverse().find((e) => e.type === 'transition' && (e.to as { state?: unknown } | null)?.state === 'waiting');
  if (!decision || !isForemanActor(decision) || !park || decision.ts < park.ts) refuse(`no foreman decision recorded for ${job.id}'s current gate`);
  const allowed = SET_AFTER[String(decision!.action)] ?? [];
  const stage = change.stage === undefined ? undefined : String(change.stage);
  if (!allowed.includes(stage)) refuse(`${decision!.action} moves the job to ${allowed.map((x) => x ?? 'its current stage').join(' or ')}, not ${stage ?? 'its current stage'}`);
}

/** checkOfficeSet with the job's events read from disk. */
export function checkOfficeSetFor(root: string, job: Pick<Job, 'id' | 'state'>, change: Parameters<typeof checkOfficeSet>[2]): void {
  checkOfficeSet(job, readEvents(root, job.id), change);
}
