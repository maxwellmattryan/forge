// The Needs you PR row's actions: which ones a pr-review job's PR offers, and the POST that re-runs or fixes its CI.
import { post } from '../project/focus.ts';
import type { Job, PostJobCiBody, PostJobCiResponse } from '../core/types.ts';

/** `rerun` re-runs the head's failed GitHub Actions runs, `fix-ci` starts a person's rework naming the failing checks, `feedback` addresses the PR feedback. */
export type PrAction = 'rerun' | 'fix-ci' | 'feedback';

const SHA = /^[0-9a-f]{40}$/;
const count = (n: unknown): number => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0);

/** The comments since the latest round that the row's muted line shows: the same guard `prActions` uses, so the line and the Address the PR feedback button agree. */
export const feedbackCount = (pr: Job['pr'] | null | undefined): number => count(pr?.feedbackSinceRound);

/**
 * The row's actions, following why the open PR waits: failing checks at a known head offer Re-run (when
 * any is a GitHub Actions job in the PR's repo, or sync has not recorded that yet) and Fix CI; threads or
 * feedback since the latest round offer Address the PR feedback. A PR with neither offers none.
 */
export function prActions(pr: Job['pr'] | null | undefined): PrAction[] {
  if (!pr || pr.state !== 'OPEN') return [];
  const out: PrAction[] = [];
  if (pr.checks?.state === 'failing' && typeof pr.headOid === 'string' && SHA.test(pr.headOid)) {
    if (pr.failingChecks === undefined || count(pr.failingChecks.actions) > 0) out.push('rerun');
    out.push('fix-ci');
  }
  if (count(pr.unresolvedThreads) > 0 || feedbackCount(pr) > 0) out.push('feedback');
  return out;
}

/** POST /api/jobs/:id/ci: Re-run failed checks or Fix CI at the head the row showed. */
export const postPrCi = (id: string, body: PostJobCiBody, fetchImpl: typeof fetch = fetch): Promise<PostJobCiResponse> =>
  post<PostJobCiResponse>(`/api/jobs/${encodeURIComponent(id)}/ci`, { action: body.action, head: body.head } satisfies PostJobCiBody, fetchImpl);
