// Related tests: the test files a job's changes since its base need, which `forge run <job> <command> --changed`
// passes at the command's `{args}` instead of running the whole suite. Selection is path templates only (relatedTests).
import fs from 'node:fs';
import path from 'node:path';
import { resolveBase } from '../pipeline/scope.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { globToRegExp } from '#core/glob.ts';
import { loadJob } from '#core/job/store.ts';
import { jobComponent } from '#core/config/components.ts';
import { ForgeError } from '#core/errors.ts';
import type { Config, Job } from '#core/types.ts';
import { commandTemplate, runCommand, type CommandResult, type RunOptions } from './run.ts';

/** What the job's changes ask for: `files` passes the selected tests, `full` runs the whole command, `none` runs nothing. */
export interface RelatedTests {
  mode: 'files' | 'full' | 'none';
  files: string[];
  /** How many paths changed since the merge-base. */
  changed: number;
  /** The first changed path, in sort order, that matched relatedTests.full; only in mode full. */
  trigger?: string;
  /** Related tests left out because a command would not read them as a plain file name; only when non-empty. */
  skipped?: string[];
}

/** What `forge run <job> <command> --changed` prints: the run with its selection, or the selection alone when nothing ran. */
export type ChangedResult = (CommandResult & { related: RelatedTests }) | { name: string; ok: true; ran: false; related: RelatedTests };

// A segment starting with `-` reads as an option to most runners; the rest is what shellArgs refuses.
const unsafe = (p: string): boolean => p.split('/').some((s) => s.startsWith('-')) || /['\\\x00-\x1f\x7f]/.test(p);

/** A `map` template for one changed path, in one pass so a name holding `{dir}` is never filled again. */
function fillTemplate(template: string, dir: string, name: string): string {
  const t = !dir && template.startsWith('{dir}/') ? template.slice('{dir}/'.length) : template;
  return t.replace(/\{(dir|name)\}/g, (_m, k: string) => (k === 'dir' ? dir : name));
}

/**
 * The tests `changed` needs among the existing worktree `files`, by the first rule that matches each
 * changed path: a test file (relatedTests.tests) is selected while it exists; a relatedTests.full path
 * makes the run full; anything else is filled into each relatedTests.map template, whose glob selects
 * the existing test files it matches. With a `prefix` (the job's component path), only tests under it
 * are kept, relative to it. Pure: the caller lists the files.
 */
export function selectTests(changed: string[], files: string[], rules: Config['relatedTests'], prefix = ''): RelatedTests {
  const tests = rules.tests.map(globToRegExp);
  const full = rules.full.map(globToRegExp);
  const isTest = (p: string): boolean => tests.some((re) => re.test(p));
  const candidates = files.filter(isTest);
  const existing = new Set(candidates);
  const paths = [...new Set(changed)].sort();
  const picked = new Set<string>();
  let trigger: string | undefined;
  for (const p of paths) {
    if (isTest(p)) {
      if (existing.has(p)) picked.add(p);
    } else if (full.some((re) => re.test(p))) {
      trigger ??= p;
    } else if (!/[*?]/.test(p)) {
      // A glob character in the name would widen the template's match, so such a path maps to nothing.
      const dir = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
      const base = path.posix.basename(p);
      const name = base.slice(0, base.length - path.posix.extname(base).length);
      for (const t of rules.map) {
        const re = globToRegExp(fillTemplate(t, dir, name));
        for (const f of candidates) if (re.test(f)) picked.add(f);
      }
    }
  }
  if (trigger !== undefined) return { mode: 'full', files: [], changed: paths.length, trigger };
  const lead = prefix ? `${prefix}/` : '';
  const kept = [...picked].filter((f) => f.startsWith(lead)).map((f) => f.slice(lead.length));
  const selected = [...new Set(kept.filter((f) => !unsafe(f)))].sort();
  const skipped = [...new Set(kept.filter(unsafe))].sort();
  return { mode: selected.length ? 'files' : 'none', files: selected, changed: paths.length, ...(skipped.length ? { skipped } : {}) };
}

const nulList = (out: string): string[] => out.split('\0').filter(Boolean);

/**
 * Every path that differs between the job's merge-base and its worktree, committed, staged or
 * unstaged (deleted ones too), plus untracked files that are not ignored; sorted, without duplicates.
 * The worktree's config is branch content, so everything that reshapes the list is pinned: `-z` keeps
 * paths raw, `--no-relative` ignores diff.relative, `--no-renames` keeps a renamed file's old path,
 * `--no-ext-diff` skips external drivers, and resolveBase and historyEnv pin the comparison point.
 */
export function jobChanges(cwd: string, config: Config, job: Pick<Job, 'base'>): string[] {
  const { mergeBase } = resolveBase(cwd, config, job);
  const diff = git(cwd, ['diff', '--name-only', '-z', '--no-renames', '--no-relative', '--no-ext-diff', mergeBase, '--'], { env: historyEnv() }).stdout;
  const untracked = git(cwd, ['ls-files', '-z', '--others', '--exclude-standard']).stdout;
  return [...new Set([...nulList(diff), ...nulList(untracked)])].sort();
}

/** The worktree's tracked and untracked, not ignored, files that exist on disk, so a deleted test is never passed. */
export function worktreeFiles(cwd: string): string[] {
  const out = git(cwd, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout;
  return [...new Set(nulList(out))].filter((p) => fs.existsSync(path.join(cwd, p)));
}

/** The job's component path as a prefix of repo-relative paths, '' when the command runs at the worktree root. */
function componentPrefix(config: Config, job: Job): string {
  const p = jobComponent(config, job)?.path;
  if (!p) return '';
  const norm = path.posix.normalize(p).replace(/\/+$/, '');
  return norm === '.' ? '' : norm;
}

/**
 * `forge run <job> <name> --changed`: runs the command on the related tests of the job's changes, the
 * whole command when a shared helper changed, and nothing (no log, event or lease renewal) when no
 * test is related. Every refusal comes before anything runs.
 */
export function runChanged(root: string, config: Config, id: string, name: string, opts: Pick<RunOptions, 'tail' | 'checks'> = {}): ChangedResult {
  const job = loadJob(root, id);
  if (!job.worktree) throw new ForgeError(`job ${id} has no worktree yet; run: forge worktree create ${id}`);
  const template = commandTemplate(config, job, name);
  if (!template) throw new ForgeError(`no "${name}" command configured (commands.${name} in .forge/config.yml)`);
  if (!template.includes('{args}')) throw new ForgeError(`forge run --changed: commands.${name} takes no arguments; put {args} in the template where they go`);
  const related = selectTests(jobChanges(job.worktree, config, job), worktreeFiles(job.worktree), config.relatedTests, componentPrefix(config, job));
  if (related.mode === 'none') return { name, ok: true, ran: false, related };
  const args = related.mode === 'files' ? { args: related.files } : {};
  // A `files` run records its arguments in the check cache's key, so it never stands in for verify's full run.
  return { ...runCommand(root, config, id, name, { ...(opts.tail !== undefined ? { tail: opts.tail } : {}), ...(opts.checks ? { checks: opts.checks } : {}), ...args }), related };
}
