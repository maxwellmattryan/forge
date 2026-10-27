// The senior pass under foreman.escalations: foreman: which escalations get one, its once-per-park marker, and the
// Foreman's shelve. The gate runner (./run.ts) asks seniorStart once its assistant escalated or the CLI refused its
// decision; the checks run in a fixed order and only the last one starts a senior pass, whose decision goes through
// the same policy checks (./decide.ts). Whatever it can't settle is shelved for a person, never accepted. Each write
// here refuses anyone without the gate runner's ForemanAuthority. docs/architecture/foreman.md › Senior pass.
import { ForgeError } from '#core/errors.ts';
import { cleanShelveReason } from '#core/job/schema.ts';
import { loadJob, logHumanEvent, readEvents } from '#core/job/store.ts';
import { gateClassFor, reservedFor, securityHold } from '#engine/pipeline/moves/foreman-gates.ts';
import { shelveJob, type ShelveResult } from '#engine/pipeline/moves/shelve.ts';
import { FOREMAN_ACTOR } from '#integrations/github/actor.ts';
import { officeCapRefusal } from '../session/meter.ts';
import { gateAssist, type GateAssist } from './decide.ts';
import { foremanAuthorityRefusal } from './policy.ts';
import { cleanReason } from './verdict.ts';
import type { Config, ForemanEscalations, GateClass, Job, JobEvent } from '#core/types.ts';

/** What sent the gate to a senior pass: the assistant's escalate, or the CLI's refusal of its decision, and why. */
export interface SeniorFirst {
  first: 'escalate' | 'refused';
  reason: string;
}

/** What seniorStart decided: the gate moved, a person's reserved topic, a shelve with its reason, or the senior pass to run. */
export type SeniorStart = { kind: 'stale' } | { kind: 'reserved'; reason: string } | { kind: 'shelve'; reason: string } | { kind: 'run'; assist: GateAssist };

/** foreman.escalations: `foreman` only when written exactly so; anything else (missing, invalid) is `human`. */
export const escalationsMode = (c: Config | null): ForemanEscalations => (c?.foreman?.escalations === 'foreman' ? 'foreman' : 'human');

/** Whether a gate run may take a senior pass: a job's gate, never a release or a mandate's milestone draft. */
export const seniorGate = (t: { gate: GateClass; job: string | null }): boolean => t.job !== null && t.gate !== 'release';

/** A senior pass already ran at the job's current park: a `senior-pass` event for `gate` after its latest transition. */
export function seniorPassed(events: JobEvent[], gate: GateClass): boolean {
  const park = events.findLastIndex((e) => e.type === 'transition');
  return events.some((e, i) => i > park && e.type === 'senior-pass' && e.gate === gate);
}

/** Logs the once-per-park marker, before the senior child spawns, so a restart never runs a second one. Throws ForgeError (exit 1). */
export function recordSeniorPass(root: string, job: Pick<Job, 'id'>, gate: GateClass, first: SeniorFirst['first'], by: unknown): void {
  const refusal = foremanAuthorityRefusal(by);
  if (refusal) throw new ForgeError(`Foreman senior pass refused: ${refusal}`, 1);
  logHumanEvent(root, job.id, 'senior-pass', { gate, first: first === 'refused' ? 'refused' : 'escalate' }, FOREMAN_ACTOR);
}

/**
 * Shelves `job` as the Foreman: only a holder of the gate runner's authority may (nothing is read or written
 * before that check), and only while the job waits on a Foreman gate. Then shelveJob as FOREMAN_ACTOR: the
 * job waits on `shelved`, a `shelved` event, the environment stopped, one tracker note, the PR left as it is.
 * Throws ForgeError (exit 1).
 */
export async function recordForemanShelve(root: string, config: Config, job: Pick<Job, 'id'>, reason: string, by: unknown): Promise<ShelveResult> {
  const refusal = foremanAuthorityRefusal(by);
  if (refusal) throw new ForgeError(`Foreman shelve refused: ${refusal}`, 1);
  if (!gateClassFor(root, loadJob(root, job.id))) throw new ForgeError(`Foreman shelve refused: job ${job.id} is not waiting on a gate the Foreman decides`, 1);
  return shelveJob(root, config, job.id, { reason: cleanShelveReason(reason), actor: FOREMAN_ACTOR });
}

/** A shelve reason: a fixed prefix, then the cleaned text, at most SHELVE_REASON_MAX characters. */
const shelveReason = (prefix: string, text = ''): string => cleanShelveReason(text ? `${prefix} ${cleanReason(text)}` : prefix);

/**
 * Whether `job`'s escalated or refused gate gets a senior pass, in this order: the job moved off the gate
 * (stale); a reserved topic, the total-round ceiling or a retro spec, also in the first reason (a person's
 * hand-off); a latest security review that isn't PASS (shelved: a person signs off); a senior pass already
 * ran at this park (shelved); the office's daily cap, or a meter that can't be read (shelved); then the
 * senior's own assist (stale, or reserved, such as a mandate hold). Reads only; the caller acts on it.
 */
export function seniorStart(root: string, config: Config, job: Job, gate: GateClass, first: SeniorFirst, at: number): SeniorStart {
  const why = cleanReason(first.reason) || first.first;
  if (gateClassFor(root, job) !== gate) return { kind: 'stale' };
  const reserved = reservedFor(root, config, job, gate, [why]);
  if (reserved) return { kind: 'reserved', reason: reserved };
  if (securityHold(job)) return { kind: 'shelve', reason: shelveReason('security review not PASS: a person signs off.', why) };
  if (seniorPassed(readEvents(root, job.id), gate)) return { kind: 'shelve', reason: shelveReason('senior pass already ran at this park.', why) };
  let held: boolean;
  try {
    held = officeCapRefusal(root, config, at) !== null;
  } catch {
    // Fails closed, as take() does: a meter that can't be read holds the senior pass.
    held = true;
  }
  if (held) return { kind: 'shelve', reason: shelveReason("the office's daily cap holds the senior pass") };
  const assist = gateAssist(root, config, job, gate, { senior: { first: first.first, reason: why } });
  if (assist.stale) return { kind: 'stale' };
  if (assist.reserved) return { kind: 'reserved', reason: assist.reserved };
  return { kind: 'run', assist };
}
