// Adopting a PR that already exists for a job's work: same repository, safe ref names, trusted
// closing PRs only.
import { loadJob, logEvent, setJob } from '#core/job/store.ts';
import { linkedIssues, nativeRef } from '#core/job/issue-ref.ts';
import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { SAFE_REF } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { TRUSTED_ASSOCIATIONS, closingPrs, listPrs, repoSlug, requireGh, viewPr } from '#integrations/github/pull-requests.ts';

/**
 * A job may arrive for work that already has a PR (a long-running feature, a second session,
 * a human-started branch). Finding it first means the job continues that PR instead of forking it.
 * Returns gh's PR JSON (raw input), or null.
 */
export function findPr(root: string, config: Config, id: string): any {
  requireGh();
  const job = loadJob(root, id);
  const slug = repoSlug(root, config);
  if (job.pr?.number) return refuseUnsafeRefs(root, id, viewPr(root, slug, job.pr.number));
  // createJob always sets branch.
  const byBranch = listPrs(root, slug, job.branch!, 'all');
  const sameRepo = byBranch.filter((p: any) => !p.isCrossRepository);
  let pr = sameRepo.find((p: any) => p.state === 'OPEN') ?? sameRepo[0] ?? null;
  // The primary issue of this repo: a foreign issue's closing PRs live in a repo Forge doesn't adopt from.
  const issueNum = linkedIssues(job)
    .map((i) => nativeRef(i, 'github', slug))
    .find((r) => r !== null && /^\d+$/.test(r));
  if (!pr && issueNum) {
    const nodes = closingPrs(root, slug, Number(issueNum)).filter(
      (n: any) => !n.isCrossRepository && TRUSTED_ASSOCIATIONS.has(n.authorAssociation),
    );
    const linked = nodes.find((n: any) => n.state === 'OPEN') ?? nodes[0];
    if (linked) pr = viewPr(root, slug, linked.number);
  }
  if (!pr) {
    // Recorded so `forge job step` knows the lookup ran and moves past Intake.
    logEvent(root, id, 'pr-find', { found: false });
    return null;
  }
  if (pr.isCrossRepository) throw new ForgeError(`PR #${pr.number} comes from a fork; Forge only adopts branches in ${slug}`);
  refuseUnsafeRefs(root, id, pr);
  const owned = { pr: { number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft, lastSyncedAt: now() } };
  if (pr.headRefName && pr.headRefName !== job.branch) Object.assign(owned, { branch: pr.headRefName });
  if (pr.baseRefName && pr.baseRefName !== job.base) Object.assign(owned, { base: pr.baseRefName });
  setJob(root, id, { owned });
  logEvent(root, id, 'pr-adopted', { number: pr.number, branch: pr.headRefName });
  return pr;
}

// A ref name becomes job.branch/base, which fill shell templates and git argv. Only the field
// name is logged: the value is outside text.
function refuseUnsafeRefs(root: string, id: string, pr: any): any {
  for (const field of ['headRefName', 'baseRefName'] as const) {
    const v = pr?.[field];
    if (v && !(typeof v === 'string' && SAFE_REF.test(v))) {
      logEvent(root, id, 'pr-adopt-refused', { number: Number(pr.number), field });
      throw new ForgeError(`PR #${Number(pr.number)} has an unsafe ${field} ${(JSON.stringify(v) ?? String(v)).slice(0, 80)}; Forge does not adopt it`);
    }
  }
  return pr;
}
