// Config-time validation of the glob lists and the protected-paths policy, and the matcher that
// applies it. Imports only leaf modules (glob.ts, shape.ts, util.ts), so config.ts can use it without a cycle.
import path from 'node:path';
import { inSpec } from '../../glob.ts';
import type { Config, ProtectedRule } from '../../types.ts';
import { isMap } from '../../shape.ts';
import { ForgeError } from '../../errors.ts';

const REASON_MAX = 200;

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
export function policyProblems(c: unknown): string[] {
  const cfg: Record<string, any> = isMap(c) ? c : {};
  const pol = cfg.policy;
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

/** A rule that matched a path: `rule` is 1-based, `glob` is the configured glob that matched. */
export interface PolicyMatch {
  rule: number;
  glob: string;
  action: ProtectedRule['action'];
  reason: string;
}

/** The rules to enforce. An invalid policy fails closed: every gate refuses until a human fixes it. */
export function policyRules(config: Config): ProtectedRule[] {
  const problems = policyProblems(config);
  if (problems.length) throw new ForgeError(`invalid policy in .forge/config.yml, so Forge refuses to check protected paths: ${problems.join('; ')}`, 'config_invalid');
  return (config.policy?.protectedPaths ?? []) as ProtectedRule[];
}

/** refuse beats escalate; within one action the lowest rule number wins. */
export function betterMatch(a: PolicyMatch | null, b: PolicyMatch | null): PolicyMatch | null {
  if (!a || !b) return a ?? b;
  if (a.action !== b.action) return a.action === 'refuse' ? a : b;
  return a.rule <= b.rule ? a : b;
}

export function matchWith(rules: ProtectedRule[], test: (glob: string) => boolean): PolicyMatch | null {
  let best: PolicyMatch | null = null;
  rules.forEach((r, i) => {
    for (const glob of r.paths) {
      if (!test(glob.toLowerCase())) continue;
      best = betterMatch(best, { rule: i + 1, glob, action: r.action, reason: r.reason });
      break;
    }
  });
  return best;
}

/** The rule a path falls under, or null. Case-insensitive, so `.GitHub/Workflows/x.yml` still counts. */
export function matchPolicy(file: string, rules: ProtectedRule[]): PolicyMatch | null {
  const p = file.toLowerCase();
  return matchWith(rules, (g) => inSpec(p, [g]));
}
