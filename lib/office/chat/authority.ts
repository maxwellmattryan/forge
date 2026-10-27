// What a chat session may not decide for the owner: a gate foreman.reserved keeps with a person, by class
// (`gate:<class>`) or by a reserved pattern in the job, its decision.md or the note, any accept past a
// security review that didn't pass, and any `forge job set` of a gated job beyond carrying out the decision
// recorded at its park. The CLI asks before `forge job human` and `forge job set` write anything, whether or
// not foreman.enabled is set. The gate policy is lib/engine/pipeline/moves/foreman-gates.ts;
// docs/architecture/daemon-security.md › Chats.
import { readEvents } from '#core/job/store.ts';
import { classReservation, gateClassFor, reservedFor, securityHold } from '#engine/pipeline/moves/foreman-gates.ts';
import type { Config, Job, JobEvent } from '#core/types.ts';
import { SET_AFTER } from '../foreman/policy.ts';

/**
 * The refusal for a chat deciding `job`'s current gate with `action`, or null when the job waits on no gate
 * class or nothing reserves it. A null action is a move off the gate with no decision recorded, judged as an
 * accept, never a mitigation: a security review that didn't pass holds it.
 */
export function chatGateRefusal(root: string, config: Config, job: Job, action: string | null, note: string | null | undefined): string | null {
  const gate = gateClassFor(root, job);
  if (!gate) return null;
  const why = classReservation(config, gate) ?? (action === null ? securityHold(job) : null) ?? reservedFor(root, config, job, gate, [note], action === null ? {} : { action });
  if (!why) return null;
  return `a chat may not decide ${gate} for ${job.id}: ${why}. The owner decides it from the dashboard's Needs you list, or with forge job human in their own terminal`;
}

/** The `human` event recorded at the park the job waits at now: the latest one after its latest transition, by log position as step's gateAnswer pairs them. */
function parkDecision(events: JobEvent[]): JobEvent | null {
  const park = events.findLastIndex((e) => e.type === 'transition');
  const at = events.findLastIndex((e) => e.type === 'human');
  return park >= 0 && at > park ? events[at]! : null;
}

/**
 * The refusal for a chat's `forge job set` of `job`, or null. On a job waiting on a gate class, a set only
 * carries out the decision recorded at its park, whoever recorded it: nothing reserved for that decision's
 * action (chatGateRefusal, as an accept when none is recorded), no --field, --waiting-on or --reason, and only
 * `--state running` with a stage that action allows (SET_AFTER). So a chat can't move a job off a gate it was
 * refused, or turn a recorded rework into an accept. A job on no gate class gets only every session's checks.
 */
export function chatSetRefusal(
  root: string,
  config: Config,
  job: Job,
  change: { stage?: unknown; state?: unknown; waitingOn?: unknown; reason?: unknown; fields?: Record<string, unknown> },
  note: string | null | undefined,
): string | null {
  if (!gateClassFor(root, job)) return null;
  const decision = parkDecision(readEvents(root, job.id));
  const action = decision ? String(decision.action) : null;
  const held = chatGateRefusal(root, config, job, action, note);
  if (held) return held;
  const refuse = (why: string) => `a chat may only carry out the decision recorded at ${job.id}'s gate with forge job set: ${why}`;
  if (change.fields && Object.keys(change.fields).length) return refuse('no --field');
  if (change.waitingOn !== undefined || change.reason !== undefined) return refuse('no --waiting-on or --reason');
  if (change.state !== 'running') return refuse('only --state running');
  if (action === null) return refuse("no decision is recorded since it parked; record the owner's with forge job human first");
  const allowed = SET_AFTER[action] ?? [];
  const stage = change.stage === undefined ? undefined : String(change.stage);
  if (!allowed.length) return refuse(`${action} is not a decision forge job set carries out`);
  if (!allowed.includes(stage)) return refuse(`${action} moves the job to ${allowed.map((x) => x ?? 'its current stage').join(' or ')}, not ${stage ?? 'its current stage'}`);
  return null;
}
