// A job's state mirrored onto its linked issues, each in its own repo's tracker. Below the CLI
// layer, so `forge job delete` (lib/delete.ts) and the tracker commands share it.
import { isActive, listJobs, logEvent } from '../../core/job/store.ts';
import { linkedIssues, nativeRef, sameIssue } from '../../core/job/issue-ref.ts';
import { localRepoSlug } from '../../integrations/git/repo-slug.ts';
import { loadTracker, memberTracker } from './load.ts';
import { matchMember, memberTrackerConfig, memberTrackers } from '../project/member-trackers.ts';
import type { MemberTracker } from '../project/member-trackers.ts';
import type { Config, Job, JobIssue } from '../../core/types.ts';

/** The job's linked issues a member repo's tracker owns, each with its member and number. */
export function memberIssues(root: string, config: Config, job: Job, slug: string | null): { issue: JobIssue; member: MemberTracker & { n: string } }[] {
  const kind = config.tracker.kind;
  const candidates = linkedIssues(job).filter((i) => i.tracker === 'github' && nativeRef(i, kind, slug) === null);
  if (!candidates.length) return [];
  const members = memberTrackers(root, config);
  if (!members.length) return [];
  return candidates.flatMap((issue) => {
    const member = matchMember(members, issue.ref);
    return member ? [{ issue, member }] : [];
  });
}

/**
 * Best-effort: tracker hiccups must never block the pipeline. Each issue is updated in its own
 * repo: this repo's through its tracker, a member repo's through that member's; every other issue
 * is foreign and left alone. A finished job leaves alone an issue another active job still
 * carries, so one sharer finishing never marks the shared issue done. One repo's failure is
 * logged and never skips another's.
 */
export async function mirrorToTracker(root: string, config: Config, job: Job): Promise<void> {
  if (job.kind === 'eval') return;
  const kind = config.tracker.kind;
  const slug = localRepoSlug(root, config);
  let issues = linkedIssues(job).filter((i) => nativeRef(i, kind, slug) !== null);
  let members = memberIssues(root, config, job, slug);
  if (!issues.length && !members.length) return;
  if (job.state === 'done' || job.state === 'cancelled') {
    const others = listJobs(root).filter((j) => j.id !== job.id && isActive(j));
    const shared = (i: JobIssue) => others.some((o) => o.issues.some((x) => sameIssue(x, i, slug)));
    issues = issues.filter((i) => !shared(i));
    members = members.filter((m) => !shared(m.issue));
  }
  const failed = (e: unknown) => logEvent(root, job.id, 'tracker-error', { error: (e as Error).message.slice(0, 300) });
  if (issues.length) {
    try {
      const tracker = await loadTracker(root, config);
      for (const i of issues) tracker.update({ root, config }, nativeRef(i, kind, slug)!, job);
    } catch (e) {
      failed(e);
    }
  }
  for (const { member } of members) {
    try {
      memberTracker().update({ root, config: memberTrackerConfig(config, member.slug) }, member.n, job);
    } catch (e) {
      failed(e);
    }
  }
}
