// merge.requiredChecks: validation and the normalised entries, self-contained in core.
import { isMap, show } from '../../shape.ts';

/** One merge.requiredChecks entry as the merge gate reads it: a name and the source it is bound to (all null: any check run). */
export interface RequiredCheckEntry {
  name: string;
  app: string | null;
  workflow: string | null;
  creator: string | null;
}

const KEYS = new Set(['name', 'app', 'workflow', 'creator']);
const MAX_NAME = 100;
/** A top-level Actions workflow file, as GitHub reports `workflowRun.file.path`. */
export const WORKFLOW_PATH = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** A GitHub App slug. */
const APP_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** A GitHub login, a bot's with its `[bot]` suffix. */
const LOGIN = /^[A-Za-z0-9-]{1,39}(\[bot\])?$/;
/** C0 and C1 controls, and the Unicode line and paragraph separators. */
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function nameProblem(at: string, name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) return `${at} needs a non-empty name (got ${show(name, 60)})`;
  if (name.length > MAX_NAME) return `${at} name must be at most ${MAX_NAME} characters (got ${name.length})`;
  if (CONTROL.test(name)) return `${at} name must have no control characters (got ${show(name, 60)})`;
  return null;
}

/** One entry's problems; the duplicate check needs the whole list. */
function entryProblems(at: string, entry: unknown): string[] {
  if (typeof entry === 'string') {
    const p = nameProblem(at, entry);
    return p ? [p] : [];
  }
  if (!isMap(entry)) return [`${at} must be a check name or a {name, app, workflow, creator} map (got ${show(entry, 60)})`];
  const problems: string[] = [];
  const unknown = Object.keys(entry).filter((k) => !KEYS.has(k));
  if (unknown.length) problems.push(`${at} has unknown key ${show(unknown[0], 40)}; use name, app, workflow or creator`);
  if (entry.creator !== undefined && (entry.app !== undefined || entry.workflow !== undefined))
    problems.push(`${at} binds creator together with app or workflow; a commit status (creator) and a check run (app, workflow) are different sources`);
  if (entry.workflow !== undefined && (typeof entry.workflow !== 'string' || !WORKFLOW_PATH.test(entry.workflow)))
    problems.push(`${at}.workflow must be a file under .github/workflows/ ending in .yml or .yaml (got ${show(entry.workflow, 60)})`);
  if (entry.app !== undefined && (typeof entry.app !== 'string' || !APP_SLUG.test(entry.app)))
    problems.push(`${at}.app must be a GitHub App slug such as github-actions (got ${show(entry.app, 60)})`);
  if (entry.creator !== undefined && (typeof entry.creator !== 'string' || !LOGIN.test(entry.creator)))
    problems.push(`${at}.creator must be a GitHub login (got ${show(entry.creator, 60)})`);
  const p = nameProblem(at, entry.name);
  if (p) problems.push(p);
  return problems;
}

const nameOf = (entry: unknown): unknown => (isMap(entry) ? entry.name : entry);

/** merge.requiredChecks: shape problems for forge config validate and forge doctor. */
export function requiredChecksProblems(c: unknown): string[] {
  const merge = isMap(c) ? c.merge : undefined;
  const list = isMap(merge) ? merge.requiredChecks : undefined;
  if (list === undefined) return [];
  if (!Array.isArray(list)) return [`merge.requiredChecks must be a list of check names or {name, app, workflow, creator} maps (got ${show(list, 60)})`];
  const problems: string[] = [];
  const seen = new Set<unknown>();
  list.forEach((entry: unknown, i: number) => {
    const own = entryProblems(`merge.requiredChecks[${i}]`, entry);
    problems.push(...own);
    const name = nameOf(entry);
    if (own.length) return;
    if (seen.has(name)) problems.push(`merge.requiredChecks lists ${show(name, 60)} more than once`);
    seen.add(name);
  });
  return problems;
}

/**
 * The entries a valid list holds: a string becomes an unbound name. Tolerant: an entry
 * validation refuses (or a later duplicate) is skipped, never guessed at, and the rest are kept.
 * The merge gate checks requiredChecksProblems first and refuses a list with any, so it never reads a loosened list.
 */
export function normalizeRequiredChecks(list: unknown): RequiredCheckEntry[] {
  if (!Array.isArray(list)) return [];
  const out: RequiredCheckEntry[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (entryProblems('', entry).length) continue;
    const e = typeof entry === 'string' ? { name: entry } : (entry as Record<string, string>);
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    out.push({ name: e.name, app: e.app ?? null, workflow: e.workflow ?? null, creator: e.creator ?? null });
  }
  return out;
}
