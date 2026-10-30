// The protected-paths flag as the board, the drawer and the Needs-you card show it. Paths and reasons
// come from the branch and the repo's config: components render them as escaped text only.
import type { Job } from '../core/types.ts';

/** What the dashboard shows for a job with protected paths: protectedSummary. */
export interface ProtectedSummary {
  /** Unique reasons, in rule order. */
  reasons: string[];
  /** At most 10 path rows, in the flag's order. */
  rows: { path: string; reason: string }[];
  /** Paths not listed in rows, the flag's own `more` included. */
  more: number;
}

export const PROTECTED_ROWS = 10;

/** Null when the job changes no protected path. */
export function protectedSummary(job: Pick<Job, 'protectedPaths'>): ProtectedSummary | null {
  const flag = job.protectedPaths;
  if (!flag || !Array.isArray(flag.hits) || !flag.hits.length) return null;
  const reasons = [...new Set([...flag.hits].sort((a, b) => a.rule - b.rule).map((h) => h.reason))];
  const rows = flag.hits.slice(0, PROTECTED_ROWS).map((h) => ({ path: h.path, reason: h.reason }));
  return { reasons, rows, more: flag.hits.length - rows.length + (Number(flag.more) || 0) };
}

/**
 * Whether the Needs-you card shows the job's park reason. An escalation park's reason only names the
 * rules its `Why it waits` list shows with their details, and a legacy protected park's reason names
 * a few of the paths the card's list shows in full, so with either list it is left out.
 */
export function showParkReason(job: Pick<Job, 'reason' | 'protectedPaths'> & { gateReasons?: unknown }): boolean {
  if (!job.reason) return false;
  if (Array.isArray(job.gateReasons) && job.gateReasons.length) return false;
  return !(protectedSummary(job) && job.reason.startsWith('protected paths'));
}
