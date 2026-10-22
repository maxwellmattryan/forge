// The decide gate's recall facts (RC1, RC2) and the approver's `Reviewer recall:` line read them
// too, so they live apart from the decide table and the brief: pure functions of the StepInput.
import { isForemanActor } from '../jobs.ts';
import { LENS_NAME } from '../lens.ts';
import type { JobEvent, StepInput } from '../types.ts';

/** RC2's park reason: it names the prompts' hash, so a waiver never carries over to later prompt edits. */
export const recallReason = (hash: string | null): string => `recall eval: no recorded run for prompts ${hash ?? 'unknown'}`;

/** `recall` events of `phase` for exactly the worktree's current prompts; none for a null hash. */
export function recallEvents(x: Pick<StepInput, 'recall' | 'events'>, phase: 'start' | 'record'): JobEvent[] {
  const hash = x.recall?.pluginHash;
  return hash ? x.events.filter((e) => e.type === 'recall' && e.phase === phase && e.pluginHash === hash) : [];
}

export const recallRecorded = (x: Pick<StepInput, 'recall' | 'events'>): boolean => recallEvents(x, 'record').length > 0;

/**
 * A person's approve (never the foreman's) given at an RC2 park for these prompts: the park's
 * matching as protectedApproved reads it, with the reason naming this hash.
 */
export function recallWaived(x: Pick<StepInput, 'recall' | 'events'>): boolean {
  const reason = recallReason(x.recall?.pluginHash ?? null);
  return x.events.some((e, i) => {
    if (e.type !== 'human' || e.action !== 'approve' || isForemanActor(e)) return false;
    const parked = x.events.slice(0, i).findLast((t) => t.type === 'transition');
    const to = (parked?.to ?? {}) as { state?: string; waitingOn?: string | null };
    return to.state === 'waiting' && to.waitingOn === 'human' && parked?.reason === reason;
  });
}

const RUN_ID = /^\d{8}-\d{6}(-[a-z0-9-]{1,80})?$/;
const SHA = /^[0-9a-f]{40}$/;
const rate = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A summary's per-lens recall and precision, with only lens names and numbers kept. */
function byLens(summary: unknown): Record<string, { recall: number | null; precision: number | null }> {
  const lenses = (summary as { byLens?: unknown } | null)?.byLens;
  const out: Record<string, { recall: number | null; precision: number | null }> = {};
  if (!lenses || typeof lenses !== 'object' || Array.isArray(lenses)) return out;
  for (const [lens, g] of Object.entries(lenses as Record<string, any>)) if (LENS_NAME.test(lens) && lens.length <= 64) out[lens] = { recall: rate(g?.recall), precision: rate(g?.precision) };
  return out;
}

const side = (r: { run?: unknown; head?: unknown; summary?: unknown } | null | undefined) =>
  r && typeof r.run === 'string' && RUN_ID.test(r.run) ? { run: r.run, head: typeof r.head === 'string' && SHA.test(r.head) ? r.head.slice(0, 12) : null, byLens: byLens(r.summary) } : null;

/**
 * The approver's `Reviewer recall:` line: not checked when the gate does not apply, none when the diff
 * changes no reviewer prompts, the waiver, or the latest record for these prompts and the base-branch
 * run beside it, as JSON of ids, shas and numbers.
 */
export function recallLine(x: Pick<StepInput, 'recall' | 'events' | 'job'>): string {
  if (!x.recall) return `Reviewer recall: not checked (${x.job.kind === 'eval' ? 'an eval job' : 'no recall fixtures in the main checkout'})`;
  if (!x.recall.required) return 'Reviewer recall: none (the diff changes no reviewer prompts)';
  const last = recallEvents(x, 'record').at(-1);
  const mine = last ? side(last as { run?: unknown; head?: unknown; summary?: unknown }) : null;
  if (!mine) return recallWaived(x) ? 'Reviewer recall: waived by a human' : 'Reviewer recall: no recorded run for these prompts';
  return `Reviewer recall: ${JSON.stringify({ ...mine, base: side(last!.base as { run?: unknown } | null) })}`;
}
