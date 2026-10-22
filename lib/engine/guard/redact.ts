// Redaction for the support bundle (lib/engine/ops/bundle.ts): what a user can attach to a public bug report.
// Pattern-based and best-effort, so it errs towards replacing too much: secrets, then paths, then
// emails, then logins. Every replacement token is free of `"` and `\`, so JSON stays parseable.
import fs from 'node:fs';
import os from 'node:os';
import { worktreeRoot } from '../../core/config/load.ts';
import { git } from '../../integrations/git/runner.ts';
import { MIN_SECRET, allKnownValues } from './known-secrets.ts';
import { secretSpans } from './secrets.ts';
import type { Config, RedactCounts } from '../../core/types.ts';

export interface RedactContext {
  root: string;
  home: string;
  /** Known logins and names, at least 3 characters, longest first. */
  identities: string[];
  config: Pick<Config, 'worktrees'> | null;
  /** The configured worktrees root, which may sit outside both the repo and home. */
  worktrees?: string | null;
  /** Every job's known values (lib/engine/guard/known-secrets.ts), replaced before any pattern runs. */
  known?: string[];
}

const MIN_IDENTITY = 3;
const HOSTS = /(?:github|gitlab)\.com[/:]([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/gi;
// The lookbehind only starts a match where a local part can start, so a long run without `@` stays
// linear. An SSH remote (`git@github.com:owner/repo`) is not an email: the host pass below takes
// it, so its owner goes too.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?![A-Za-z])(?!:[A-Za-z0-9])/g;
const MENTION = /(?<![A-Za-z0-9_.@/-])@[A-Za-z0-9][A-Za-z0-9-]{0,38}\b/g;
/** Tokens this module writes: a later pass never rewrites one (an identity `repo` must not hit `<repo>`). */
const TOKEN_SRC = String.raw`<(?:repo|worktrees|email|login|redacted|secret:[a-z-]{1,32}|omitted: \d{1,12} chars)>`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');

const realOr = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

/** The owner segment of each github.com or gitlab.com URL in the text. */
function hostOwners(text: string): string[] {
  return [...text.matchAll(HOSTS)].map((m) => m[1]);
}

/** Host names that say nothing about the machine's owner. */
const ANONYMOUS_HOSTS: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain']);

/** The machine's host name and its first label: older job.json owners and lock holders record it, and it often carries the owner's name. */
function hostNames(): string[] {
  try {
    const host = os.hostname().trim();
    if (!host || ANONYMOUS_HOSTS.has(host.toLowerCase())) return [];
    return [host, host.split('.')[0]];
  } catch {
    return [];
  }
}

/** Everything that names this user, their org or their machine: git and OS user names, the host name, remote owners and the configured ones. */
export function redactContext(root: string, config: Config | null, home = os.homedir()): RedactContext {
  const ids: string[] = [];
  const name = git(root, ['config', 'user.name'], { allowFail: true });
  if (name.ok) ids.push(name.stdout.trim());
  try {
    ids.push(os.userInfo().username);
  } catch {}
  ids.push(...hostNames());
  const remotes = git(root, ['remote', '-v'], { allowFail: true });
  if (remotes.ok) ids.push(...hostOwners(remotes.stdout));
  const gh = config?.tracker?.github;
  if (typeof gh?.repo === 'string') ids.push(gh.repo.split('/')[0]);
  if (typeof gh?.project?.owner === 'string') ids.push(gh.project.owner);
  if (typeof gh?.ready?.assignee === 'string') ids.push(gh.ready.assignee.replace(/^@/, ''));
  if (Array.isArray(config?.pr?.reviewers)) ids.push(...config.pr.reviewers.filter((r): r is string => typeof r === 'string').map((r) => r.replace(/^@/, '')));
  const identities = [...new Set(ids.map((s) => s.trim()).filter((s) => s.length >= MIN_IDENTITY))].sort((a, b) => b.length - a.length);
  let worktrees: string | null = null;
  try {
    if (config) worktrees = worktreeRoot(root, config);
  } catch {}
  let known: string[] = [];
  try {
    if (config) known = allKnownValues(root, config);
  } catch {}
  return { root, home, identities, config: config ? { worktrees: config.worktrees } : null, worktrees, known };
}

/** Each known value, raw and JSON-escaped, longest first. */
function knownForms(values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (v.length < MIN_SECRET) continue;
    out.add(v);
    out.add(JSON.stringify(v).slice(1, -1));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Replaces each match of `re` outside existing tokens; `re` must be global. */
function replaceOutsideTokens(text: string, re: RegExp, to: (m: string, ...groups: string[]) => string): { text: string; n: number } {
  let n = 0;
  const combined = new RegExp(`(${TOKEN_SRC})|${re.source}`, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const out = text.replace(combined, (m: string, token: string | undefined, ...rest: unknown[]) => {
    if (token !== undefined) return m;
    n++;
    // The last two arguments are the offset and the whole string.
    return to(m, ...(rest.slice(0, -2) as string[]));
  });
  return { text: out, n };
}

/** A path and the names it may be written under, longest first; `/` and empty never match. */
function pathForms(p: string): string[] {
  return [...new Set([p, realOr(p)].map((x) => x.replace(/\/+$/, '')).filter((x) => x.length > 1))].sort((a, b) => b.length - a.length);
}

/** The text with secrets, paths, emails and logins replaced, in that order, and how many of each. */
export function redactText(text: string, ctx: RedactContext): { text: string; counts: RedactCounts } {
  const counts: RedactCounts = { secrets: 0, paths: 0, emails: 0, logins: 0 };
  let s = text;

  // Known values first: they are exact, and a pattern pass could split one and leave a piece behind.
  for (const v of knownForms(ctx.known ?? [])) {
    const parts = s.split(v);
    counts.secrets += parts.length - 1;
    s = parts.join('<secret:known>');
  }

  // Spans never overlap, so replacing from the last keeps the earlier offsets valid.
  const spans = secretSpans(s, ctx.config).sort((a, b) => b.start - a.start);
  for (const sp of spans) s = s.slice(0, sp.start) + `<secret:${sp.kind}>` + s.slice(sp.end);
  counts.secrets += spans.length;

  // Longest first across all three: the worktrees root may sit inside the repo, or beside it as `<repo>.worktrees`.
  const forms = [
    ...pathForms(ctx.root).map((x) => [x, '<repo>'] as const),
    ...(ctx.worktrees ? pathForms(ctx.worktrees).map((x) => [x, '<worktrees>'] as const) : []),
  ].sort((a, b) => b[0].length - a[0].length);
  for (const [p, token] of [...forms, ...pathForms(ctx.home).map((x) => [x, '~'] as const)]) {
    const r = replaceOutsideTokens(s, new RegExp(`${escapeRe(p)}(?![A-Za-z0-9_-])`, 'g'), () => token);
    s = r.text;
    counts.paths += r.n;
  }

  const e = replaceOutsideTokens(s, EMAIL, () => '<email>');
  s = e.text;
  counts.emails = e.n;

  if (ctx.identities.length) {
    const ids = new RegExp(`(?<![A-Za-z0-9_])(?:${ctx.identities.map(escapeRe).join('|')})(?![A-Za-z0-9_])`, 'gi');
    const r = replaceOutsideTokens(s, ids, () => '<login>');
    s = r.text;
    counts.logins += r.n;
  }
  const h = replaceOutsideTokens(s, /((?:github|gitlab)\.com)[/:]([A-Za-z0-9][A-Za-z0-9-]{0,38})(?![A-Za-z0-9-])/gi, (_m, host) => `${host}/<login>`);
  s = h.text;
  counts.logins += h.n;
  const m = replaceOutsideTokens(s, MENTION, () => '@<login>');
  s = m.text;
  counts.logins += m.n;
  return { text: s, counts };
}

/** Adds b's counts into a. */
export function addCounts(a: RedactCounts, b: RedactCounts): void {
  a.secrets += b.secrets;
  a.paths += b.paths;
  a.emails += b.emails;
  a.logins += b.logins;
}

export const omitted = (s: string): string => `<omitted: ${s.length} chars>`;

/** Keys whose string values are prose in the JSON Forge writes (job.json, events, step). */
const PROSE_KEYS: ReadonlySet<string> = new Set(['title', 'reason', 'summary', 'note', 'text', 'body', 'brief', 'prompt', 'message', 'output', 'comment', 'description', 'report']);

/** A deny-list walk over shapes Forge owns: prose strings, at any depth, become `<omitted: n chars>`. */
export function omitProse(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(omitProse);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = typeof v === 'string' && PROSE_KEYS.has(k) ? omitted(v) : omitProse(v);
    return out;
  }
  return value;
}

/** Keys whose string values a daemon log skeleton keeps: types, names, ids and states, never prose. */
const SKELETON_KEYS: ReadonlySet<string> = new Set([
  'type',
  'subtype',
  'event',
  'name',
  'tool_name',
  'last_tool_name',
  'model',
  'stop_reason',
  'terminal_reason',
  'status',
  'signal',
  'at',
  'timestamp',
  'task_type',
  'subagent_type',
  'role',
  'action',
  'rule',
  'stage',
  'state',
  'kind',
  'verdict',
  'session_id',
  'uuid',
  'request_id',
  'task_id',
  'tool_use_id',
  'id',
]);

function skeleton(v: unknown, key: string | null): unknown {
  if (typeof v === 'string') return key !== null && SKELETON_KEYS.has(key) ? v : omitted(v);
  if (Array.isArray(v)) return v.map((x) => skeleton(x, key));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = skeleton(x, k);
    return out;
  }
  return v;
}

/**
 * An allow-list walk over a Claude Code stream line, a shape Forge doesn't control: structure,
 * numbers, booleans and the strings of SKELETON_KEYS stay, every other string goes. A line that
 * isn't JSON goes whole. The result is always one line.
 */
export function daemonSkeleton(line: string): string {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return omitted(line);
  }
  return JSON.stringify(skeleton(v, null));
}
