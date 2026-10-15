// `forge job scope`: which files a job changed that its spec's Approach never named.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadJob, jobDir, logEvent } from './jobs.ts';
import { exists } from './paths.ts';
import type { Config, Job } from './types.ts';
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
  file: string;
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
function globToRegExp(glob: string): RegExp {
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
  const changedFiles = git(cwd, ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD']).split('\n').filter(Boolean).sort();

  const specText = fs.readFileSync(specFile, 'utf8');
  const approach = approachSection(specText) !== null;
  const tokens = approachPaths(specText);
  const inside = changedFiles.filter((f) => inSpec(f, tokens));
  const outside = changedFiles.filter((f) => !inSpec(f, tokens));

  const file = path.join(dir, 'scope.md');
  fs.writeFileSync(file, renderScope({ baseRef, mergeBase, head, dirty, approach, tokens, inside, outside, changed: changedFiles.length }));
  logEvent(root, job.id, 'scope', { round: job.round, head });
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
    file: path.relative(root, file),
  };
}

function renderScope(s: { baseRef: string; mergeBase: string; head: string; dirty: boolean; approach: boolean; tokens: string[]; inside: string[]; outside: string[]; changed: number }): string {
  const list = (xs: string[]) => (xs.length ? xs.map((x) => `- \`${x}\``) : ['- none']);
  return [
    `SCOPE: ${s.outside.length} of ${s.changed} changed files outside spec Approach`,
    '',
    `Base ${s.baseRef} @ ${s.mergeBase.slice(0, 12)} · HEAD ${s.head.slice(0, 12)} · ${now()}`,
    ...(s.approach ? [] : ['> spec.md has no Approach section: every changed file counts as out of scope.']),
    ...(s.dirty ? ['> Worktree has uncommitted changes; they are not included.'] : []),
    '',
    `## Out of spec (${s.outside.length})`,
    ...list(s.outside),
    `## In spec (${s.inside.length})`,
    ...list(s.inside),
    `## Paths named in Approach (${s.tokens.length})`,
    ...list(s.tokens),
    '',
  ].join('\n');
}
