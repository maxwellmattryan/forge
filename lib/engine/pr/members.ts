// Member-repo PRs of a linked job: check, open, record and sync them, and keep their sibling links
// current.
import fs from 'node:fs';
import path from 'node:path';
import { jobDir, loadJob, logEvent, readEvents, updateJob } from '#core/job/store.ts';
import type { Config, Job, JobRepoPr, PrChecks } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { safeText } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { githubHost, slugFromRemote } from '#integrations/git/repo-slug.ts';
import { SLUG_RE, assertJobPr, safePrNumber } from '#integrations/github/pull-requests.ts';
import type { GitHub, PrSnapshot } from '#integrations/github/types.ts';
import { memberConfig, memberEntry, memberRepos, memberWorktree } from '../project/job-repos.ts';
import { isLinkedJob, jobRepoOrder, siblingLine } from '../project/repo-order.ts';
import type { PrStateKey, RepoKey } from '../project/repo-order.ts';
import { attributionForbidden, scrubBranch } from '../guard/attribution.ts';
import { logSecrets, refusalMessage, refuseSecrets, scanBranch, secretsBlock, textUnit } from '../guard/secrets.ts';
import { FULL_SHA } from '../release/interim.ts';
import { memberPrBody, spliceSiblings } from './body.ts';
import { pushBranch, refreshBase } from './branch.ts';

/** One member repo's part of `forge pr open`: openMemberPr. */
export interface MemberPrResult {
  repo: string;
  number: number;
  url: string | null;
  created: boolean;
}

/**
 * A member repo's GitHub `owner/name`: its `tracker.repo` when the tracker is github, else read from
 * its remote url. Refused when neither gives one.
 */
export function memberSlug(config: Config, name: string): string {
  const repo = memberConfig(config, name);
  if (repo.tracker?.kind === 'github' && typeof repo.tracker.repo === 'string' && repo.tracker.repo) return repo.tracker.repo;
  const slug = slugFromRemote(repo.remote, githubHost());
  if (slug) return slug;
  throw new ForgeError(`cannot determine the GitHub repository of repo ${name}; set repos[].tracker.repo`);
}

/** What openMemberPr pushes and opens, fixed by checkMemberPr before any repo is pushed. */
interface MemberPrPlan {
  repo: string;
  slug: string;
  worktree: string;
  base: string;
  checked: string;
  body: string;
}

/**
 * Every check a member repo needs before anything leaves the machine: the secret scan of its PR
 * body and of its commits (after refreshing its base from the push remote), at least one commit ahead
 * of its base, and a slug to open the PR in. The commit checked is the HEAD verify recorded.
 */
export function checkMemberPr(root: string, config: Config, job: Job, name: string, title: string, mode: 'block' | 'warn', verified: string | undefined): MemberPrPlan {
  const { member, worktree } = memberWorktree(root, config, job, name);
  const base = member.base!;
  const checked = verified ?? git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
  if (!FULL_SHA.test(checked)) throw new ForgeError(`HEAD of repo ${name} is not a commit id`);
  const body = memberPrBody(root, config, job);
  refuseSecrets(root, config, [textUnit('(pr title)', title), textUnit(`(pr body of repo ${name})`, body)], { what: `the PR title or body of repo ${name}`, id: job.id, gate: 'pr' });
  const view = { ...job, worktree, base };
  refreshBase(view, config, mode);
  const scan = scanBranch(root, config, view, { staged: false, head: checked });
  logSecrets(root, job.id, 'pr', scan, { blocked: mode === 'block' });
  if (mode === 'block' && scan.error) throw new ForgeError(`secret scan of repo ${name}'s commits could not finish (${scan.error}); forge pr open won't push an unscanned branch`, 'secret_found', `forge secrets scan ${job.id}`);
  if (secretsBlock(scan.findings, mode)) throw new ForgeError(refusalMessage(`the commits of repo ${name}`, scan.findings), 'secret_found', `forge secrets scan ${job.id}`);
  const ahead = git(worktree, ['rev-list', '--count', `${config.git.remote}/${base}..${checked}`, '--'], { allowFail: true });
  if (!ahead.ok || ahead.stdout.trim() === '0') throw new ForgeError(`repo ${name} has no commits ahead of ${base}; remove it (forge job repo remove) or re-add it with --verify-only`);
  return { repo: name, slug: memberSlug(config, name), worktree, base, checked, body };
}

/**
 * Pushes a member's checked commit (scrubbed of attribution when that is forbidden) to the job's
 * branch and finds its open PR by branch or creates one. The PR is recorded at once, so a failure in
 * a later repo keeps it, and a rerun finds it again. A failure names the repo.
 */
export function openMemberPr(root: string, config: Config, github: GitHub, job: Job, p: MemberPrPlan, title: string, draft: boolean | undefined): MemberPrResult {
  try {
    const remote = config.git.remote;
    let pushedSha = p.checked;
    let rewritten = false;
    if (attributionForbidden(config)) {
      const remoteBase = `${remote}/${p.base}`;
      const base = git(p.worktree, ['rev-parse', '--verify', '--quiet', remoteBase], { allowFail: true }).ok ? remoteBase : p.base;
      const scrub = scrubBranch(p.worktree, base, p.checked, historyEnv());
      if (scrub.rewritten) {
        rewritten = true;
        pushedSha = scrub.sha;
        logEvent(root, job.id, 'attribution-scrubbed', { repo: p.repo, rewritten: scrub.rewritten, commits: scrub.commits });
      }
    }
    pushBranch({ ...job, worktree: p.worktree }, config, pushedSha, { force: rewritten });
    const existing = memberPrByBranch(github, p.worktree, p.slug, job.branch!, 'open');
    const at = now();
    if (existing) {
      const number = existing.number;
      if (number === null) throw new ForgeError(`gh returned an unusable PR number for ${p.slug}`);
      const url = existing.url;
      recordMemberPr(root, job.id, p.repo, (prev) => ({ ...(prev ?? {}), number, url, state: 'OPEN', isDraft: existing.isDraft, openedAt: prev?.openedAt ?? at, lastSyncedAt: at, pushedSha }));
      logEvent(root, job.id, 'repo-pr-updated', { repo: p.repo, number });
      return { repo: p.repo, number, url, created: false };
    }
    const bodyFile = path.join(jobDir(root, job.id), `pr-body-${p.repo}.md`);
    fs.writeFileSync(bodyFile, p.body);
    const isDraft = Boolean(draft ?? config.pr.draft);
    const { number, url } = github.create(p.worktree, { slug: p.slug, base: p.base, head: job.branch!, title, bodyFile, draft: isDraft, labels: config.pr.labels ?? [], reviewers: config.pr.reviewers ?? [] });
    if (number === null) throw new ForgeError(`gh pr create printed no PR url for ${p.slug}`);
    recordMemberPr(root, job.id, p.repo, () => ({ number, url, state: 'OPEN', isDraft, openedAt: at, lastSyncedAt: at, pushedSha }));
    logEvent(root, job.id, 'repo-pr-opened', { repo: p.repo, number });
    return { repo: p.repo, number, url, created: true };
  } catch (e) {
    const err = e as ForgeError;
    throw new ForgeError(`repo ${p.repo}: ${err.message}`, err.code ?? 'failed', err.hint ?? null);
  }
}

export function recordMemberPr(root: string, id: string, repo: string, make: (prev: JobRepoPr | null) => JobRepoPr): void {
  updateJob(root, id, (j) => {
    const e = memberEntry(j, repo);
    if (e) e.pr = make(e.pr);
  });
}

/**
 * The member PR on `branch` in `slug`, same repo only: a PR from a fork on a branch of the same name
 * (or one not marked same-repo) is refused, never adopted.
 */
function memberPrByBranch(github: GitHub, cwd: string, slug: string, branch: string, which: 'open' | 'any'): PrSnapshot | null {
  const list = github.list(cwd, slug, branch, which === 'open' ? 'open' : 'all');
  const cross = list.find((x) => x.isCrossRepository);
  if (cross) throw new ForgeError(`PR #${cross.number ?? '?'} on ${branch} in ${slug} comes from a fork; Forge only uses branches in ${slug}`);
  return list.find((x) => x.state === 'OPEN') ?? (which === 'any' ? (list[0] ?? null) : null);
}

/**
 * Writes the sibling line into every OPEN PR of a linked job whose last write (or skip) recorded a
 * different line. Each PR's live body is read and only the section between the markers changes. A
 * PR not on the job's branch and base is never edited. A failure logs `pr-links-failed` and moves
 * on: links never fail `pr open` or `sync`.
 */
function linkSiblingPrs(root: string, config: Config, github: GitHub, id: string): void {
  const job = loadJob(root, id);
  if (!isLinkedJob(job)) return;
  const { order, cycle } = jobRepoOrder(config, job);
  const prs: { repo: RepoKey; slug: string; number: number; state: string | undefined }[] = [];
  for (const key of order) {
    let slug: string;
    try {
      slug = key === null ? github.repoSlug(root, config) : memberSlug(config, key);
    } catch {
      continue;
    }
    const pr = key === null ? job.pr : memberEntry(job, key)?.pr;
    const number = safePrNumber(pr?.number);
    if (number !== null) prs.push({ repo: key, slug, number, state: pr?.state });
  }
  const line = siblingLine(job.id, prs, cycle !== null);
  if (line === null) return;
  // A 'changed' skip is retried: the body moved under us, not the markers.
  const events = readEvents(root, id).filter((e) => e.type === 'pr-links-updated' || (e.type === 'pr-links-skipped' && e.reason !== 'changed'));
  for (const p of prs) {
    if (p.state !== 'OPEN' || !SLUG_RE.test(p.slug)) continue;
    const repo = p.repo === null ? {} : { repo: p.repo };
    const last = events.findLast((e) => (e.repo ?? null) === p.repo && e.number === p.number);
    if (last?.line === line) continue;
    try {
      const base = p.repo === null ? job.base : (memberEntry(job, p.repo)?.base ?? null);
      const read = (): string => {
        const view = github.viewBody(root, p.slug, p.number);
        assertJobPr(view, job.branch, base, `PR #${p.number} in ${p.slug}`);
        if (view.body === null) throw new ForgeError('gh returned no body');
        return view.body;
      };
      const body = read();
      const next = spliceSiblings(body, line);
      if (next === null) {
        logEvent(root, id, 'pr-links-skipped', { ...repo, number: p.number, line, reason: 'markers' });
        continue;
      }
      if (next !== body) {
        const file = path.join(jobDir(root, id), p.repo === null ? 'pr-links.md' : `pr-links-${p.repo}.md`);
        fs.writeFileSync(file, next);
        // gh has no compare-and-swap edit, so re-read right before writing: a body someone changed
        // since the first read is left alone (this narrows the race to the gap between two calls).
        if (read() !== body) {
          logEvent(root, id, 'pr-links-skipped', { ...repo, number: p.number, line, reason: 'changed' });
          continue;
        }
        github.editBody(root, p.slug, p.number, file);
      }
      logEvent(root, id, 'pr-links-updated', { ...repo, number: p.number, line });
    } catch {
      logEvent(root, id, 'pr-links-failed', { ...repo, number: p.number });
    }
  }
}

/**
 * linkSiblingPrs that cannot throw, even on a job it cannot load: links never fail `pr open` or
 * `sync`, so an error is logged as `pr-links-failed` (no number) and swallowed.
 */
export function linkSiblingsQuietly(root: string, config: Config, github: GitHub, id: string): void {
  try {
    linkSiblingPrs(root, config, github, id);
  } catch (e) {
    try {
      logEvent(root, id, 'pr-links-failed', { error: safeText(e instanceof Error ? e.message : String(e), 200) });
    } catch {
      // The job dir itself is unusable, so there is nowhere to log; the caller still must not fail.
    }
  }
}

/** One member PR as this call's sync read it: state null when its sync failed or found no PR. */
export interface MemberSync {
  repo: string;
  number: number | null;
  state: PrStateKey;
  /** The PR turned CLOSED in this sync. */
  newlyClosed: boolean;
  headOid: string | null;
  checks: PrChecks['state'] | undefined;
  mergeState: string | null;
}

/**
 * Records each member PR's state: by its number, or found by branch when none is recorded yet. The
 * adapter's snapshot holds checked values only (a safe number, an https url, a sha); a failure logs
 * `repo-pr-sync-failed` and never stops the root sync. Returns what this call read, so the job's
 * transition and a merge decide on GitHub's answers now, never on a stored (writable) state.
 */
export function syncMemberPrs(root: string, config: Config, github: GitHub, id: string): Map<string, MemberSync> {
  const job = loadJob(root, id);
  const out = new Map<string, MemberSync>();
  for (const m of memberRepos(job).filter((x) => !x.verifyOnly)) {
    const unread: MemberSync = { repo: m.repo, number: safePrNumber(m.pr?.number), state: null, newlyClosed: false, headOid: null, checks: undefined, mergeState: null };
    out.set(m.repo, unread);
    try {
      const slug = memberSlug(config, m.repo);
      let number = m.pr?.number ?? null;
      if (!number) {
        const found = memberPrByBranch(github, root, slug, job.branch!, 'any');
        if (!found) continue;
        number = found.number;
        if (number === null) throw new ForgeError('unusable PR number');
      }
      const pr = github.view(root, slug, number);
      if (pr.isCrossRepository) throw new ForgeError(`PR #${number} in ${slug} comes from a fork`);
      assertJobPr(pr, job.branch, m.base, `PR #${number} in ${slug}`);
      const fresh = {
        // Null when gh returns an unusable number: cleanRepoPr then drops this record on the next
        // load, and the next sync finds the PR by branch again.
        number: pr.number,
        url: pr.url,
        state: pr.state ?? m.pr?.state ?? 'OPEN',
        isDraft: pr.isDraft,
        headOid: pr.headOid,
        mergeable: pr.mergeable ?? undefined,
        mergeState: pr.mergeState ?? undefined,
        checks: pr.checks,
        mergedAt: pr.mergedAt,
        lastSyncedAt: now(),
      };
      recordMemberPr(root, id, m.repo, (prev) => ({ ...(prev ?? {}), ...fresh }) as JobRepoPr);
      logEvent(root, id, 'repo-pr-synced', { repo: m.repo, state: fresh.state });
      // Only a state GitHub named counts: a fallback to the stored one is not this call's answer.
      const state: PrStateKey = fresh.number !== null ? pr.state : null;
      const newlyClosed = state === 'CLOSED' && m.pr?.state !== 'CLOSED';
      if (newlyClosed) logEvent(root, id, 'repo-pr-closed', { repo: m.repo, number: fresh.number });
      out.set(m.repo, { repo: m.repo, number: fresh.number, state, newlyClosed, headOid: fresh.headOid, checks: fresh.checks.state, mergeState: fresh.mergeState ?? null });
    } catch {
      logEvent(root, id, 'repo-pr-sync-failed', { repo: m.repo });
    }
  }
  return out;
}
