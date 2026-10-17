// The drawer's Repos table and the card's member PR chips, for a job with member repos
// (job.repos: the root repo first, then members). Plain TS so test/dashboard-repos.test.ts can import it.
import { safeUrl } from './markdown.ts';
import type { Job, JobRepoPr } from './types.ts';

/** One row of the drawer's Repos table. Every string is job.json text: render it as text. */
export interface RepoRow {
  /** The member's name, or the root repo's name from /api/state. */
  name: string;
  root: boolean;
  /** The job's branch; null for a verify-only member. */
  branch: string | null;
  verifyOnly: boolean;
  base: string | null;
  worktree: string | null;
  pr: Partial<JobRepoPr> | null;
  prNumber: number | null;
  /** The PR link, or null for anything but http(s) or a relative path. */
  prUrl: string | null;
}

/** The rows for a job with members, root first; [] for a single-repo job (the drawer shows no table). */
export function jobRepoRows(job: Partial<Job>, rootName: string): RepoRow[] {
  const repos = Array.isArray(job.repos) ? job.repos : [];
  if (repos.length < 2) return [];
  return repos.map((r, i) => {
    const pr = r?.pr ?? null;
    const prNumber = typeof pr?.number === 'number' && Number.isSafeInteger(pr.number) && pr.number > 0 ? pr.number : null;
    return {
      name: i === 0 ? rootName : String(r?.repo ?? ''),
      root: i === 0,
      branch: r?.verifyOnly ? null : (r?.branch ?? null),
      verifyOnly: r?.verifyOnly === true,
      base: r?.base ?? null,
      worktree: r?.worktree ?? null,
      pr,
      prNumber,
      prUrl: prNumber === null ? null : safeUrl(pr?.url),
    };
  });
}

/** The member PRs a job card shows after the root PR chip: name and PR, members with a PR only. */
export function memberPrs(job: Partial<Job>): { repo: string; pr: Partial<JobRepoPr> }[] {
  const repos = Array.isArray(job.repos) ? job.repos.slice(1) : [];
  return repos.filter((r) => typeof r?.repo === 'string' && r.pr?.number).map((r) => ({ repo: r.repo as string, pr: r.pr as Partial<JobRepoPr> }));
}
