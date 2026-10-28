// The Needs you PR row's actions: which ones a pr-review job's PR offers, and the POST that re-runs or fixes its CI.
import type { Job } from './types.ts';

/** `rerun` re-runs the head's failed GitHub Actions runs, `fix-ci` starts a person's rework naming the failing checks, `feedback` addresses the PR feedback. */
export type PrAction = 'rerun' | 'fix-ci' | 'feedback';

const SHA = /^[0-9a-f]{40}$/;
const count = (n: unknown): number => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0);

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
  if (count(pr.unresolvedThreads) > 0 || count(pr.feedbackSinceRound) > 0) out.push('feedback');
  return out;
}
