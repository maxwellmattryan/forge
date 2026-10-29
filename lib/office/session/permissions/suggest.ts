// The read-only report `forge daemon prompts` builds from the prompt history (history.ts): prompts grouped by exact
// candidate rule, ranked by how often each was asked, and the daemon.allowedTools rules a human may add by hand. A
// human may paste a suggestion into the allowlist every unattended session runs under, so a rule is suggested only
// when it was never denied (in the history read, whatever `--since` says), passes the list's own non-exhaustive
// validation, doesn't start a shell, interpreter, exec wrapper, fetcher or file writer, names no path outside the
// roots it can prove, and isn't listed yet; anything it can't prove is skipped, with the reason. It is a filter, not
// a proof: a human reads every rule before adding it.
import fs from 'node:fs';
import path from 'node:path';
import { allowedToolProblem } from '#core/config/trust.ts';
import { writeRoots } from '../confine.ts';
import { RULE_SHAPE, type PromptEntry } from './history.ts';
import type { Config } from '#core/types.ts';

export type PromptSkip = 'no-rule' | 'denied' | 'invalid' | 'broad' | 'outside-repo' | 'listed' | 'below-min';

export interface PromptGroup {
  /** Null: the prompts of `tool` that carried no candidate rule. */
  rule: string | null;
  /** The tool of the group's newest entry. */
  tool: string;
  asked: number;
  allowed: number;
  denied: number;
  deniedBy: { human: number; timeout: number; unasked: number };
  /** Denies of the rule before `since`: in neither `asked` nor `denied`, but they still block a suggestion. */
  deniedEarlier: number;
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

/** Where a suggested rule's absolute paths must lie: `files` for a file tool's patterns, `commands` for a command's arguments. */
export interface PromptRoots {
  files: string[];
  commands: string[];
}

const MAX_GROUPS = 100;
const MAX_JOBS = 20;
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead', 'Glob', 'Grep', 'LS']);
/** Content that names a path no check here can resolve: home, a variable, a substitution, an escape or a parent. */
const UNPROVABLE = /[~$`\\]|\.\./;
const SEPARATORS = /[\s'"=,;|&()<>]+/;

/**
 * Commands that run whatever they are handed or write wherever they are told, so a rule starting with one is as wide
 * as an unscoped Bash whatever follows it: a shell, an interpreter, a wrapper that runs another command, a package
 * runner, a fetcher or remote shell, a file writer. The list is not exhaustive, as the validation's isn't.
 */
const BROAD_COMMANDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'fish', 'csh', 'tcsh',
  'node', 'nodejs', 'deno', 'bun', 'tsx', 'ts-node', 'python', 'perl', 'ruby', 'php', 'lua', 'awk', 'gawk', 'mawk', 'nawk', 'osascript', 'pwsh', 'powershell',
  'env', 'xargs', 'find', 'eval', 'exec', 'source', '.', 'sudo', 'su', 'doas', 'nohup', 'timeout', 'watch', 'nice', 'ionice', 'time', 'command', 'builtin', 'setsid', 'stdbuf', 'script',
  'npx', 'pnpx', 'bunx',
  'curl', 'wget', 'ssh', 'scp', 'rsync', 'nc', 'ncat',
  'cp', 'mv', 'rm', 'tee', 'chmod', 'chown', 'ln', 'dd', 'install', 'truncate',
]);
/** An interpreter with a version: `python3`, `python3.12`, `perl5`, `ruby3.2`. */
const VERSIONED = /^(?:python|perl|ruby|php|lua)[0-9.]*$/;
/** Package managers whose `exec`, `x` or `dlx` runs any package's binary. */
const RUNNERS = new Set(['npm', 'pnpm', 'yarn']);
const RUNNER_SUBS = new Set(['exec', 'x', 'dlx']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The roots a suggested rule's paths must lie in: a file tool's, the checkout as given, its realpath and the worktrees roots; a command's, the worktrees roots only. */
export function promptRoots(root: string, config: Config): PromptRoots {
  const files = [path.resolve(root)];
  try {
    files.push(fs.realpathSync(root));
  } catch {}
  let worktrees: string[] = [];
  try {
    worktrees = writeRoots(root, config).worktrees;
  } catch {}
  return { files: [...new Set([...files, ...worktrees])], commands: worktrees };
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
 * Whether a rule may name a path outside `roots`: true unless every path written in it is proven inside. A file
 * tool's `//abs` pattern must lie in a root of `files`, a single leading `/` (relative to a settings file, which
 * --allowedTools has none of) is refused, and a relative pattern is the checkout's; any other tool's absolute paths
 * must lie in a root of `commands`. It sees only the paths the rule spells out: a trailing `:*` lets any later
 * argument name any path.
 */
function outsideRepo(rule: string, roots: PromptRoots): boolean {
  const m = RULE_SHAPE.exec(rule);
  if (!m) return true;
  const [, tool, content] = m;
  if (UNPROVABLE.test(content)) return true;
  if (FILE_TOOLS.has(tool)) {
    if (content.startsWith('//')) return !insideRoots(content.slice(1), roots.files);
    return content.startsWith('/');
  }
  for (const tok of content.split(SEPARATORS)) {
    const found = tokenPaths(tok);
    if (found === null || found.some((p) => !insideRoots(p, roots.commands))) return true;
  }
  return false;
}

/**
 * Whether a Bash rule starts, in any part of a compound command, one of BROAD_COMMANDS, a package manager's
 * `exec`/`x`/`dlx`, or a command word it can't read (a glob, or no word at all). The command word is read past
 * leading `VAR=value` words, quotes and a directory (`./node_modules/.bin/node` is `node`). Not for other tools.
 */
function broadCommand(rule: string): boolean {
  const m = RULE_SHAPE.exec(rule);
  if (!m || m[1] !== 'Bash') return false;
  let seen = false;
  for (const part of m[2].replace(/:\*$/, '').split(/&&|\|\||[;|&]/)) {
    const words = part.replace(/['"]/g, '').replace(/^[\s({!]+/, '').split(/\s+/).filter(Boolean);
    const at = words.findIndex((w) => !ASSIGNMENT.test(w));
    if (at < 0) continue;
    seen = true;
    const word = words[at].replace(/:+$/, '');
    if (/[*?[{]/.test(word)) return true;
    const cmd = path.posix.basename(word).toLowerCase();
    if (BROAD_COMMANDS.has(cmd) || VERSIONED.test(cmd)) return true;
    if (RUNNERS.has(cmd) && words.slice(at + 1).some((w) => RUNNER_SUBS.has(w))) return true;
  }
  return !seen;
}

function skipOf(g: PromptGroup, min: number, roots: PromptRoots): PromptSkip | null {
  if (g.rule === null) return 'no-rule';
  if (g.denied > 0 || g.deniedEarlier > 0) return 'denied';
  if (allowedToolProblem(g.rule) !== null) return 'invalid';
  if (broadCommand(g.rule)) return 'broad';
  if (outsideRepo(g.rule, roots)) return 'outside-repo';
  if (g.listed) return 'listed';
  if (g.allowed < min) return 'below-min';
  return null;
}

const byRule = (a: string | null, b: string | null): number => (a === b ? 0 : a === null ? 1 : b === null ? -1 : a < b ? -1 : 1);

/** The groups an entry counts in, as [group key, rule]: one per distinct rule, else its tool's `rule: null` group. */
const keysOf = (e: PromptEntry): [string, string | null][] => (e.rules.length ? [...new Set(e.rules)].map((r): [string, string] => [`rule ${r}`, r]) : [[`tool ${e.tool}`, null]]);

/**
 * The history grouped by exact rule text (an entry with no rule counts in its tool's `rule: null` group), ranked by
 * how often each was asked, with the rules a human may add to daemon.allowedTools: allowed at least `min` times,
 * never denied, valid as an entry, not broad, naming no path outside `roots`, and not listed yet. `since` limits
 * which entries are counted; a deny before it still blocks (`deniedEarlier`), though it makes no group of its own. Pure.
 */
export function promptReport(entries: PromptEntry[], o: { min: number; since: string | null; allowedTools: unknown; roots: PromptRoots }): PromptReport {
  const listed = new Set(Array.isArray(o.allowedTools) ? o.allowedTools.filter((t): t is string => typeof t === 'string') : []);
  const since = o.since === null ? NaN : Date.parse(o.since);
  const kept: { e: PromptEntry; i: number; t: number }[] = [];
  const earlier = new Map<string, number>();
  entries.forEach((e, i) => {
    const t = Date.parse(e.at);
    if (!(t < since)) kept.push({ e, i, t });
    else if (e.decision === 'deny') for (const [key] of keysOf(e)) earlier.set(key, (earlier.get(key) ?? 0) + 1);
  });
  // Newest first, so a group's tool, lastSeen and jobs come from its newest entries.
  kept.sort((a, b) => b.t - a.t || b.i - a.i);
  const groups = new Map<string, PromptGroup>();
  const seen = new Map<PromptGroup, number>();
  for (const { e, t } of kept) {
    for (const [key, rule] of keysOf(e)) {
      let g = groups.get(key);
      if (!g) {
        g = { rule, tool: e.tool, asked: 0, allowed: 0, denied: 0, deniedBy: { human: 0, timeout: 0, unasked: 0 }, deniedEarlier: earlier.get(key) ?? 0, jobs: [], lastSeen: e.at, listed: rule !== null && listed.has(rule), skip: null };
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
