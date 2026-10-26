// A job's merge mode as the drawer shows it: its own (auto or human), else merge.auto's.
import { MERGE_MODES } from './types.ts';
import { post } from './focus.ts';
import type { MergeMode, PostJobMergeModeResponse } from './types.ts';

/** The job's own mode when it is a valid one, else null (inherit). */
export const ownMergeMode = (v: unknown): MergeMode | null => ((MERGE_MODES as readonly unknown[]).includes(v) ? (v as MergeMode) : null);

/** Whether agents may merge the job: its own mode, else merge.auto (autoMerge in lib/core/config/load.ts). */
export const agentsMerge = (job: unknown, autoMerge: unknown): boolean => (ownMergeMode(job) ?? (autoMerge === true ? 'auto' : 'human')) === 'auto';

/** POST /api/jobs/:id/merge-mode (null inherits). Throws with the server's `error` field, else its text, else the status text. */
export const postJobMergeMode = (id: string, mergeMode: MergeMode | null, token: string, fetchImpl: typeof fetch = fetch): Promise<PostJobMergeModeResponse> =>
  post<PostJobMergeModeResponse>(`/api/jobs/${encodeURIComponent(id)}/merge-mode`, { mergeMode }, token, fetchImpl);
