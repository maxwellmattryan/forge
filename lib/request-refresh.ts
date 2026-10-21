// Re-reads a job's request.md from its primary issue. createJob copies the issue once, so an issue
// edited while its job waits in the queue would otherwise reach the planner and spec-writer stale.
// Only before anything was written from the request: once plan.md or spec.md exists, the spec is
// the contract and a change goes through revise.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, loadJob, logEvent, readEvents, requestBody, updateJob } from './jobs.ts';
import { nativeRef, primaryIssue } from './issue-ref.ts';
import { memberForRef, memberTrackerConfig } from './member-trackers.ts';
import { localRepoSlug } from './repo-slug.ts';
import { loadTracker, memberTracker } from './trackers/index.ts';
import { ForgeError, writeTextAtomic } from './util.ts';
import type { Config, Job, TrackerItem } from './types.ts';

export type RefreshTrigger = 'cli' | 'claim';

export interface RequestRefresh {
  id: string;
  refreshed: boolean;
  ref?: string;
  titleChanged?: boolean;
  /** Why nothing was read, on a claim's best-effort refresh. */
  skipped?: string;
}

const TERMINAL = new Set(['done', 'cancelled', 'failed']);

/**
 * What stops a refresh, before any tracker call; null when the request may still change. A person
 * running `refresh-request` names the job, so any linked issue will do; a claim's refresh also
 * needs request.md to have come from that issue.
 */
function refreshBlocker(root: string, job: Job, trigger: RefreshTrigger): string | null {
  if (TERMINAL.has(job.state)) return `job ${job.id} is ${job.state}`;
  const dir = jobDir(root, job.id);
  if (fs.existsSync(path.join(dir, 'spec.md'))) return 'spec.md exists, so the spec is the contract now; change it with revise';
  if (fs.existsSync(path.join(dir, 'plan.md'))) return 'plan.md exists, so the plan was made from the current request';
  if (Object.values(job.agents ?? {}).some((a) => a?.status === 'running')) return 'an agent is running and may be reading request.md';
  const issue = primaryIssue(job);
  if (!issue) return `job ${job.id} has no linked issue`;
  if (trigger === 'claim' && !requestFromIssue(root, job.id, String(issue.ref))) return `request.md was not imported from ${issue.ref}, so it holds someone's own words`;
  return null;
}

/**
 * Whether request.md was imported from `ref` at intake. A claim leaves a job written by a person
 * (`job new`, the dashboard) and linked to an issue later with its own words: the issue may be
 * broader than the job. Intake marks its `created` event `origin: issue`; a job from before that
 * qualifies only by the GitHub import fence, which nothing but intake writes at the top.
 */
function requestFromIssue(root: string, id: string, ref: string): boolean {
  const created = readEvents(root, id).find((e) => e.type === 'created') as { origin?: unknown; issues?: unknown } | undefined;
  const first = Array.isArray(created?.issues) ? (created.issues[0] as { ref?: unknown } | undefined) : undefined;
  if (!first || first.ref !== ref) return false;
  if (created!.origin === 'issue') return true;
  if (created!.origin !== undefined) return false;
  const n = /#(\d+)$/.exec(ref)?.[1] ?? (/^\d+$/.test(ref) ? ref : null);
  return n !== null && requestBody(root, id).startsWith(`> Imported from GitHub issue #${n} by @`);
}

/** The text createJob writes, so an unchanged issue compares equal. */
function requestText(title: string, body: string | undefined): string {
  return `# ${title}\n\n${body?.trim() ?? ''}\n`;
}

async function fetchIssue(root: string, config: Config, job: Job): Promise<TrackerItem | null> {
  const issue = primaryIssue(job)!;
  const native = nativeRef(issue, config.tracker.kind, localRepoSlug(root, config));
  if (native !== null) return (await loadTracker(root, config)).get({ root, config }, native);
  // A member repo's issue: only a slug a human configured matches, and only its digits reach gh.
  const member = issue.tracker === 'github' ? memberForRef(root, config, String(issue.ref)) : null;
  if (!member) throw new ForgeError(`${issue.ref} is not in this repo's tracker or a member repo's`);
  return memberTracker().get({ root, config: memberTrackerConfig(config, member.slug) }, member.n);
}

/**
 * `forge job refresh-request` (trigger cli) refuses what refreshBlocker names and fails on a
 * tracker error. A claim (trigger claim) never fails for it: it skips, and a tracker error is
 * logged on the job, since the job can still run on the request it has.
 */
export async function refreshRequest(root: string, config: Config, id: string, trigger: RefreshTrigger): Promise<RequestRefresh> {
  const job = loadJob(root, id);
  const blocker = refreshBlocker(root, job, trigger);
  if (blocker) {
    if (trigger === 'cli') throw new ForgeError(`cannot refresh the request: ${blocker}`);
    return { id: job.id, refreshed: false, skipped: blocker };
  }
  // linkedIssues keeps only issues with a ref.
  const ref = String(primaryIssue(job)!.ref);
  let item: TrackerItem | null;
  try {
    item = await fetchIssue(root, config, job);
    if (!item) throw new ForgeError(`no tracker item "${ref}"`);
  } catch (e) {
    if (trigger === 'cli') throw e;
    logEvent(root, job.id, 'request-refresh-failed', { ref, error: (e as Error).message.slice(0, 300) });
    return { id: job.id, refreshed: false, ref, skipped: 'tracker error' };
  }
  const file = path.join(jobDir(root, job.id), 'request.md');
  const text = requestText(item.title, item.body);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (current === text && job.title === item.title) return { id: job.id, refreshed: false, ref };
  let titleChanged = false;
  const unchanged = new Error('unchanged');
  try {
    updateJob(root, job.id, (j) => {
      // Checked again under the lock: an agent may have started while the tracker answered.
      const late = refreshBlocker(root, j, trigger);
      if (late) throw trigger === 'cli' ? new ForgeError(`cannot refresh the request: ${late}`) : unchanged;
      titleChanged = j.title !== item.title;
      j.title = item.title;
      writeTextAtomic(file, text);
    });
  } catch (e) {
    if (e === unchanged) return { id: job.id, refreshed: false, ref, skipped: 'an agent started' };
    throw e;
  }
  logEvent(root, job.id, 'request-refreshed', { ref, trigger, titleChanged });
  return { id: job.id, refreshed: true, ref, titleChanged };
}
