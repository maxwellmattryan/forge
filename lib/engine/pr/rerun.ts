// CI re-runs after a CI rework with no new commit: re-run the PR head's failed GitHub Actions jobs
// once, then park the job for a person when they fail again or can't be re-run. Once per head, with
// no gate, no rework and no resume, so a check that keeps failing can't make Forge loop.
import { logEvent, readEvents, setJob } from '#core/job/store.ts';
import type { Job, JobEvent } from '#core/types.ts';
import { RUN_ID, checksText, safePrNumber } from '#integrations/github/pull-requests.ts';
import type { GitHub, PrSnapshot } from '#integrations/github/types.ts';

/** How every CI re-run park reason starts; startCiRework's reserved check and prReviewTell key on it. */
export const CI_RERUN_PREFIX = 'CI re-run:';

/** At most this many workflow runs are re-run per head. */
const MAX_RERUNS = 5;

/** Why a re-run head waits for a person: its re-run finished red, or nothing could be re-run. */
export type CiRerunCause = 'still-failing' | 'not-rerun';

/** The park reason: Forge's fixed text around CHECK_NAME names, a PR number and a short sha, so CI_RERUN_REASON holds it. */
export function ciRerunReason(cause: CiRerunCause, failing: { names: string[]; more: number }, n: number | string, head: string): string {
  const at = `on PR #${n} at ${head.slice(0, 12)}`;
  return cause === 'still-failing'
    ? `${CI_RERUN_PREFIX} ${checksText(failing)} still failing ${at} after a CI rework with no new commit and one re-run. Local verify passes. A human decides`
    : `${CI_RERUN_PREFIX} ${checksText(failing)} failing ${at} after a CI rework with no new commit, and Forge could not re-run them. Local verify passes. A human decides`;
}

const parked = (j: Pick<Job, 'stage' | 'state' | 'waitingOn'>) => j.stage === 'pr' && j.state === 'waiting' && j.waitingOn === 'pr-review';
const latest = (events: JobEvent[], type: string, head: string): JobEvent | undefined => events.findLast((e) => e.type === type && e.head === head);
/** An event's ids, read defensively: events.jsonl is agent-appendable, and anything else counts as none, which leans toward parking. */
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && RUN_ID.test(x)) : []);

/**
 * The CI re-run for `head`, a red head the foreman already reworked (`startCiRework` checked the rest):
 * - checks still pending: wait;
 * - a `ci-rerun-failed` for this head: park again with its cause (a person's action earns no second re-run);
 * - a `ci-rerun` for this head: wait while a failing check is still one of the jobs it re-ran (GitHub has
 *   not replaced them yet), else park with `still-failing`;
 * - else re-run the failing Actions runs in the PR's own repo whose run is on this head and completed,
 *   at most 5, and log `ci-rerun`; when none is accepted, park with `not-rerun`.
 * `job` is the CLI's record after this sync; `pr` the snapshot this sync read.
 */
export async function ciRerun(
  root: string,
  github: GitHub,
  slug: string,
  job: Job,
  head: string,
  pr: Pick<PrSnapshot, 'failingChecks' | 'failingRuns'>,
  events: JobEvent[],
): Promise<'rerun' | 'waiting' | 'held'> {
  if (job.pr?.checks?.pending !== 0) return 'waiting';
  const failed = latest(events, 'ci-rerun-failed', head);
  if (failed) return park(root, job, head, failed.cause === 'not-rerun' ? 'not-rerun' : 'still-failing', pr.failingChecks);
  const rerun = latest(events, 'ci-rerun', head);
  if (rerun) {
    const jobs = new Set(ids(rerun.jobs));
    return pr.failingRuns.some((r) => jobs.has(r.job)) ? 'waiting' : park(root, job, head, 'still-failing', pr.failingChecks);
  }
  // Only the PR's own repo, and every call passes -R slug: a detailsUrl elsewhere never picks the repo.
  const own = pr.failingRuns.filter((r) => r.slug.toLowerCase() === slug.toLowerCase());
  const accepted: string[] = [];
  for (const run of [...new Set(own.map((r) => r.run))].slice(0, MAX_RERUNS)) {
    try {
      // A detailsUrl may point at any failed run in the repo (a deploy, say): only one on this head counts.
      const view = github.viewRun(root, slug, run);
      if (view.headSha !== head || view.status !== 'completed') continue;
      if (github.rerunFailed(root, slug, run).ok) accepted.push(run);
    } catch {
      // A run GitHub can't show or re-run is skipped; none left parks below.
    }
  }
  if (accepted.length) {
    const jobs = [...new Set(own.filter((r) => accepted.includes(r.run)).map((r) => r.job))];
    logEvent(root, job.id, 'ci-rerun', { head, runs: accepted, jobs, checks: pr.failingChecks.names });
    return 'rerun';
  }
  // A concurrent sync may have re-run this head during the gh calls above: its re-run stands.
  if (latest(readEvents(root, job.id), 'ci-rerun', head)) return 'rerun';
  return park(root, job, head, 'not-rerun', pr.failingChecks);
}

/** Writes the reason only (waitingOn stays pr-review, as at the CI rework cap) while the job is parked at `head`; `ci-rerun-failed` once per head. */
function park(root: string, job: Job, head: string, cause: CiRerunCause, failing: { names: string[]; more: number }): 'held' {
  const reason = ciRerunReason(cause, failing, safePrNumber(job.pr?.number) ?? '?', head);
  let here = false;
  setJob(root, job.id, {
    derive: (j) => {
      if (!parked(j) || j.pr?.headOid !== head) return null;
      here = true;
      return j.reason === reason ? null : { reason };
    },
  });
  // Moved under us: the next sync that finds it parked at this head records it.
  if (here && !latest(readEvents(root, job.id), 'ci-rerun-failed', head)) logEvent(root, job.id, 'ci-rerun-failed', { head, cause, checks: failing.names });
  return 'held';
}
