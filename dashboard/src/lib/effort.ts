// Reasoning effort as the dashboard shows it. effectiveEffort mirrors resolveEffort in lib/config-models.ts (the
// dashboard can't import lib/), and test/dashboard-effort.test.ts checks both against one table.
import { EFFORTS } from './types.ts';
import type { DaemonSessionState, Effort, PostJobEffortResponse } from './types.ts';

const valid = (v: unknown): Effort | null => ((EFFORTS as readonly unknown[]).includes(v) ? (v as Effort) : null);

/** The level a job runs at: its own, else the repo default (runtime.effort), else null (Claude Code's own setting). */
export function effectiveEffort(job: unknown, fallback: unknown): Effort | null {
  return valid(job) ?? valid(fallback);
}

/** The level a job's chip shows: its own, and only when it differs from the repo default, so inheriting jobs add no chip. */
export function effortChip(job: unknown, fallback: unknown): Effort | null {
  const own = valid(job);
  return own !== null && own !== valid(fallback) ? own : null;
}

/** xhigh and max cost the most, so they read as a warning. */
export const effortTone = (level: Effort): 'warn' | 'muted' => (level === 'xhigh' || level === 'max' ? 'warn' : 'muted');

/**
 * A running session started at another level than the job now resolves to. It switches at its next spawn, while
 * agents the orchestrator starts from now on already get the new level.
 */
export function restartPending(session: Partial<DaemonSessionState> | null | undefined, job: unknown, fallback: unknown): boolean {
  return session?.running === true && (session.effort ?? null) !== effectiveEffort(job, fallback);
}

/** POST /api/jobs/:id/effort (null inherits). Throws with the server's `error` field, else its text, else the status text. */
export async function postJobEffort(id: string, effort: Effort | null, token: string, fetchImpl: typeof fetch = fetch): Promise<PostJobEffortResponse> {
  const res = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}/effort`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forge-token': token },
    body: JSON.stringify({ effort }),
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {}
  const error = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : '';
  if (!res.ok) throw new Error(error || text || res.statusText);
  return body as PostJobEffortResponse;
}
