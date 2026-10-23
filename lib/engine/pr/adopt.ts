// Adopting a PR that already exists for a job's work: same repository, safe ref names, trusted
// closing PRs only.
import { loadJob, logEvent, setJob } from '#core/job/store.ts';
import { linkedIssues, nativeRef } from '#core/job/issue-ref.ts';
import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import type { GitHub, PrSnapshot } from '#integrations/github/types.ts';

/**
 * A job may arrive for work that already has a PR (a long-running feature, a second session,
 * a human-started branch). Finding it first means the job continues that PR instead of forking it.
 * Returns the PR's snapshot, or null.
 */
export function findPr(root: string, config: Config, github: GitHub, id: string): PrSnapshot | null {
  github.require();
  const job = loadJob(root, id);
  const slug = github.repoSlug(root, config);
  if (job.pr?.number) return refuseUnsafeRefs(root, id, github.view(root, slug, job.pr.number));
  // createJob always sets branch. The parser counts a PR not marked same-repo as a fork.
  const sameRepo = github.list(root, slug, job.branch!, 'all').filter((p) => !p.isCrossRepository && p.number !== null);
  let pr = sameRepo.find((p) => p.state === 'OPEN') ?? sameRepo[0] ?? null;
  // The primary issue of this repo: a foreign issue's closing PRs live in a repo Forge doesn't adopt from.
  const issueNum = linkedIssues(job)
    .map((i) => nativeRef(i, 'github', slug))
    .find((r) => r !== null && /^\d+$/.test(r));
  if (!pr && issueNum) {
    const nodes = github.closing(root, slug, Number(issueNum)).filter((n) => !n.isCrossRepository && n.trusted && n.number !== null);
    const linked = nodes.find((n) => n.state === 'OPEN') ?? nodes[0];
    if (linked?.number) pr = github.view(root, slug, linked.number);
  }
  if (!pr) {
    // Recorded so `forge job step` knows the lookup ran and moves past Intake.
    logEvent(root, id, 'pr-find', { found: false });
    return null;
  }
  if (pr.isCrossRepository) throw new ForgeError(`PR #${pr.number ?? '?'} comes from a fork; Forge only adopts branches in ${slug}`);
  if (pr.number === null) throw new ForgeError(`gh returned an unusable PR number for ${slug}`, 'external');
  refuseUnsafeRefs(root, id, pr);
  const owned = { pr: { number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft, lastSyncedAt: now() } };
  if (pr.headRefName !== job.branch) Object.assign(owned, { branch: pr.headRefName });
  if (pr.baseRefName !== job.base) Object.assign(owned, { base: pr.baseRefName });
  setJob(root, id, { owned });
  logEvent(root, id, 'pr-adopted', { number: pr.number, branch: pr.headRefName });
  return pr;
}

// A ref name becomes job.branch/base, which fill shell templates and git argv. parsePr nulled any
// ref that fails SAFE_REF, and a missing one is refused too: only the field name is logged.
function refuseUnsafeRefs(root: string, id: string, pr: PrSnapshot): PrSnapshot {
  for (const field of ['headRefName', 'baseRefName'] as const) {
    if (pr[field] === null) {
      logEvent(root, id, 'pr-adopt-refused', { number: pr.number, field });
      throw new ForgeError(`PR #${pr.number ?? '?'} has an unsafe ${field}; Forge does not adopt it`);
    }
  }
  return pr;
}
