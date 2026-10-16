// Config-time validation of the glob lists and the protected-paths policy. A leaf module (imports
// nothing from lib/) so config.ts can use it without a cycle through protected.ts, jobs.ts and friends.
import path from 'node:path';

const REASON_MAX = 200;
const isMap = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Why a `worktrees.generated` entry can't be used, or null. The entries become git pathspecs and
 * file-system paths mid-merge, so anything that could read as an option, pathspec magic (`:`),
 * an exclusion (`!`) or a way out of the worktree is refused.
 */
export function globProblem(g: unknown, key = 'worktrees.generated'): string | null {
  if (typeof g !== 'string' || !g.trim()) return `${key} entries must be non-empty strings (got ${JSON.stringify(g)})`;
  if (g.startsWith('/') || path.isAbsolute(g)) return `${key} entry ${JSON.stringify(g)} must be relative to the repo`;
  if (/^[-!:]/.test(g)) return `${key} entry ${JSON.stringify(g)} must not start with -, ! or :`;
  if (g.split(/[\\/]/).includes('..')) return `${key} entry ${JSON.stringify(g)} must not contain a .. segment`;
  return null;
}

/** Every problem with `policy`, for validateConfig; an empty list means the policy is usable. */
export function policyProblems(c: any): string[] {
  const pol = c?.policy;
  if (pol === undefined) return [];
  if (!isMap(pol)) return [`policy must be a map (got ${JSON.stringify(pol)})`];
  const list = pol.protectedPaths;
  if (!Array.isArray(list)) return [`policy.protectedPaths must be a list of rules (got ${JSON.stringify(list)})`];
  const problems: string[] = [];
  list.forEach((r: unknown, i) => {
    const key = `policy.protectedPaths rule ${i + 1}`;
    if (!isMap(r)) return problems.push(`${key} must be a map with paths, action and reason (got ${JSON.stringify(r)})`);
    if (!Array.isArray(r.paths) || !r.paths.length) problems.push(`${key}: paths must be a non-empty list of globs (got ${JSON.stringify(r.paths)})`);
    else for (const g of r.paths) {
      const p = globProblem(g, `${key}: paths`);
      if (p) problems.push(p);
    }
    if (r.action !== 'escalate' && r.action !== 'refuse') problems.push(`${key}: action must be one of escalate | refuse (got ${JSON.stringify(r.action)})`);
    if (typeof r.reason !== 'string' || !r.reason.length || r.reason.length > REASON_MAX || /[\r\n]/.test(r.reason))
      problems.push(`${key}: reason must be a string of 1 to ${REASON_MAX} characters with no newline (got ${JSON.stringify(r.reason)?.slice(0, 80)})`);
  });
  return problems;
}
