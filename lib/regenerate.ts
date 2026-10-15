// Committed build output (`worktrees.generated`) that conflicts during `forge integrate`: Forge takes
// the base side, runs `worktrees.generatedBy` and stages the result, instead of handing generated
// files to the integrator. Every conflicted name comes from a worktree the builder controls, so a
// path reaches git or fs only after it matches a configured glob and resolves to itself inside the
// worktree, and every git call that takes paths reads them literally, after `--` or from stdin.
import fs from 'node:fs';
import path from 'node:path';
import { globProblem } from './config.ts';
import { exists, resolveWorktreePaths } from './paths.ts';
import { inSpec } from './scope.ts';
import type { Config, Job } from './types.ts';
import { readText, run } from './util.ts';
import { commandTemplate, runCommand } from './worktree.ts';

export type Strategy = 'merge' | 'rebase';

/** Usable config, or why the configured globs can't be used (with the entries that can, to match against). */
export type GeneratedConfig = { globs: string[]; command: string } | { error: string; globs: string[] };

/** `worktrees.generated` / `generatedBy` as integrate uses them; null when nothing is configured. */
export function generatedConfig(config: Config): GeneratedConfig | null {
  const raw: unknown = config.worktrees?.generated;
  if (raw == null || (Array.isArray(raw) && !raw.length)) return null;
  if (!Array.isArray(raw)) return { error: `worktrees.generated must be a list (got ${JSON.stringify(raw)})`, globs: [] };
  const globs = raw.filter((g): g is string => globProblem(g) === null);
  const bad = raw.map(globProblem).find((p) => p !== null);
  if (bad) return { error: bad, globs };
  const command = config.worktrees.generatedBy;
  if (typeof command !== 'string' || !command) return { error: 'worktrees.generatedBy is not set', globs };
  return { globs, command };
}

/** A conflicted name Forge may hand to git and fs: no option-like start, and it resolves to itself inside the worktree. */
function safePath(worktree: string, p: string): boolean {
  if (!p || p.startsWith('-')) return false;
  try {
    return resolveWorktreePaths(worktree, [p])[0] === p;
  } catch {
    return false;
  }
}

/** Splits conflicted paths into generated ones Forge can rebuild and the rest, keeping git's order. */
export function partitionConflicts(worktree: string, conflicts: string[], globs: string[]): { generated: string[]; other: string[] } {
  const generated: string[] = [];
  const other: string[] = [];
  for (const p of conflicts) (globs.length && inSpec(p, globs) && safePath(worktree, p) ? generated : other).push(p);
  return { generated, other };
}

/** Glob-matching, validated paths from a NUL-separated git listing, deduped (unmerged entries repeat per stage). */
export function generatedPaths(worktree: string, zlist: string, globs: string[]): string[] {
  return [...new Set(zlist.split('\0').filter(Boolean))].filter((p) => inSpec(p, globs) && safePath(worktree, p));
}

/**
 * Why `job.worktree` is not a place to run the regenerate command, or null. It must be a worktree
 * root other than the main checkout, on the job's branch: `symbolic-ref` mid-merge, and the
 * rebase's `head-name` mid-rebase (HEAD is detached then).
 */
export function jobWorktreeProblem(root: string, job: Pick<Job, 'id' | 'worktree' | 'branch'>): string | null {
  if (!job.worktree || !exists(job.worktree)) return `job ${job.id} has no worktree`;
  if (!job.branch) return `job ${job.id} has no branch`;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const cwd = real(job.worktree);
  const main = real(root);
  if (!cwd) return `job ${job.id}'s worktree does not resolve`;
  if (cwd === main) return `the job's worktree is the main checkout (${cwd})`;
  const toplevel = (dir: string) => {
    const r = run('git', ['rev-parse', '--show-toplevel'], { cwd: dir, allowFail: true });
    return r.ok ? real(r.stdout.trim()) : null;
  };
  const top = toplevel(cwd);
  if (top !== null && main !== null && top === toplevel(main)) return `the job's worktree is the main checkout (${cwd})`;
  if (top !== cwd) return `${cwd} is not the root of a git worktree`;
  const gitPath = (p: string) => {
    const r = run('git', ['rev-parse', '--git-path', p], { cwd, allowFail: true });
    return r.ok ? path.resolve(cwd, r.stdout.trim()) : null;
  };
  const rebaseDir = ['rebase-merge', 'rebase-apply'].map(gitPath).find((d): d is string => d !== null && exists(d));
  if (rebaseDir) {
    const head = readText(path.join(rebaseDir, 'head-name')).trim();
    if (head !== `refs/heads/${job.branch}`) return `the rebase in ${cwd} is on ${JSON.stringify(head.slice(0, 200))}, not the job's branch ${job.branch}`;
    return null;
  }
  const branch = run('git', ['symbolic-ref', '--short', '-q', 'HEAD'], { cwd, allowFail: true }).stdout.trim();
  if (branch !== job.branch) return `the worktree is on ${branch ? JSON.stringify(branch.slice(0, 200)) : 'a detached HEAD'}, not the job's branch ${job.branch}`;
  return null;
}

/** Literal paths over stdin, so no name is ever argv and a long list can't hit the argv limit. */
function gitPaths(cwd: string, args: string[], paths: string[], o: { allowFail?: boolean } = {}): ReturnType<typeof run> {
  return run('git', ['--literal-pathspecs', ...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { cwd, input: paths.join('\0'), allowFail: o.allowFail });
}

/**
 * Writes the base branch's side of each (validated) conflicted path: stage 3 (`--theirs`) in a merge,
 * stage 2 (`--ours`) in a rebase. A path the base deleted is deleted. `stage` also marks them resolved.
 */
export function takeBaseSide(cwd: string, strategy: Strategy, paths: string[], o: { stage: boolean }): void {
  if (!paths.length) return;
  const baseStage = strategy === 'merge' ? '3' : '2';
  const want = new Set(paths);
  const withBase = new Set<string>();
  for (const entry of run('git', ['ls-files', '-u', '-z'], { cwd }).stdout.split('\0')) {
    // `<mode> <object> <stage>\t<path>`
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const p = entry.slice(tab + 1);
    if (want.has(p) && entry.slice(0, tab).split(' ')[2] === baseStage) withBase.add(p);
  }
  const keep = paths.filter((p) => withBase.has(p));
  if (keep.length) gitPaths(cwd, ['checkout', strategy === 'merge' ? '--theirs' : '--ours'], keep);
  for (const p of paths) if (!withBase.has(p)) fs.rmSync(path.join(cwd, p), { force: true });
  if (o.stage) gitPaths(cwd, ['add', '-A'], paths);
}

/** Stages every glob-matching path the worktree has, tracked or new, so output the build added or deleted is committed too. */
export function stageGenerated(cwd: string, globs: string[]): string[] {
  const files = generatedPaths(cwd, run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd }).stdout, globs);
  if (files.length) gitPaths(cwd, ['add', '-A'], files);
  return files;
}

/** Why the regenerate command can't run for this job, before anything is written: the guard and an unset command. */
export function regenerateProblem(root: string, config: Config, job: Job, gen: GeneratedConfig): string | null {
  if ('error' in gen) return gen.error;
  const problem = jobWorktreeProblem(root, job);
  if (problem) return `refusing to regenerate: ${problem}`;
  if (!commandTemplate(config, job, gen.command)) return `commands.${gen.command} is not configured (worktrees.generatedBy)`;
  return null;
}

/** Runs `generatedBy` in the job's worktree and stages its output. Returns null, or why it failed (with the build's tail). */
export function rebuild(root: string, config: Config, job: Job, gen: GeneratedConfig): string | null {
  const problem = regenerateProblem(root, config, job, gen);
  if (problem || 'error' in gen) return problem ?? 'worktrees.generated is invalid';
  const r = runCommand(root, config, job.id, gen.command, { label: 'integrate-regenerate', tail: 20 });
  if (!r.ok) return `commands.${gen.command} exited ${r.exit} (log ${r.log})\n${r.tail}`;
  stageGenerated(job.worktree!, gen.globs);
  return null;
}

/**
 * Puts glob-matching paths back the way git left them after a regeneration that didn't finish:
 * still-unmerged ones get their conflict back (`checkout -m`), other tracked ones are restored from
 * the index (which is HEAD after an abort) and untracked ones (new build output) are deleted.
 */
export function cleanGenerated(cwd: string, globs: string[]): void {
  const status = run('git', ['-c', 'core.quotepath=off', 'status', '--porcelain', '-z', '--untracked-files=all'], { cwd }).stdout.split('\0');
  const conflicted: string[] = [];
  const tracked: string[] = [];
  for (let i = 0; i < status.length; i++) {
    const entry = status[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    // A rename or copy is followed by its source path in the next field.
    if (/[RC]/.test(xy)) i++;
    if (!inSpec(p, globs) || !safePath(cwd, p)) continue;
    if (xy === '??') fs.rmSync(path.join(cwd, p), { force: true });
    else if (/U/.test(xy) || xy === 'AA' || xy === 'DD') conflicted.push(p);
    else tracked.push(p);
  }
  // One at a time: git refuses the whole batch when one path (a rename/rename side) has no merge to recreate.
  for (const p of conflicted) gitPaths(cwd, ['checkout', '-m'], [p], { allowFail: true });
  if (tracked.length) gitPaths(cwd, ['checkout', '-q'], tracked, { allowFail: true });
}
