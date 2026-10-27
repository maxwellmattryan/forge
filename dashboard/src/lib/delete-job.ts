// The drawer's Delete job card: when it offers the delete, and the POST that does it.
import { post } from './focus.ts';
import type { DeleteJobResult, Job, PostDeleteJobBody } from './types.ts';

/**
 * Why the drawer offers no delete, or null when it does. The server refuses the rest (a live
 * session, split children, an active dependent) and the card shows its message.
 */
export function deleteBlocker(job: Pick<Job, 'kind' | 'pr'>): 'eval' | 'pr' | null {
  if (job.kind === 'eval') return 'eval';
  if (job.pr?.number) return 'pr';
  return null;
}

/** The confirm button arms only once the typed text is the job id, as the server checks too. */
export const confirmMatches = (typed: string, id: string): boolean => typed.trim() === id;

/** POST /api/jobs/:id/delete with the id typed back. */
export const postDeleteJob = (id: string, confirm: string, fetchImpl: typeof fetch = fetch): Promise<DeleteJobResult> =>
  post<DeleteJobResult>(`/api/jobs/${encodeURIComponent(id)}/delete`, { confirm } satisfies PostDeleteJobBody, fetchImpl);
