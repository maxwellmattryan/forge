// The read-only report `forge daemon prompts` builds from the prompt history (history.ts): prompts grouped by exact
// candidate rule, ranked by how often each was asked, and the daemon.allowedTools rules a human may add by hand. A
// human may paste a suggestion into the allowlist every unattended session runs under, so a rule is suggested only
// when it was never denied, passes the list's own validation, names no path outside the checkout and its worktrees
// roots, and isn't listed yet; anything it can't prove is skipped, with the reason.
import fs from 'node:fs';
import path from 'node:path';
import { allowedToolProblem } from '#core/config/trust.ts';
import { writeRoots } from '../confine.ts';
import { RULE_SHAPE, type PromptEntry } from './history.ts';
import type { Config } from '#core/types.ts';

export type PromptSkip = 'no-rule' | 'denied' | 'invalid' | 'outside-repo' | 'listed' | 'below-min';

export interface PromptGroup {
  /** Null: the prompts of `tool` that carried no candidate rule. */
  rule: string | null;
  /** The tool of the group's newest entry. */
  tool: string;
  asked: number;
  allowed: number;
  denied: number;
  deniedBy: { human: number; timeout: number; unasked: number };
  /** The scopes that raised it, newest first, at most MAX_JOBS. */
  jobs: string[];
  lastSeen: string;
  /** Already exactly in daemon.allowedTools. */
  listed: boolean;
  skip: PromptSkip | null;
}

export interface PromptReport {
  since: string | null;
  min: number;
  entries: number;
  groups: PromptGroup[];
  /** Groups left out past the first MAX_GROUPS. */
  omitted: number;
  suggest: string[];
}

const MAX_GROUPS = 100;
const MAX_JOBS = 20;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS']);
/** Content that names a path no check here can resolve: home, a variable, a substitution, an escape or a parent. */
const UNPROVABLE = /[~$`\\]|\.\./;
const SEPARATORS = /[\s'"=,;|&()<>]+/;

/** The roots a suggested rule's paths must lie in: the checkout as given and its realpath, and every worktrees root writeRoots names. */
export function promptRoots(root: string, config: Config): string[] {
  const roots = [path.resolve(root)];
  try {
    roots.push(fs.realpathSync(root));
  } catch {}
  try {
    roots.push(...writeRoots(root, config).worktrees);
  } catch {}
  return [...new Set(roots)];
}

/** `p` (absolute) is one of `roots` or lies under one. */
function insideRoots(p: string, roots: readonly string[]): boolean {
  return roots.some((r) => {
    const rel = path.relative(r, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

/**
 * The absolute paths one token of a non-file rule names, or null when it can't be told: a token starting with
 * `/`, and, more strictly than a bare split, a path glued to a flag (`-f/etc`) or after a `host:` or curl `@`
 * prefix. `file:` URLs read local files, so they are unprovable; any other `://` token is a URL, not a path.
 */
function tokenPaths(tok: string): string[] | null {
  if (/^file:/i.test(tok)) return null;
  if (tok.includes('://')) return [];
  const i = tok.indexOf('/');
  if (i < 0) return [];
  if (i === 0) return [tok];
  return tok.startsWith('-') || /[:@]/.test(tok.slice(0, i)) ? [tok.slice(i)] : [];
}

/**
 * Whether a rule may name a path outside `roots`: true unless every path in it is proven inside. A file tool's
 * `//abs` pattern must lie in a root, a single leading `/` (relative to a settings file, which --allowedTools has
 * none of) is refused, and a relative pattern is the checkout's; any other tool's absolute paths must lie in a root.
 */
function outsideRepo(rule: string, roots: readonly string[]): boolean {
  const m = RULE_SHAPE.exec(rule);
  if (!m) return true;
  const [, tool, content] = m;
  if (UNPROVABLE.test(content)) return true;
  if (FILE_TOOLS.has(tool)) {
    if (content.startsWith('//')) return !insideRoots(content.slice(1), roots);
    return content.startsWith('/');
  }
  for (const tok of content.split(SEPARATORS)) {
    const found = tokenPaths(tok);
    if (found === null || found.some((p) => !insideRoots(p, roots))) return true;
  }
  return false;
}

function skipOf(g: PromptGroup, min: number, roots: readonly string[]): PromptSkip | null {
  if (g.rule === null) return 'no-rule';
  if (g.denied > 0) return 'denied';
  if (allowedToolProblem(g.rule) !== null) return 'invalid';
  if (outsideRepo(g.rule, roots)) return 'outside-repo';
  if (g.listed) return 'listed';
  if (g.allowed < min) return 'below-min';
  return null;
}

const byRule = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

/**
 * The history grouped by exact rule text (an entry with no rule counts in its tool's `rule: null` group), ranked by
 * how often each was asked, with the rules a human may add to daemon.allowedTools: allowed at least `min` times,
 * never denied, valid as an entry, naming no path outside `roots`, and not listed yet. Pure.
 */
export function promptReport(entries: PromptEntry[], o: { min: number; since: string | null; allowedTools: unknown; roots: string[] }): PromptReport {
  const listed = new Set(Array.isArray(o.allowedTools) ? o.allowedTools.filter((t): t is string => typeof t === 'string') : []);
  const since = o.since === null ? NaN : Date.parse(o.since);
  const kept = entries.map((e, i) => ({ e, i, t: Date.parse(e.at) })).filter((x) => !(x.t < since));
  // Newest first, so a group's tool, lastSeen and jobs come from its newest entries.
  kept.sort((a, b) => b.t - a.t || b.i - a.i);
  const groups = new Map<string, PromptGroup>();
  const seen = new Map<PromptGroup, number>();
  for (const { e, t } of kept) {
    const keys: [string, string | null][] = e.rules.length ? [...new Set(e.rules)].map((r) => [`rule ${r}`, r]) : [[`tool ${e.tool}`, null]];
    for (const [key, rule] of keys) {
      let g = groups.get(key);
      if (!g) {
        g = { rule, tool: e.tool, asked: 0, allowed: 0, denied: 0, deniedBy: { human: 0, timeout: 0, unasked: 0 }, jobs: [], lastSeen: e.at, listed: rule !== null && listed.has(rule), skip: null };
        groups.set(key, g);
        seen.set(g, t);
      }
      g.asked++;
      if (e.decision !== 'deny') g.allowed++;
      else {
        g.denied++;
        g.deniedBy[e.reason === 'human' || e.reason === 'timeout' ? e.reason : 'unasked']++;
      }
      if (g.jobs.length < MAX_JOBS && !g.jobs.includes(e.scope)) g.jobs.push(e.scope);
    }
  }
  const out = [...groups.values()].sort(
    (a, b) => b.asked - a.asked || seen.get(b)! - seen.get(a)! || byRule(a.rule, b.rule) || (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0),
  );
  for (const g of out) g.skip = skipOf(g, o.min, o.roots);
  const suggest = out
    .filter((g) => g.skip === null)
    .sort((a, b) => b.allowed - a.allowed || byRule(a.rule, b.rule))
    .map((g) => g.rule as string);
  return { since: o.since, min: o.min, entries: kept.length, groups: out.slice(0, MAX_GROUPS), omitted: Math.max(0, out.length - MAX_GROUPS), suggest };
}
