// `forge job round|verdicts|decision|score`: review rounds, the reviewers' and approver's verdicts, and the post-merge score.
import { enforceBudget } from '#engine/metrics/budget.ts';
import { ensureReviewDir, loadJob, logEvent, parseDecision, readEvents, roundVerdicts, setJob, updateJob } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import { isMap } from '#core/shape.ts';
import { memberRepos, trustedMemberWorktree } from '#engine/project/job-repos.ts';
import { isLens, lensRepoAllowed, reviewedRepoNames } from '#core/job/lens.ts';
import { recordScore } from '#engine/evals/scoring.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { pullPrHead } from '#engine/pr/branch.ts';
import { FULL_SHA, lastDecision } from '#engine/pr/eligible.ts';
import { after } from '#engine/pipeline/step/facts.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config } from '#core/types.ts';
import { list, req, requireJob, usageError } from '../args.ts';
import { JOB } from './help.ts';

export function round(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  // Checked before incrementing, so after approval re-running `forge job round` starts the round.
  const budget = enforceBudget(root, config, req(id, 'job id'), 'round');
  if (budget) {
    const j = loadJob(root, String(id));
    return { round: j.round, maxRounds: j.maxRounds, exhausted: j.round > j.maxRounds, budget };
  }
  const job = updateJob(root, String(id), (j) => {
    j.round += 1;
  });
  ensureReviewDir(root, job.id, job.round);
  logEvent(root, job.id, 'round', { round: job.round });
  // A rework round on an open PR starts from the PR's head, whoever moved it.
  const pull = job.round > 1 ? pullPrHead(root, config, job) : null;
  return { round: job.round, maxRounds: job.maxRounds, exhausted: job.round > job.maxRounds, ...(pull && pull.pulled !== 'none' ? { pulled: pull.pulled } : {}) };
}

export function verdicts(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const job = loadJob(root, req(id, 'job id'));
  // The integration review is a mini round after conflict resolution; it is logged as an
  // event only, because stats, retro and the dashboard read job.verdicts keys as numbers.
  const integration = flags.round === 'integration';
  if (flags.round !== undefined && !integration && !/^[1-9]\d*$/.test(String(flags.round))) throw new ForgeError('--round must be a positive integer or "integration"', 'usage');
  const round: number | 'integration' = integration ? 'integration' : Number(flags.round ?? job.round);
  // job.reviewers is settable with --field: a qualified lens counts only for a reviewed member of the job.
  const reviewers = list(flags.reviewers).length ? list(flags.reviewers) : integration ? ['code'] : job.reviewers.filter((l) => isLens(l) && lensRepoAllowed(job, l));
  if (!reviewers.length) throw new ForgeError(`job ${id} has no reviewers selected; set them with: forge job set ${id} --field reviewers='["code","tests"]'`);
  if (flags.malformed !== undefined && flags.malformed !== 'changes') throw new ForgeError('--malformed accepts only "changes"', 'usage');
  const v = roundVerdicts(root, job.id, round, reviewers, config.review.blockOn, { malformedAs: flags.malformed });
  // The sha reviewers saw is evidence; it tells a later reader whether the review is still current.
  const sha = job.worktree && exists(job.worktree) ? git(job.worktree, ['rev-parse', 'HEAD'], { allowFail: true }).stdout.trim() || null : null;
  // Each reviewed member's HEAD beside the root's sha; only Forge's own worktree path is trusted.
  const memberHeads = Object.fromEntries(
    reviewedRepoNames(job).map((name) => {
      const wt = trustedMemberWorktree(root, config, job, name);
      return [name, wt ? git(wt, ['rev-parse', 'HEAD'], { allowFail: true }).stdout.trim() || null : null];
    }),
  );
  const heads = Object.keys(memberHeads).length ? { heads: memberHeads } : {};
  if (v.complete) {
    const verdicts = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict]));
    const coerced = Object.entries(v.reviewers).filter(([, r]) => r.coerced).map(([k]) => k);
    if (integration) logEvent(root, job.id, 'integration-review', { outcome: v.outcome, sha, ...heads, reviewers: verdicts, coerced: coerced.length ? coerced : undefined });
    else {
      setJob(root, job.id, { fields: { [`verdicts.${round}`]: verdicts } });
      logEvent(root, job.id, 'verdicts', { round, outcome: v.outcome, sha, ...heads, coerced: coerced.length ? coerced : undefined });
    }
    if (coerced.length) logEvent(root, job.id, 'note', { text: `${integration ? 'integration review' : `round ${round}`}: malformed review(s) from ${coerced.join(', ')} counted as CHANGES` });
  }
  if (flags.compact) {
    // Absolute paths, so the orchestrator can hand a re-spawned reviewer its output verbatim.
    const missing = Object.fromEntries(Object.entries(v.reviewers).filter(([, r]) => r.verdict === 'MISSING').map(([k, r]) => [k, r.path]));
    const reviewers = Object.fromEntries(Object.entries(v.reviewers).map(([k, r]) => [k, r.verdict === 'CHANGES' ? `CHANGES(${r.blocking})` : r.verdict]));
    return { round, complete: v.complete, outcome: v.outcome, sha, ...heads, reviewers, ...(Object.keys(missing).length ? { missing } : {}) };
  }
  return { ...v, sha, ...heads };
}

/**
 * Records the approver's decision bound to the commits it saw: the worktree HEAD and each PR
 * member's. Once per approver run: a decision.md edited after the record changes nothing until the
 * approver runs again.
 */
export function decision(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const job = requireJob(root, id);
  const jobId = job.id;
  const events = readEvents(root, jobId);
  const last = events.findLast((e) => e.type === 'decision');
  if (last && after(last.ts, job.agents.approver?.endedAt)) {
    const r = lastDecision(events)!;
    return { decision: r.decision, reason: typeof last.reason === 'string' ? last.reason : null, autoMerge: r.autoMerge, head: r.head, ...(isMap(last.heads) ? { heads: r.heads } : {}), recorded: false };
  }
  const d = parseDecision(root, jobId);
  const headOf = (wt: string | null | undefined): string | null => {
    if (!wt || !exists(wt)) return null;
    const out = git(wt, ['rev-parse', '--verify', 'HEAD^{commit}'], { env: historyEnv(), allowFail: true }).stdout.trim();
    return FULL_SHA.test(out) ? out : null;
  };
  const members = memberRepos(job).filter((m) => !m.verifyOnly);
  const heads = members.length ? { heads: Object.fromEntries(members.map((m) => [m.repo, headOf(trustedMemberWorktree(root, config, job, m.repo))])) } : {};
  const record = { decision: d.decision, reason: d.reason, autoMerge: d.autoMerge, head: headOf(job.worktree), ...heads };
  if (!d.decision) return { ...record, recorded: false };
  setJob(root, jobId, { fields: { decision: d.decision } });
  logEvent(root, jobId, 'decision', record);
  return { ...record, recorded: true };
}

export function score(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  if (rest[0] !== 'record' || rest.length !== 2) throw usageError(JOB, 'score');
  return recordScore(root, rest[1]);
}
