// `forge job new|from-ref|link|split`: creating a job, starting one from a tracker item, the issues it carries, and a
// split's child jobs.
import path from 'node:path';
import { splitJob } from '#engine/pipeline/moves/split.ts';
import { checkRepoBudget, parkForRepoBudget, repoBudgetBlock } from '#engine/metrics/repo-budget.ts';
import { claimJob, createJob, jobDir, logEvent, logHumanEvent } from '#core/job/store.ts';
import { daemonScope } from '#core/job/requests.ts';
import { issueLinkStatus } from '#core/job/issue-link.ts';
import { checkIssueRef, isSafeUrl, issueUrl } from '#core/job/issue-ref.ts';
import { githubHost, localRepoSlug } from '#integrations/git/repo-slug.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { createAndLink, linkJob, markNoIssue, suggestLink, unlinkJob } from '#engine/trackers/link.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, Effort, JobIssue } from '#core/types.ts';
import { readMandate } from '#office/mandates/store.ts';
import { isReadable } from '#office/mandates/contract.ts';
import { aliasClash, bodyFrom, deprecatedAlias, list, oneOf, req, requireJob, str, usageError } from '../args.ts';
import { startFromRef } from '../tracker.ts';
import { JOB } from './help.ts';
import { refuseEffortInDaemon } from './state.ts';

// The repo budget caps unattended spend: a session misled by tracker or PR text must not force work past it.
const FORCE_DAEMON_REFUSAL = 'forge job new --force starts work past the repo budget, which a daemon session may not do; a human runs it in their own session';
const refuseForceInDaemon = () => {
  if (process.env.FORGE_DAEMON === '1') throw new ForgeError(FORCE_DAEMON_REFUSAL);
};

/**
 * `forge job new`'s issue flags as createJob's list, checked before anything is written. Refs are
 * recorded as given, with no tracker call or claim (from-ref and link make those).
 */
function newJobIssues(root: string, config: Config, flags: Record<string, any>): { issues: JobIssue[]; noIssue: { reason: string | null } | null } {
  const typed = list(flags.issue);
  const ref = str(flags.ref, '--ref');
  const url = str(flags.url, '--url');
  const wantsNone = flags['no-issue'] === true;
  const reason = str(flags.reason, '--reason');
  if ((ref !== undefined || url !== undefined) && (typed.length || flags.issue !== undefined)) throw usageError(JOB, 'new');
  if (wantsNone && (typed.length || ref !== undefined || flags.issue !== undefined)) throw usageError(JOB, 'new');
  if (reason !== undefined && !wantsNone) throw usageError(JOB, 'new');
  if (wantsNone && config.tracker.kind === 'none') throw new ForgeError('tracker.kind is "none": no issue is needed, so there is nothing to waive (drop --no-issue)');
  if (url !== undefined && !isSafeUrl(url)) throw new ForgeError(`invalid url ${JSON.stringify(String(url).slice(0, 100))}: expected http(s) with no whitespace`);
  const tracker = str(flags.tracker, '--tracker') ?? config.tracker.kind;
  const slug = tracker === 'github' ? localRepoSlug(root, config) : null;
  const parse = (raw: string): string => {
    const r = checkIssueRef(raw, { tracker, slug });
    if ('error' in r) throw new ForgeError(r.error);
    return r.ref;
  };
  const issues: JobIssue[] = ref !== undefined || url !== undefined ? [{ tracker, ref: ref === undefined ? null : parse(ref), url: url ?? null }] : typed.map((raw) => {
    const r = parse(raw);
    return { tracker, ref: r, url: tracker === 'github' ? issueUrl(r, githubHost()) : null };
  });
  return { issues, noIssue: wantsNone ? { reason: reason ?? null } : null };
}

/**
 * The mandate the new job works under: `--mandate` (an existing mandate that isn't closed), or the
 * split parent's. A child never moves to another mandate. A daemon session may pass it: joining a
 * mandate only narrows what the Foreman decides. Every check runs before createJob.
 */
function newJobMandate(root: string, flags: Record<string, any>): string | null {
  const given = str(flags.mandate, '--mandate');
  const parent = flags.parent !== undefined ? requireJob(root, flags.parent) : null;
  if (given !== undefined) {
    const m = readMandate(root, given);
    if (!isReadable(m)) {
      if (m.problem === 'no such mandate' || m.problem === 'not a mandate id') throw new ForgeError(`no mandate ${JSON.stringify(given).slice(0, 60)}`, 'not_found');
      throw new ForgeError(`mandate ${given} can't be read (${m.problem})`);
    }
    if (m.status === 'closed') throw new ForgeError(`mandate ${given} is closed`);
  }
  if (parent && given !== undefined && given !== parent.mandate)
    throw new ForgeError(`--mandate ${given} differs from parent ${parent.id}'s mandate ${parent.mandate ?? 'none'}: a split child keeps its parent's mandate`);
  return given ?? parent?.mandate ?? null;
}

export function newCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  // Read before createJob, so a bare --session fails instead of claiming as session "true".
  const session = str(flags.session, '--session');
  // Every issue check runs before createJob, so a refused flag leaves no job dir.
  const { issues, noIssue } = newJobIssues(root, config, flags);
  const mandate = newJobMandate(root, flags);
  let effort: Effort | undefined;
  if (flags.effort !== undefined) {
    refuseEffortInDaemon();
    effort = oneOf(str(flags.effort, '--effort'), EFFORTS, 'effort');
  }
  const force = flags.force !== undefined && flags.force !== false;
  if (force) refuseForceInDaemon();
  // --services is the old name of --components, kept for one release.
  if (flags.services !== undefined && flags.components !== undefined) throw aliasClash('--services', '--components');
  const deprecated = flags.services !== undefined ? [deprecatedAlias('--services', '--components')] : [];
  const components = list(flags.components ?? flags.services);
  // Checked before the job exists, so release never frees the job being created.
  const status = checkRepoBudget(root, config);
  const job = createJob(root, config, {
    title: req(flags.title, '--title'),
    issues,
    body: bodyFrom(flags, root, config),
    parent: flags.parent,
    branch: flags.branch,
    kind: flags.kind,
    slug: flags.slug,
    components,
    effort,
    mandate,
  });
  const waived = noIssue ? markNoIssue(root, job.id, noIssue.reason).noIssue : null;
  const created = {
    id: job.id,
    branch: job.branch,
    dir: path.relative(root, jobDir(root, job.id)),
    issueLink: issueLinkStatus({ ...job, noIssue: waived }, config),
    ...(deprecated.length ? { deprecated } : {}),
  };
  if (force) logHumanEvent(root, job.id, 'budget-override', { day: status.day, month: status.month, spent: status.spent, caps: status.caps });
  const limited = Boolean(status.reason) && !force && job.kind !== 'retro';
  // Still created, so the human's request is kept, but parked and unclaimed until the budget allows it.
  if (limited && status.held) {
    parkForRepoBudget(root, job.id, status);
    return { ...created, repoBudget: repoBudgetBlock(status) };
  }
  // A split child starts unowned: the session claims each child only when it runs it.
  if (session && !flags.parent) claimJob(root, job.id, session, false);
  if (!limited) return created;
  logEvent(root, job.id, 'repo-budget-warn', { reason: status.reason });
  return { ...created, repoBudget: repoBudgetBlock(status) };
}

export async function link(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = req(id, 'job id');
  const refs = rest.slice(1);
  const removes = list(flags.remove);
  const modes = [refs.length > 0, flags.remove !== undefined, flags.create === true, flags.none === true, flags.suggest === true].filter(Boolean).length;
  if (modes !== 1 || (flags.remove !== undefined && !removes.length)) throw usageError(JOB, 'link');
  if (flags.suggest) return suggestLink(root, config, jobId, () => loadTracker(root, config));
  if (flags.none) return markNoIssue(root, jobId, typeof flags.reason === 'string' ? flags.reason : null);
  if (removes.length) return unlinkJob(root, config, jobId, removes);
  const tracker = await loadTracker(root, config);
  return flags.create ? createAndLink(root, config, tracker, jobId) : linkJob(root, config, tracker, jobId, refs);
}

/**
 * `forge job split <id>`: a decided PLAN: SPLIT as child jobs (lib/engine/pipeline/moves/split.ts). Driving work: a
 * daemon session splits only its own job, never another's, the inbox's, a chat's or the office's.
 */
export function split(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = req(rest[0], 'job id');
  const scope = daemonScope();
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  if (scope.daemon && scope.scope !== id) throw new ForgeError(`forge job split in scope ${scope.scope} splits no job but its own (${id})`, 1);
  return splitJob(root, config, requireJob(root, id).id, { tracker: () => loadTracker(root, config) });
}

export async function fromRef(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const ref = req(id, 'tracker ref');
  // A human named the item, so a hold is an error rather than an empty result.
  const status = checkRepoBudget(root, config);
  if (status.held) throw new ForgeError(status.reason!, 'blocked', 'forge budget');
  const tracker = await loadTracker(root, config);
  // An issue the human picked is planned as one job, whatever pipeline.split says.
  const r = await startFromRef(root, config, tracker, ref, flags, { splitMode: 'never' });
  if (!status.reason || 'existing' in r) return r;
  logEvent(root, r.id, 'repo-budget-warn', { reason: status.reason });
  return { ...r, repoBudget: repoBudgetBlock(status) };
}
