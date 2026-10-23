// Bringing a job branch up to date with its base: merge or rebase, generated-path rebuilds, and
// finishing a kept conflict.
import path from 'node:path';
import { loadJob, logEvent } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import type { Config } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { readText } from '#core/os/fs.ts';
import type { RunResult } from '#core/os/process.ts';
import { git, gitEnv } from '#integrations/git/runner.ts';
import { cleanGenerated, generatedConfig, generatedPaths, partitionConflicts, rebuild, regenerateProblem, takeBaseSide } from '../workspace/regenerate.ts';
import type { Strategy } from '../workspace/regenerate.ts';
import { commandTemplate } from '../workspace/run.ts';

/** What `forge integrate` returns. `regenerated` / `regenerateError` appear only when non-empty. */
export type IntegrateResult =
  | { ok: true; behind: number; strategy: Strategy | null; rewritten: boolean; regenerated?: string[] }
  | { ok: false; behind: number; strategy: Strategy; conflicts: string[]; inProgress: boolean; regenerated?: string[]; regenerateError?: string };

/** What `forge integrate --continue` returns. */
export type IntegrateContinueResult =
  | { ok: false; strategy: Strategy; conflicts: string[]; inProgress: true; regenerated?: string[]; regenerateError?: string }
  | { ok: true; strategy: Strategy; rewritten: boolean; regenerated?: string[] };

/** Unmerged paths, NUL-separated so odd names arrive as they are rather than C-quoted. */
function unmerged(cwd: string): string[] {
  return git(cwd, ['diff', '--name-only', '--diff-filter=U', '-z'], { allowFail: true }).stdout.split('\0').filter(Boolean);
}

const gitPathIn = (cwd: string, p: string): string => path.resolve(cwd, git(cwd, ['rev-parse', '--git-path', p]).stdout.trim());

/**
 * A rebase continues only while its todo holds nothing but the picks `integrate` wrote: an `exec`
 * line would run shell, so a session is never allowed `git rebase --continue` itself.
 */
function assertPlainTodo(cwd: string, id: string): void {
  const todo = gitPathIn(cwd, 'rebase-merge/git-rebase-todo');
  if (!exists(todo)) return;
  const odd = readText(todo)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^(pick|p)\s+[0-9a-f]{4,}\b/.test(l));
  if (odd.length) throw new ForgeError(`the rebase todo for ${id} has lines integrate never writes (${JSON.stringify(odd[0].slice(0, 80))}); run \`git rebase --abort\``);
}

/** Commits the merge or continues the rebase. A non-interactive editor: the session has no TTY, and a human's GIT_EDITOR could block. */
function advance(cwd: string, strategy: Strategy, id: string): RunResult {
  const env = { ...gitEnv(), GIT_EDITOR: 'true' };
  if (strategy === 'merge') return git(cwd, ['commit', '--no-edit'], { env, write: true, allowFail: true });
  assertPlainTodo(cwd, id);
  return git(cwd, ['rebase', '--continue'], { env, write: true, allowFail: true });
}

const advanceFailed = (strategy: Strategy, r: RunResult): ForgeError =>
  new ForgeError(`git ${strategy === 'rebase' ? 'rebase --continue' : 'commit --no-edit'} failed: ${(r.stderr || r.stdout).trim()}`, 'external');

const sortedList = (paths: Iterable<string>): string[] => [...new Set(paths)].sort();

/**
 * Brings the job branch up to date with base. On conflict it aborts cleanly and reports the
 * files, leaving the fix-now/defer/ask decision to the orchestrator and the repo's policy.
 * `keepConflicts` leaves the conflicted merge/rebase in place for the integrator instead, so it
 * never needs to start one itself (`git rebase` would allow `--exec`, so the daemon can't allow it).
 * Conflicts on `worktrees.generated` paths are rebuilt rather than reported (lib/engine/workspace/regenerate.ts):
 * when they are all a stop has, Forge finishes it and carries on, pick after pick in a rebase.
 */
export function integrate(root: string, config: Config, id: string, opts: { strategy?: Strategy; keepConflicts?: boolean } = {}): IntegrateResult {
  // `--strategy` names a git subcommand (`git <strategy> --abort`), so only the two known ones pass.
  if (opts.strategy !== undefined && opts.strategy !== 'merge' && opts.strategy !== 'rebase') throw new ForgeError(`--strategy must be merge or rebase, not ${JSON.stringify(String(opts.strategy).slice(0, 40))}`, 'usage');
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree`);
  const cwd = job.worktree;
  const dirty = git(cwd, ['status', '--porcelain']).stdout.trim();
  if (dirty) throw new ForgeError(`worktree for ${id} has uncommitted changes; the builder must commit first`);
  git(cwd, ['fetch', config.git.remote], { write: true, allowFail: true });
  const remoteBase = `${config.git.remote}/${job.base}`;
  // createJob always sets base.
  const upstream = git(cwd, ['rev-parse', '--verify', '--quiet', remoteBase], { allowFail: true }).ok ? remoteBase : job.base!;
  const behind = Number(git(cwd, ['rev-list', '--count', `HEAD..${upstream}`]).stdout.trim());
  if (behind === 0) {
    logEvent(root, id, 'integrated', { behind: 0 });
    return { ok: true, behind: 0, strategy: null, rewritten: false };
  }
  const strategy: Strategy = opts.strategy ?? config.pr.updateStrategy;
  // The two sides, so step can later tell what the resolution changed beyond git's own merge of them.
  const sides = { head: git(cwd, ['rev-parse', 'HEAD']).stdout.trim(), upstream: git(cwd, ['rev-parse', `${upstream}^{commit}`]).stdout.trim() };
  let attempt = strategy === 'rebase' ? git(cwd, ['rebase', upstream], { write: true, allowFail: true }) : git(cwd, ['merge', '--no-edit', upstream], { write: true, allowFail: true });
  const keep = Boolean(opts.keepConflicts);
  const abort = () => git(cwd, [strategy, '--abort'], { write: true, allowFail: true });
  const gen = generatedConfig(config);
  // Generated paths this run rebuilt and committed (or, kept, staged for --continue to rebuild).
  const regenerated = new Set<string>();
  const stopped = (conflicts: string[], extra: { regenerated?: string[]; regenerateError?: string }) => {
    if (!keep) abort();
    logEvent(root, id, 'integrate-conflicts', { strategy, conflicts, behind, ...extra, ...sides });
    return { ok: false as const, behind, strategy, conflicts, inProgress: keep, ...extra };
  };
  for (let first = true; !attempt.ok; first = false) {
    const conflicts = unmerged(cwd);
    if (!conflicts.length && !first) {
      if (!keep) abort();
      throw advanceFailed(strategy, attempt);
    }
    const part = gen ? partitionConflicts(cwd, conflicts, gen.globs) : { generated: [], other: conflicts };
    if (!part.generated.length) return stopped(conflicts, keep && regenerated.size ? { regenerated: sortedList(regenerated) } : {});
    // Can't regenerate: today's behaviour, with every unmerged path listed and the reason.
    const fallback = (regenerateError: string) => {
      const r = stopped(conflicts, { regenerateError });
      cleanGenerated(cwd, gen!.globs);
      return r;
    };
    const problem = regenerateProblem(root, config, job, gen!);
    if (problem) return fallback(problem);
    if (part.other.length) {
      // Mixed: only the real conflicts go to the integrator. Kept, the generated ones are staged
      // from the base side but not built, since the sources may still hold conflict markers.
      if (!keep) return stopped(part.other, { regenerated: sortedList(part.generated) });
      try {
        takeBaseSide(cwd, strategy, part.generated, { stage: true });
      } catch (e) {
        return fallback((e as Error).message);
      }
      return stopped(part.other, { regenerated: sortedList([...regenerated, ...part.generated]) });
    }
    let error: string | null;
    try {
      takeBaseSide(cwd, strategy, part.generated, { stage: false });
      error = rebuild(root, config, job, gen!);
    } catch (e) {
      error = (e as Error).message;
    }
    if (error !== null) return fallback(error);
    for (const p of part.generated) regenerated.add(p);
    try {
      attempt = advance(cwd, strategy, id);
    } catch (e) {
      if (!keep) abort();
      throw e;
    }
  }
  const extra = regenerated.size ? { regenerated: sortedList(regenerated) } : {};
  logEvent(root, id, 'integrated', { behind, strategy, ...extra });
  return { ok: true, behind, strategy, rewritten: strategy === 'rebase', ...extra };
}

/**
 * Finishes a merge or rebase `integrate --keep-conflicts` left in place, once the integrator has
 * staged its resolutions. Generated paths still unmerged are taken from the base side; once nothing
 * is unmerged, staged generated changes are rebuilt before the commit. A later rebase pick that
 * stops on generated paths only is rebuilt too; one with real conflicts comes back as conflicts.
 */
export function integrateContinue(root: string, config: Config, id: string): IntegrateContinueResult {
  const job = loadJob(root, id);
  if (!job.worktree || !exists(job.worktree)) throw new ForgeError(`job ${id} has no worktree`);
  const cwd = job.worktree;
  const rebasing = exists(gitPathIn(cwd, 'rebase-merge')) || exists(gitPathIn(cwd, 'rebase-apply'));
  const merging = !rebasing && git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { allowFail: true }).ok;
  if (!rebasing && !merging) throw new ForgeError(`no merge or rebase is in progress for ${id}`);
  const strategy: Strategy = rebasing ? 'rebase' : 'merge';
  const gen = generatedConfig(config);
  // Without a usable config and command, generated paths are ordinary conflicts, as before (integrate reported why).
  const usable = gen && !('error' in gen) && commandTemplate(config, job, gen.command) ? gen : null;
  const regenerated = new Set<string>();
  const extra = () => (regenerated.size ? { regenerated: sortedList(regenerated) } : {});
  for (;;) {
    const conflicts = unmerged(cwd);
    if (conflicts.length) {
      const part = usable ? partitionConflicts(cwd, conflicts, usable.globs) : { generated: [], other: conflicts };
      if (part.generated.length) {
        // The guard before any write: a job.worktree that isn't the job's gets nothing deleted or staged.
        const problem = regenerateProblem(root, config, job, usable!);
        if (problem) return { ok: false, strategy, conflicts, inProgress: true, regenerateError: problem };
        takeBaseSide(cwd, strategy, part.generated, { stage: true });
        for (const p of part.generated) regenerated.add(p);
      }
      if (part.other.length) return { ok: false, strategy, conflicts: part.other, inProgress: true, ...extra() };
    }
    if (usable) {
      const staged = git(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', 'HEAD']).stdout;
      const changed = generatedPaths(cwd, staged, usable.globs);
      if (changed.length) {
        const regenerateError = rebuild(root, config, job, usable);
        if (regenerateError !== null) return { ok: false, strategy, conflicts: [], inProgress: true, regenerateError };
        for (const p of changed) regenerated.add(p);
      }
    }
    const attempt = advance(cwd, strategy, id);
    if (attempt.ok) break;
    if (!unmerged(cwd).length) throw advanceFailed(strategy, attempt);
  }
  logEvent(root, id, 'integrated', { strategy, ...extra() });
  return { ok: true, strategy, rewritten: strategy === 'rebase', ...extra() };
}
