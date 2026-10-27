// A job's state mirrored onto its linked issues, each in its own repo's tracker, and a one-off note
// posted to them. Below the CLI layer, so `forge job delete` (lib/engine/ops/delete.ts), the shelf
// (lib/engine/pipeline/moves/shelve.ts) and the tracker commands share it.
import { isActive, listJobs, logEvent } from '#core/job/store.ts';
import { linkedIssues, nativeRef, nativeRefs, sameIssue } from '#core/job/issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import { loadTracker, memberTracker } from './load.ts';
import { matchMember, memberTrackerConfig, memberTrackers, qualify } from '../project/member-trackers.ts';
import type { MemberTracker } from '../project/member-trackers.ts';
import type { Config, Job, JobIssue, Tracker } from '#core/types.ts';

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
 * Posts `text` once to each linked issue this repo's tracker owns (through `tracker` when given) and
 * to each member repo's issue through that member's tracker: the set commentApproval posts to. The
 * caller builds `text` from fixed words around cleaned values. Best-effort: each failure is logged as
 * `tracker-error` and never thrown. Eval jobs and `tracker.kind: none` post nothing.
 */
export async function noteIssues(root: string, config: Config, job: Job, text: string, tracker?: Tracker): Promise<{ posted: string[]; failed: boolean }> {
  const out = { posted: [] as string[], failed: false };
  if (job.kind === 'eval' || config.tracker.kind === 'none') return out;
  const slug = localRepoSlug(root, config);
  const refs = nativeRefs(job, config.tracker.kind, slug);
  const members = memberIssues(root, config, job, slug);
  const failed = (e: unknown) => {
    out.failed = true;
    logEvent(root, job.id, 'tracker-error', { error: (e as Error).message.slice(0, 300) });
  };
  const post = (t: Tracker, ctx: { root: string; config: Config }, ref: string, shown: string) => {
    try {
      t.comment(ctx, ref, text);
      out.posted.push(shown);
    } catch (e) {
      failed(e);
    }
  };
  if (refs.length) {
    try {
      const t = tracker ?? (await loadTracker(root, config));
      for (const ref of refs) post(t, { root, config }, ref, ref);
    } catch (e) {
      failed(e);
    }
  }
  for (const { member } of members) post(memberTracker(), { root, config: memberTrackerConfig(config, member.slug) }, member.n, qualify(member.slug, member.n));
  return out;
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
