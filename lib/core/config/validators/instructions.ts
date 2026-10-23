// project.instructions: the files each agent reads first. Validation and resolution in one module,
// as models.ts holds both for runtime.models, so a brief can only ever carry an entry the validator
// accepts. A plain list is every role's; a map has `default` plus role lists that replace it.
import { isInsidePath } from '../../os/fs.ts';
import { isMap, show } from '../../shape.ts';
import { matchPolicy } from './policy-check.ts';
import type { Config, ProtectedRule } from '../types.ts';

/** The roles whose briefs renderBrief writes; `reviewer` covers every lens. */
export const INSTRUCTION_ROLES = ['planner', 'spec-writer', 'designer', 'builder', 'reviewer', 'approver', 'integrator', 'verifier', 'judge'] as const;

const KEYS: readonly string[] = ['default', ...INSTRUCTION_ROLES];

const hasDotDot = (f: string): boolean => f.split(/[/\\]/).includes('..');

/** Why one list entry is unusable, or null. A config typo must not point a brief outside the worktree. */
function entryProblem(f: unknown): string | null {
  if (typeof f !== 'string' || !f.trim()) return `must be a non-empty string (got ${show(f)})`;
  if (isInsidePath(f)) return null;
  return hasDotDot(f) ? `must not contain a .. segment (got ${show(f)})` : `must be a path relative to the repo root, not absolute (got ${show(f)})`;
}

/**
 * The instruction files for `role` (`reviewer:<lens>` resolves as `reviewer`; none means the
 * default list): the role's own list when the map names it, else `default`, else none. Entries
 * entryProblem refuses are dropped.
 */
export function instructionsFor(config: Pick<Config, 'project'>, role?: string): string[] {
  const v: unknown = config.project?.instructions;
  const base = role?.split(':')[0];
  let list: unknown = v;
  if (isMap(v)) list = base && KEYS.includes(base) && Object.hasOwn(v, base) && Array.isArray(v[base]) ? v[base] : v.default;
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((f): f is string => entryProblem(f) === null))];
}

function listProblems(at: string, list: unknown): string[] {
  if (!Array.isArray(list)) return [`${at} must be a list of files (got ${show(list)})`];
  return list.flatMap((f, i) => {
    const p = entryProblem(f);
    return p ? [`${at}[${i}] ${p}`] : [];
  });
}

/**
 * The files every Claude Code session reads whatever a brief says: folder maps and CLAUDE.md at any
 * depth, the project's settings, and its MCP servers. The bare `.claude` also covers a symlink of that name.
 */
export const INSTRUCTION_GLOBS = ['**/AGENTS.md', '**/CLAUDE.md', '.claude', '.claude/**', '.mcp.json'] as const;

/** defaults()' last `policy.protectedPaths` rule: a branch that changes an instruction file needs a human. */
export const INSTRUCTIONS_RULE: ProtectedRule = {
  paths: [...INSTRUCTION_GLOBS],
  action: 'escalate',
  reason: 'agent instructions and Claude Code settings: every session reads them',
};

/**
 * The changed paths that are instruction files: INSTRUCTION_GLOBS, or any role's
 * `project.instructions` entry, matched case-insensitively as the policy is. Sorted and unique.
 */
export function changedInstructionFiles(config: Pick<Config, 'project'>, changed: readonly string[]): string[] {
  const configured = [...new Set([undefined, ...INSTRUCTION_ROLES].flatMap((r) => instructionsFor(config, r)).map((f) => f.replaceAll('\\', '/')))];
  const rules: ProtectedRule[] = [INSTRUCTIONS_RULE, ...(configured.length ? [{ paths: configured, action: 'escalate' as const, reason: 'project.instructions' }] : [])];
  const hits = changed.map((f) => f.replaceAll('\\', '/')).filter((f) => matchPolicy(f, rules) !== null);
  return [...new Set(hits)].sort();
}

/** The paths `forge doctor` checks a configured policy against: one per INSTRUCTION_GLOBS shape. */
export const INSTRUCTION_PROBES = ['AGENTS.md', 'lib/AGENTS.md', 'CLAUDE.md', '.claude/settings.json', '.mcp.json'] as const;

/** The probes no rule in `rules` matches. */
export function uncoveredInstructionProbes(rules: ProtectedRule[]): string[] {
  return INSTRUCTION_PROBES.filter((p) => matchPolicy(p, rules) === null);
}

/** Every problem with `project.instructions`, in the form validateConfig reports. */
export function instructionsProblems(c: unknown): string[] {
  const project = isMap(c) && isMap(c.project) ? c.project : {};
  const v: unknown = project.instructions;
  if (v === undefined) return [];
  if (Array.isArray(v)) return listProblems('project.instructions', v);
  if (!isMap(v)) return [`project.instructions must be a list of files or a map of role lists (got ${show(v)})`];
  return Object.entries(v).flatMap(([k, list]) =>
    KEYS.includes(k) ? listProblems(`project.instructions.${k}`, list) : [`project.instructions.${k} is not a role: use ${KEYS.join(', ')}`],
  );
}
