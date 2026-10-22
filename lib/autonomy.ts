// The one definition of an autonomous job: Forge 1.0's test is a weekend unattended run with no
// human fixes, and this judges each merged job against it once its outcome is final. Stats and
// the retro read it from here, so the rule can't drift between them.
import { isForemanActor } from './jobs.ts';
import type { Job, JobEvent } from './types.ts';

/** Why a merged job was not autonomous, in the order judgeAutonomy checks them. */
export const AUTONOMY_REASONS = ['person-rework', 'person-revise', 'person-decision', 'escalation-person', 'pr-feedback', 'human-delta', 'reverted', 'follow-up'] as const;
export type AutonomyReason = (typeof AUTONOMY_REASONS)[number];

/**
 * A person's actions at gates that park only when config or policy requires them: they never count
 * against the autonomy rate, only against the strict one.
 */
const REQUIRED_GATE_ACTIONS = ['approve-spec', 'approve-split', 'approve-repos', 'reject-repos', 'approve-release'] as const;

/** The parks a person's `approve` clears as a required gate (`human` only with a protected-paths reason). */
const REQUIRED_PARKS = new Set(['issue-link', 'infra']);

export interface Autonomy {
  autonomous: boolean;
  strict: boolean;
  reasons: AutonomyReason[];
}

const isPerson = (e: JobEvent): boolean => e.type === 'human' && !isForemanActor(e);

const toSide = (e: JobEvent): { state?: unknown; waitingOn?: unknown } => (e.to && typeof e.to === 'object' ? e.to : {});

/** The last park before events[i]: the waitingOn and reason of the transition into `waiting`. */
function parkBefore(events: JobEvent[], i: number): { waitingOn: unknown; reason: string } | null {
  for (let k = i - 1; k >= 0; k--) {
    const e = events[k];
    if (e.type !== 'transition') continue;
    const to = toSide(e);
    if (to.state === 'waiting') return { waitingOn: to.waitingOn, reason: typeof e.reason === 'string' ? e.reason : '' };
  }
  return null;
}

const isRequiredPark = (p: { waitingOn: unknown; reason: string } | null): boolean =>
  Boolean(p) && (REQUIRED_PARKS.has(String(p!.waitingOn)) || (p!.waitingOn === 'human' && p!.reason.startsWith('protected paths')));

/**
 * Null until the job's root PR is merged and its outcome final. Then autonomous when no person
 * reworked, revised or decided beyond a required gate, no person settled an escalation, the PR got
 * no human feedback or edits, and the merge was neither reverted nor followed by a bug.
 */
export function judgeAutonomy(job: Job, events: JobEvent[]): Autonomy | null {
  if (job.pr?.state !== 'MERGED' || job.outcome?.status !== 'final') return null;
  const found = new Set<AutonomyReason>();
  let gated = false;
  events.forEach((e, i) => {
    if (!isPerson(e)) return;
    const action = e.action;
    if (action === 'rework') found.add('person-rework');
    else if (action === 'revise-spec' || action === 'revise-split') found.add('person-revise');
    else if ((REQUIRED_GATE_ACTIONS as readonly unknown[]).includes(action)) gated = true;
    else if (action === 'approve' || action === 'answer') {
      if (isRequiredPark(parkBefore(events, i))) gated = true;
      else found.add('person-decision');
    }
  });
  if (job.decision === 'ESCALATE') {
    const parked = events.findLastIndex((e) => e.type === 'transition' && toSide(e).state === 'waiting' && toSide(e).waitingOn === 'escalation');
    // A person who merged the escalated PR on GitHub leaves no event at all: only the foreman's approval clears it.
    if (!events.slice(parked + 1).some((e) => e.type === 'human' && isForemanActor(e) && e.action === 'approve')) found.add('escalation-person');
  }
  if (events.some((e) => e.type === 'pr-synced' && e.newFeedback === true)) found.add('pr-feedback');
  const d = job.pr.humanDelta;
  if (d?.status === 'rewritten' || (d?.status === 'measured' && (d.fileCount ?? 0) > 0)) found.add('human-delta');
  if (job.outcome.reverted === true) found.add('reverted');
  if (typeof job.outcome.followUps === 'number' && job.outcome.followUps > 0) found.add('follow-up');
  const reasons = AUTONOMY_REASONS.filter((r) => found.has(r));
  return { autonomous: !reasons.length, strict: !reasons.length && !gated, reasons };
}
