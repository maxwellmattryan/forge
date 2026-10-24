// The drawer's Merge now card: when it offers a person's merge-now, and the POST that does it.
import { post } from './focus.ts';
import type { Job, PostJobMergeBody, PostJobMergeResponse } from './types.ts';

export { confirmMatches } from './delete-job.ts';

/** The card shows only for a feature job whose PR is open: there is nothing to merge otherwise. */
export const mergeNowOffered = (job: Pick<Job, 'kind' | 'pr'>): boolean => job.kind !== 'eval' && job.pr?.state === 'OPEN';

/** Whether a merge-now result is a merged PR: the card toasts these and shows any other action inline. */
export const mergeNowDone = (r: Pick<PostJobMergeResponse, 'action'>): boolean => r.action === 'merged' || r.action === 'already-merged';

/** POST /api/jobs/:id/merge with the id typed back. */
export const postMergeNow = (id: string, confirm: string, token: string, fetchImpl: typeof fetch = fetch): Promise<PostJobMergeResponse> =>
  post<PostJobMergeResponse>(`/api/jobs/${encodeURIComponent(id)}/merge`, { now: true, confirm } satisfies PostJobMergeBody, token, fetchImpl);
