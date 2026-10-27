// A gate's decision in flight: what a job's request buttons show between the click and the job moving on. Never a guess at
// the next state: it reads this tab's own click until the POST answers, then the request queue /api/state serves, so it
// says only what is true (sending, queued, being applied) and goes when the request leaves the queue. Pure, so node:test
// can pin it.
import type { ForgeRequest, RequestType } from './types.ts';

/** A decision this tab sent: the pressed button's label, then the queued request's id and server time once the POST answers. */
export interface SentDecision {
  label: string;
  id: string | null;
  at: string | null;
}

export type DecisionPhase = 'sending' | 'queued' | 'applying';

export interface DecisionView {
  /** The pressed button's label; null for a request this tab did not send (another tab, the CLI, the Foreman). */
  label: string | null;
  type: RequestType | null;
  phase: DecisionPhase;
}

/** The request types that decide a job's gate: JOB_REQUEST_TYPES in lib/core/job/requests.ts. */
export const DECISION_TYPES: readonly RequestType[] = ['approve', 'revise-spec', 'rework', 'answer', 'cancel', 'resume'];

const open = (r: ForgeRequest): boolean => r.status === 'pending' || r.status === 'in-progress';
const phaseOf = (r: ForgeRequest): DecisionPhase => (r.status === 'in-progress' ? 'applying' : 'queued');

/**
 * Whether a sent decision has left the queue: a state served after the request was created no longer lists it as open.
 * One still sending, or one no state has been served since, has not.
 */
export function sentResolved(sent: SentDecision, requests: readonly ForgeRequest[], now: string | null): boolean {
  if (sent.id === null || sent.at === null || now === null) return false;
  if (requests.some((r) => r.id === sent.id && open(r))) return false;
  const served = Date.parse(now);
  const created = Date.parse(sent.at);
  return Number.isFinite(served) && Number.isFinite(created) && served >= created;
}

/** The sent decisions still in flight, and the ids of those that just left the queue. Returns the same map when none left. */
export function pruneSent(sent: Record<string, SentDecision>, requests: readonly ForgeRequest[], now: string | null): { sent: Record<string, SentDecision>; resolved: string[] } {
  const resolved: string[] = [];
  const kept: Record<string, SentDecision> = {};
  for (const [job, s] of Object.entries(sent)) {
    if (sentResolved(s, requests, now)) resolved.push(s.id!);
    else kept[job] = s;
  }
  return { sent: resolved.length ? kept : sent, resolved };
}

/** A job's decision in flight: this tab's own click first, else the newest open decision request for the job. Null for none. */
export function decisionInFlight(job: string, sent: SentDecision | null | undefined, requests: readonly ForgeRequest[] | null | undefined): DecisionView | null {
  const list = requests ?? [];
  if (sent) {
    if (sent.id === null) return { label: sent.label, type: null, phase: 'sending' };
    const r = list.find((x) => x.id === sent.id);
    // Not listed yet: no state has been served since the POST, or this one already left (pruneSent drops it on the next poll).
    return { label: sent.label, type: r?.type ?? null, phase: r && open(r) ? phaseOf(r) : 'queued' };
  }
  const mine = list.filter((r) => r.job === job && open(r) && DECISION_TYPES.includes(r.type));
  const r = mine.reduce<ForgeRequest | null>((a, b) => (a && a.createdAt >= b.createdAt ? a : b), null);
  return r ? { label: null, type: r.type, phase: phaseOf(r) } : null;
}
