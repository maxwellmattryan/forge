// Re-reads a job's request.md from its primary issue. createJob copies the issue once, so an issue
// edited while its job waits in the queue would otherwise reach the planner and spec-writer stale.
// Only before anything was written from the request: once plan.md or spec.md exists, the spec is
// the contract and a change goes through revise.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, loadJob, logEvent, readEvents, requestBody, updateJob } from '../../core/job/store.ts';
import { nativeRef, primaryIssue } from '../../core/job/issue-ref.ts';
import { memberForRef, memberTrackerConfig } from '../project/member-trackers.ts';
import { localRepoSlug } from '../../integrations/git/repo-slug.ts';
import { loadTracker, memberTracker } from './load.ts';
import { issueAuthorAssociation, trustedAssociation } from '../../integrations/github/tracker.ts';
import { ForgeError } from '../../core/errors.ts';
import { writeTextAtomic } from '../../core/os/fs.ts';
import type { Config, Job, Tracker, TrackerCtx, TrackerItem } from '../../core/types.ts';

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

interface IssueSource {
  tracker: Tracker;
  ctx: TrackerCtx;
  /** The tracker's own ref: a GitHub number, a backlog slug, an adapter's key. */
  ref: string;
  kind: string;
}

async function issueSource(root: string, config: Config, job: Job): Promise<IssueSource> {
  const issue = primaryIssue(job)!;
  const native = nativeRef(issue, config.tracker.kind, localRepoSlug(root, config));
  if (native !== null) return { tracker: await loadTracker(root, config), ctx: { root, config }, ref: native, kind: config.tracker.kind };
  // A member repo's issue: only a slug a human configured matches, and only its digits reach gh.
  const member = issue.tracker === 'github' ? memberForRef(root, config, String(issue.ref)) : null;
  if (!member) throw new ForgeError(`${issue.ref} is not in this repo's tracker or a member repo's`);
  return { tracker: memberTracker(), ctx: { root, config: memberTrackerConfig(config, member.slug) }, ref: member.n, kind: 'github' };
}

/**
 * Why a claim may not take an edited issue's text, which nobody looked at since intake, or null.
 * On a public repo anyone may open an issue and keep editing it, so only an author with write
 * access is taken on trust. The local backlog is a file in the repo; other adapters can't say who
 * wrote an item, so their edits wait for `refresh-request`.
 */
function untrustedAuthor(src: IssueSource): { reason: string; association?: string } | null {
  if (src.kind === 'local') return null;
  if (src.kind !== 'github') return { reason: `the ${src.kind} tracker can't say who wrote the issue` };
  const association = issueAuthorAssociation(src.ctx, src.ref);
  if (association === null) return { reason: "gh didn't say who wrote the issue" };
  return trustedAssociation(association) ? null : { reason: 'the issue author has no write access', association };
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
  let src: IssueSource;
  let item: TrackerItem | null;
  try {
    src = await issueSource(root, config, job);
    item = src.tracker.get(src.ctx, src.ref);
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
  // Checked only once something changed, so an unchanged issue costs one tracker call.
  const untrusted = trigger === 'claim' ? untrustedAuthor(src) : null;
  if (untrusted) {
    logEvent(root, job.id, 'request-refresh-skipped', { ref, reason: untrusted.reason, ...(untrusted.association ? { association: untrusted.association } : {}) });
    return { id: job.id, refreshed: false, ref, skipped: untrusted.reason };
  }
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
