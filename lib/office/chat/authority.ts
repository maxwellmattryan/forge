// What a chat session may not decide for the owner: a gate foreman.reserved keeps with a person, by class
// (`gate:<class>`) or by a reserved pattern in the job, its decision.md or the note, and any accept past a
// security review that didn't pass. The CLI asks it before `forge job human` and `forge job set --state`
// write anything, whether or not foreman.enabled is set. The gate policy is
// lib/engine/pipeline/moves/foreman-gates.ts; docs/architecture/daemon-security.md › Chats.
import { classReservation, gateClassFor, reservedFor } from '#engine/pipeline/moves/foreman-gates.ts';
import type { Config, Job } from '#core/types.ts';

/**
 * The refusal for a chat deciding `job`'s current gate with `action` (none for `forge job set`, which judges
 * the gate as a whole), or null when the job waits on no gate class or nothing reserves it.
 */
export function chatGateRefusal(root: string, config: Config, job: Job, action: string | undefined, note: string | null | undefined): string | null {
  const gate = gateClassFor(root, job);
  if (!gate) return null;
  const why = classReservation(config, gate) ?? reservedFor(root, config, job, gate, [note], action === undefined ? {} : { action });
  if (!why) return null;
  return `a chat may not decide ${gate} for ${job.id}: ${why}. The owner decides it from the dashboard's Needs you list, or with forge job human in their own terminal`;
}
