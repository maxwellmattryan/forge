// `forge job scope`: which files a job changed that its spec's Approach never named.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJob, jobDir, logEvent } from './jobs.ts';
import { memberWorktree } from './job-repos.ts';
import { reviewedRepoNames } from './lens.ts';
import { exists } from './paths.ts';
import type { Config, Job } from './types.ts';
import { matchPolicy, policyRules } from './protected.ts';
import { ForgeError, now, run } from './util.ts';

const LIST_LIMIT = 20;

/** What `forge job scope` prints: jobScope. */
export interface ScopeReport {
  id: string;
  base: string;
  mergeBase: string;
  head: string;
  dirty: boolean;
  approach: boolean;
  specPaths: number;
  changed: number;
  inSpec: number;
  outOfSpec: string[];
  more: number;
  /** Changed files the protected-paths policy names (at most 20), and how many more. */
  protected: { path: string; action: 'escalate' | 'refuse'; reason: string }[];
  protectedMore: number;
  /** Set instead when the policy is invalid; scope itself never fails on it. */
  protectedError?: string;
  file: string;
  /** Only in a job with a reviewed member: each member's comparison point and counts, in job.repos order. */
  repos?: RepoScope[];
  /** Each reviewed member's HEAD; the root's is `head`. */
  heads?: Record<string, string>;
  /** The combined diff, relative to the job dir. */
  diff?: string;
}

/** One reviewed member in scope and panel output. */
export interface RepoScope {
  repo: string;
  base: string;
  mergeBase: string;
  head: string;
  dirty: boolean;
  changed: number;
}

/** A reviewed member's diff inputs: its checked worktree, comparison point, HEAD and changed files (repo-relative). */
export interface RepoDiff {
  repo: string;
  cwd: string;
  baseRef: string;
  mergeBase: string;
  head: string;
  dirty: boolean;
  changed: string[];
}

/**
 * The text under the `Approach` heading, up to the next heading of the same or higher level.
 * Headings inside fenced code blocks don't count, so an example spec quoted in a fence can't end it.
 */
export function approachSection(specText: string): string | null {
  const lines = specText.split(/\r?\n/);
  let level = 0;
  let fenced = false;
  let out: string[] | null = null;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const h = fenced ? null : /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (out) {
      if (h && h[1].length <= level) break;
      out.push(line);
    } else if (h && /^approach$/i.test(h[2])) {
      level = h[1].length;
      out = [];
    }
  }
  return out ? out.join('\n') : null;
}

function cleanToken(raw: string): string | null {
  let t = raw;
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/^["'`([]+/, '').replace(/\)\*+$/, ')').replace(/["'`)\]]+$/, '').replace(/[.,;:]+$/, '');
    // Markdown emphasis wrapping a word (`**lib/x.mjs**`) is not a glob.
    for (const m of ['**', '__', '*', '_']) if (t.length > 2 * m.length && t.startsWith(m) && t.endsWith(m)) t = t.slice(m.length, -m.length);
  }
  t = t.replace(/:\d+(?:-\d+)?$/, '').replace(/#L\d+(?:-L?\d+)?$/, '').replace(/^\.\//, '');
  if (!t || t.includes('://') || /\s/.test(t) || /^[-<$]/.test(t)) return null;
  if (!(t.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(t) || t.includes('*'))) return null;
  return t;
}

/** One level of brace expansion: `lib/{a,b}.mjs` → `lib/a.mjs`, `lib/b.mjs`. */
function expandBraces(t: string): string[] {
  const m = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(t);
  return m ? m[2].split(',').map((alt) => m[1] + alt + m[3]) : [t];
}

/**
 * Path-like tokens named in the Approach section: backtick spans and whitespace-separated words.
 * Prose that happens to look like a path survives, which only makes the check more lenient.
 */
export function approachPaths(specText: string): string[] {
  const section = approachSection(specText);
  if (section === null) return [];
  const spans = [...section.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  // Words containing a backtick are already covered by their span; re-reading them only adds noise.
  const words = section.split(/\s+/).filter((w) => w && !w.includes('`'));
  const out = new Set<string>();
  for (const raw of [...spans, ...words]) {
    const t = cleanToken(raw);
    if (!t) continue;
    for (const e of expandBraces(t)) if (e) out.add(e);
  }
  return [...out];
}

/** `**` crosses directories, `*` and `?` do not; anchored to the whole string. */
export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('**/')
    .map((part) =>
      part
        .split('**')
        .map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
        .join('.*'),
    )
    .join('(?:.*/)?');
  return new RegExp(`^${body}$`);
}

/** Whether a changed file is covered by any token named in the spec. */
export function inSpec(file: string, tokens: string[]): boolean {
  const base = path.posix.basename(file);
  return tokens.some((t) => {
    if (file === t) return true;
    if (t.endsWith('/') ? file.startsWith(t) : file.startsWith(`${t}/`)) return true;
    if (t.includes('*') || t.includes('?')) {
      const re = globToRegExp(t.replace(/\/$/, ''));
      // A slash-free glob (`*.test.mjs`) is read like a bare filename and matched against the basename too.
      return re.test(file) || (!t.includes('/') && re.test(base));
    }
    return !t.includes('/') && base === t;
  });
}

const git = (cwd: string, args: string[]): string => run('git', args, { cwd }).stdout.trim();

/**
 * Env for git calls that must see the committed history as it is: replace objects and grafts are
 * repository state the job's worktree can write, and either can make two commits look related.
 */
export function realHistoryEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: path.join(os.devNull, 'forge-no-grafts') };
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * The paths whose content at `sha` differs from git's own merge of `head` and `upstream`: what a
 * conflict resolution, and every commit after it, changed beyond the automatic merge. Conflicted
 * files differ too, since the automatic merge leaves markers in them. Null when it can't be
 * computed, so the caller keeps the integration review.
 */
export function integrationTouched(cwd: string, head: string, upstream: string, sha: string): string[] | null {
  if (![head, upstream, sha].every((s) => FULL_SHA.test(s))) return null;
  const env = realHistoryEnv();
  // Exit 1 means the merge has conflicts; the tree (with markers) is still written.
  const merged = run('git', ['merge-tree', '--write-tree', '--no-messages', head, upstream], { cwd, env, allowFail: true });
  if (merged.status !== 0 && merged.status !== 1) return null;
  const tree = merged.stdout.split('\n')[0].trim();
  if (!FULL_SHA.test(tree)) return null;
  const diff = run('git', ['diff', '--name-only', '--no-renames', '-z', tree, sha, '--'], { cwd, env, allowFail: true });
  return diff.ok ? diff.stdout.split('\0').filter(Boolean) : null;
}

/**
 * The ref a job branch is compared against: `<remote>/<base>` when it resolves, else the local base.
 * Shared by `forge job scope` and verify's integrity report so both read the same diff.
 * Refs are fully qualified and replace objects and grafts are ignored, so a tag named like the base
 * branch, a `git replace` or `.git/info/grafts` made from the job's worktree cannot move the comparison point.
 * `head` is a commit id when a caller binds its evidence to the commit it read (the secret scan), else HEAD.
 */
export function resolveBase(cwd: string, config: Config, job: Pick<Job, 'base'>, head = 'HEAD'): { baseRef: string; mergeBase: string } {
  const base = String(job.base ?? '');
  const candidates: [string, string][] = base.startsWith('refs/')
    ? [[base, base]]
    : /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(base)
      ? [[base, base]]
      : [
          [`${config.git.remote}/${base}`, `refs/remotes/${config.git.remote}/${base}`],
          [base, `refs/heads/${base}`],
        ];
  const env = realHistoryEnv();
  for (const [name, ref] of candidates) {
    const r = run('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, env, allowFail: true });
    if (r.ok) return { baseRef: name, mergeBase: run('git', ['merge-base', r.stdout.trim(), head], { cwd, env }).stdout.trim() };
  }
  throw new ForgeError(`base ${job.base} not found`);
}

/**
 * The files the committed history changed since `mergeBase`, as git stores their paths, sorted.
 * Every option that could hide or reshape a path is pinned, because the worktree's config is
 * builder-writable: `-z` keeps non-ASCII paths raw under core.quotePath, `--no-renames` keeps a
 * renamed file's old path, `--no-relative` ignores diff.relative, `--no-ext-diff` skips external
 * drivers, and realHistoryEnv ignores replace objects and grafts.
 */
export function committedChanges(cwd: string, mergeBase: string): string[] {
  const out = run('git', ['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', mergeBase, 'HEAD', '--'], { cwd, env: realHistoryEnv() }).stdout;
  return out.split('\0').filter(Boolean).sort();
}

/**
 * Every reviewed member's diff inputs, in job.repos order; none for a single-repo job. A member's
 * worktree goes through memberWorktree's checks (a stored path that isn't Forge's computed one
 * throws), and its base through resolveBase, so the comparison point is pinned as the root's is.
 */
export function reviewedRepoDiffs(root: string, config: Config, job: Pick<Job, 'id' | 'repos'>): RepoDiff[] {
  const env = realHistoryEnv();
  return reviewedRepoNames(job).map((name) => {
    const { member, worktree: cwd } = memberWorktree(root, config, job, name);
    const { baseRef, mergeBase } = resolveBase(cwd, config, { base: member.base });
    const head = run('git', ['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, env }).stdout.trim();
    const dirty = run('git', ['status', '--porcelain'], { cwd, env }).stdout.trim() !== '';
    return { repo: name, cwd, baseRef, mergeBase, head, dirty, changed: committedChanges(cwd, mergeBase) };
  });
}

/** One section of scope.diff: `prefix` is '' for the root and `<repo>/` for a member. */
export interface DiffSection {
  label: string;
  cwd: string;
  baseRef: string;
  mergeBase: string;
  head: string;
  prefix: string;
}

/**
 * The combined unified diff reviewers read. Prefixes, context, colour, renames, external drivers and
 * textconv are all pinned on the command line, because the worktree's git config is builder-writable
 * and could otherwise drop the repo prefix or substitute a driver's output for the real change.
 */
export function writeScopeDiff(file: string, sections: DiffSection[]): void {
  const env = realHistoryEnv();
  const parts = sections.map((s) => {
    const out = run(
      'git',
      ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--no-renames', '-U3', `--src-prefix=a/${s.prefix}`, `--dst-prefix=b/${s.prefix}`, s.mergeBase, s.head, '--'],
      { cwd: s.cwd, env },
    ).stdout;
    return `# repo ${s.label} base ${s.baseRef} @ ${s.mergeBase} · HEAD ${s.head}\n${out}`;
  });
  fs.writeFileSync(file, parts.join(''));
}

/**
 * Compares the committed diff since the merge-base with the spec's Approach paths and writes scope.md.
 * No job.json change; one `scope` event, so `forge job step` knows this round's scope is current.
 */
export function jobScope(root: string, config: Config, id: string): ScopeReport {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const dir = jobDir(root, job.id);
  const specFile = path.join(dir, 'spec.md');
  if (!exists(specFile)) throw new ForgeError(`job ${id} has no spec.md`);
  const cwd = job.worktree;
  const { baseRef, mergeBase } = resolveBase(cwd, config, job);
  const head = git(cwd, ['rev-parse', 'HEAD']);
  const dirty = git(cwd, ['status', '--porcelain']) !== '';
  const rootChanged = committedChanges(cwd, mergeBase);
  const members = reviewedRepoDiffs(root, config, job);
  // Root files first, then each member's under its `<repo>/` prefix, so the Approach can name either.
  const changedFiles = [...rootChanged, ...members.flatMap((m) => m.changed.map((f) => `${m.repo}/${f}`))];

  const specText = fs.readFileSync(specFile, 'utf8');
  const approach = approachSection(specText) !== null;
  const tokens = approachPaths(specText);
  const inside = changedFiles.filter((f) => inSpec(f, tokens));
  const outside = changedFiles.filter((f) => !inSpec(f, tokens));
  let prot: { path: string; action: 'escalate' | 'refuse'; reason: string }[] = [];
  let protectedError: string | undefined;
  try {
    const rules = policyRules(config);
    // Root files only: member protected paths are enforced by forge git, verify and pr open.
    prot = rootChanged.flatMap((f) => {
      const m = matchPolicy(f, rules);
      return m ? [{ path: f, action: m.action, reason: m.reason }] : [];
    });
  } catch (e) {
    protectedError = (e as Error).message;
  }

  const file = path.join(dir, 'scope.md');
  const diffFile = path.join(dir, 'scope.diff');
  const heads = Object.fromEntries(members.map((m) => [m.repo, m.head]));
  if (members.length)
    writeScopeDiff(diffFile, [
      { label: 'root', cwd, baseRef, mergeBase, head, prefix: '' },
      ...members.map((m) => ({ label: m.repo, cwd: m.cwd, baseRef: m.baseRef, mergeBase: m.mergeBase, head: m.head, prefix: `${m.repo}/` })),
    ]);
  // A single-repo job's reviewers read `forge git diff`; a combined diff left by an earlier run would mislead them.
  else fs.rmSync(diffFile, { force: true });
  fs.writeFileSync(file, renderScope({ baseRef, mergeBase, head, dirty, approach, tokens, inside, outside, changed: changedFiles.length, prot, protectedError, members }));
  logEvent(root, job.id, 'scope', { round: job.round, head, ...(members.length ? { heads } : {}) });
  return {
    id: job.id,
    base: baseRef,
    mergeBase,
    head,
    dirty,
    approach,
    specPaths: tokens.length,
    changed: changedFiles.length,
    inSpec: inside.length,
    outOfSpec: outside.slice(0, LIST_LIMIT),
    more: Math.max(0, outside.length - LIST_LIMIT),
    protected: prot.slice(0, LIST_LIMIT),
    protectedMore: Math.max(0, prot.length - LIST_LIMIT),
    ...(protectedError ? { protectedError } : {}),
    file: path.relative(root, file),
    ...(members.length
      ? { repos: members.map((m) => ({ repo: m.repo, base: m.baseRef, mergeBase: m.mergeBase, head: m.head, dirty: m.dirty, changed: m.changed.length })), heads, diff: path.relative(dir, diffFile) }
      : {}),
  };
}

function renderScope(s: {
  baseRef: string;
  mergeBase: string;
  head: string;
  dirty: boolean;
  approach: boolean;
  tokens: string[];
  inside: string[];
  outside: string[];
  changed: number;
  prot: { path: string; action: string; reason: string }[];
  protectedError?: string;
  members?: RepoDiff[];
}): string {
  const members = s.members ?? [];
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- \`${x}\``) : ['- none']);
  return [
    `SCOPE: ${s.outside.length} of ${s.changed} changed files outside spec Approach`,
    '',
    `Base ${s.baseRef} @ ${s.mergeBase.slice(0, 12)} · HEAD ${s.head.slice(0, 12)} · ${now()}`,
    ...members.map((m) => `Repo ${m.repo}: base ${m.baseRef} @ ${m.mergeBase.slice(0, 12)} · HEAD ${m.head.slice(0, 12)}`),
    ...(s.approach ? [] : ['> spec.md has no Approach section: every changed file counts as out of scope.']),
    ...(s.dirty ? ['> Worktree has uncommitted changes; they are not included.'] : []),
    ...members.filter((m) => m.dirty).map((m) => `> Repo ${m.repo} has uncommitted changes; they are not included.`),
    '',
    `## Protected (${s.prot.length})`,
    ...(s.protectedError ? [`- the policy is invalid: ${s.protectedError.replace(/[\x00-\x1f\x7f]/g, ' ')}`] : s.prot.length ? s.prot.map((p) => `- \`${p.path}\`: ${p.action} (${p.reason})`) : ['- none']),
    `## Out of spec (${s.outside.length})`,
    ...list(s.outside),
    `## In spec (${s.inside.length})`,
    ...list(s.inside),
    `## Paths named in Approach (${s.tokens.length})`,
    ...list(s.tokens),
    '',
  ].join('\n');
}
