// `forge job list|show|get|progress|paths|links|scope|panel|acs|findings|audit`: the read-only views of one job, or of every job.
import { jobAcs } from '#engine/pipeline/acs.ts';
import { jobFindings } from '#engine/pipeline/findings.ts';
import { jobPathMap } from '#engine/pipeline/brief.ts';
import { foremanHandoffFor } from '#office/foreman.ts';
import { ensureReviewDir, isActive, listJobs, loadJob, progress } from '#core/job/store.ts';
import { resolveLinks } from '#engine/project/links.ts';
import { jobPanel } from '#engine/pipeline/panel.ts';
import { jobScope } from '#engine/pipeline/scope.ts';
import { getPath } from '#core/shape.ts';
import { jobAudit, toCsv } from '#engine/ops/audit.ts';
import { lastRun } from '#engine/verify/record.ts';
import type { Config, Job } from '#core/types.ts';
import { req, requireJob, usageError } from '../args.ts';
import { JOB } from './help.ts';

export function listCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const jobs = listJobs(root).filter((j) => (flags.all ? true : isActive(j)));
  return jobs.map((j) => ({ id: j.id, title: j.title, stage: j.stage, state: j.state, waitingOn: j.waitingOn, round: j.round, pr: j.pr?.number ?? null, owner: j.lease.driver, effort: j.effort }));
}

export function show(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const job = loadJob(root, req(id, 'job id'));
  return flags.full ? job : compactJob(root, job);
}

export function get(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return getPath(loadJob(root, req(id, 'job id')), rest[1] ?? '') ?? null;
}

export function audit(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  if (flags.json && flags.csv) throw usageError(JOB, 'audit');
  // jobAudit reads an archived job's record once its job dir is gone.
  const a = jobAudit(root, req(id, 'job id'));
  return flags.csv ? toCsv(a.rows, () => a.pr) : a;
}

export function progressCmd(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return progress(root, requireJob(root, id).id);
}

export function paths(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return jobPaths(root, config, loadJob(root, req(id, 'job id')));
}

export function links(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const job = requireJob(root, id);
  return { id: job.id, links: resolveLinks(root, config, job) };
}

export function scope(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return jobScope(root, config, req(id, 'job id'));
}

export function panel(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return jobPanel(root, config, req(id, 'job id'));
}

export function acs(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  return jobAcs(root, req(id, 'job id'));
}

export function findings(root: string, config: Config, rest: string[], flags: Record<string, any>) {
  const id = rest[0];
  const jobId = requireJob(root, id).id;
  return { id: jobId, ...jobFindings(root, jobId) };
}

/**
 * Absolute paths an agent prompt needs, so the orchestrator can hand them over verbatim.
 * The review directories are created here, before any reviewer is briefed with them.
 */
export function jobPaths(root: string, config: Config, job: Job): Record<string, unknown> {
  ensureReviewDir(root, job.id, Math.max(job.round, 1));
  ensureReviewDir(root, job.id, 'integration');
  return jobPathMap(root, config, job);
}

/** The job as `forge job show` prints it without --full. */
export function compactJob(root: string, job: Job): Record<string, unknown> {
  // This round's last run: null at the start of a round, until verify runs.
  const lastVerify = lastRun(job) ?? null;
  return {
    id: job.id,
    title: job.title,
    kind: job.kind,
    stage: job.stage,
    state: job.state,
    waitingOn: job.waitingOn,
    reason: job.reason,
    foremanHandoff: foremanHandoffFor(root, job),
    round: job.round,
    maxRounds: job.maxRounds,
    reviewers: job.reviewers,
    lastVerdicts: job.verdicts[job.round] ?? null,
    verify: job.verify[job.round] ?? null,
    verified: lastVerify ? { round: lastVerify.round, attempt: lastVerify.attempt, ok: lastVerify.ok, sha: lastVerify.sha } : null,
    decision: job.decision,
    branch: job.branch,
    base: job.base,
    worktree: job.worktree,
    port: job.port,
    ports: job.ports,
    pr: job.pr ? { number: job.pr.number, url: job.pr.url, state: job.pr.state, checks: job.pr.checks?.state, behindBy: job.pr.behindBy, conflicts: job.pr.conflicts, unresolvedThreads: job.pr.unresolvedThreads } : null,
    issues: job.issues,
    noIssue: job.noIssue,
    effort: job.effort,
    owner: job.lease.driver,
    progress: progress(root, job.id),
    tokens: job.usage.totalTokens,
    estCostUsd: job.usage.estCostUsd,
  };
}
