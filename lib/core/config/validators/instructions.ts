// project.instructions: the files each agent reads first. Validation and resolution in one module,
// as models.ts holds both for runtime.models, so a brief can only ever carry an entry the validator
// accepts. A plain list is every role's; a map has `default` plus role lists that replace it.
import { isInsidePath } from '../../os/fs.ts';
import { isMap, show } from '../../shape.ts';
import type { Config } from '../types.ts';

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
