// The verify record: the one reader of `job.verifyRuns`, answering this round's run, whether a HEAD
// is verified, and the next attempt.
// job.json is agent-writable, so every field is checked before it counts as evidence: a malformed run
// reads as no evidence, and nothing here throws on a hostile shape. No git and no fs.
import { memberRepos } from '../project/job-repos.ts';
import type { Job, VerifyRun } from '#core/types.ts';

type RecordJob = Pick<Job, 'round' | 'verifyRuns'>;

/** Every run of the record, in order: a non-array record holds none, and a non-object entry is skipped. */
function allRuns(job: Pick<Job, 'verifyRuns'>): VerifyRun[] {
  const runs: unknown = job.verifyRuns;
  return Array.isArray(runs) ? runs.filter((r): r is VerifyRun => Boolean(r) && typeof r === 'object') : [];
}

/** This round's runs, in order. A round that is not a number has none. */
export function roundRuns(job: RecordJob, round: number = job.round): VerifyRun[] {
  if (typeof round !== 'number') return [];
  return allRuns(job).filter((r) => r.round === round);
}

/** This round's last run: the job's latest verify. An earlier round's run never answers for this one. */
export function lastRun(job: RecordJob): VerifyRun | undefined {
  return roundRuns(job).at(-1);
}

/** This round's last run that `forge verify` wrote a report for (a verifiers CHANGES run has its own file). */
export function reportRun(job: RecordJob): VerifyRun | undefined {
  return roundRuns(job)
    .filter((r) => r.failure !== 'verifiers')
    .at(-1);
}

/** The attempt number the next run of this round records. */
export function nextAttempt(job: RecordJob): number {
  return roundRuns(job).length + 1;
}

/** The runs whose `at` is later than `ts` (ISO timestamps order as strings), or every run with an `at` when `ts` is unset. */
export function runsSince(job: Pick<Job, 'verifyRuns'>, ts: string | null | undefined): VerifyRun[] {
  return allRuns(job).filter((r) => typeof r.at === 'string' && r.at !== '' && (!ts || r.at > ts));
}

/**
 * Whether the very first verify attempt of round 1 passed, or null when the job never got there.
 * Later attempts in the same round are retries and must not count as a first pass.
 */
export function firstVerifyRun(job: Pick<Job, 'verifyRuns' | 'verify'>): boolean | null {
  const first = allRuns(job).find((r) => r.round === 1 && r.attempt === 1);
  if (first) return Boolean(first.ok);
  return job.verify?.[1] ? job.verify[1] === 'PASS' : null;
}

/** The sha this round's last run passed on: the root's (`repo` null) or a member's; null when it did not pass or recorded none. */
export function verifiedSha(job: RecordJob, repo: string | null): string | null {
  const last = lastRun(job);
  if (!last || last.ok !== true) return null;
  let sha: unknown = last.sha;
  if (repo !== null) {
    const repos: unknown = last.repos;
    const rec: unknown = Array.isArray(repos) ? repos.find((r) => Boolean(r) && typeof r === 'object' && (r as { repo?: unknown }).repo === repo) : undefined;
    sha = rec ? (rec as { sha?: unknown }).sha : null;
  }
  return typeof sha === 'string' && sha !== '' ? sha : null;
}

/**
 * Whether this round's last run passed on the root HEAD and on every member HEAD. The members come
 * from the job, not from `heads`, so a member the caller left out (or could not read: null) is not verified.
 */
export function headVerified(job: RecordJob & Pick<Job, 'repos'>, heads: { root: string; repos?: Record<string, string | null> }): { last: VerifyRun | null; verified: boolean } {
  const last = lastRun(job) ?? null;
  const root = verifiedSha(job, null);
  let verified = root !== null && root === heads.root;
  for (const m of memberRepos(job)) {
    const head: unknown = heads.repos && Object.hasOwn(heads.repos, m.repo) ? heads.repos[m.repo] : null;
    if (typeof head !== 'string' || head !== verifiedSha(job, m.repo)) verified = false;
  }
  return { last, verified };
}

/**
 * Appends a run, inside updateJob: the legacy per-round result follows it, and a failure (a dirty
 * worktree or a verifiers CHANGES included) asks for one more retry; a pass does not reset the count.
 */
export function recordRun(job: Job, run: VerifyRun): void {
  if (!Array.isArray(job.verifyRuns)) job.verifyRuns = [];
  if (!job.verify || typeof job.verify !== 'object') job.verify = {};
  if (!job.verifyRetries || typeof job.verifyRetries !== 'object') job.verifyRetries = {};
  job.verify[run.round] = run.ok ? 'PASS' : 'FAIL';
  job.verifyRuns.push(run);
  if (!run.ok) job.verifyRetries[String(run.round)] = (job.verifyRetries[String(run.round)] ?? 0) + 1;
}
