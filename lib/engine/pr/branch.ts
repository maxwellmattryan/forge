// The job branch against its remote and its base: the base refresh before the secret scan, the base's
// tip for a merge's checks, the push of the checked commit, pulling a PR head that moved, and
// bringing the branch up to date with its base (merge or rebase, generated-path rebuilds, and
// finishing a kept conflict).
import path from 'node:path';
import { loadJob, logEvent } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import type { Config, Job } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { readText } from '#core/os/fs.ts';
import type { RunResult } from '#core/os/process.ts';
import { SAFE_REF } from '#core/text.ts';
import { git, gitEnv, historyEnv } from '#integrations/git/runner.ts';
import { isSha } from './delta.ts';
import { FULL_SHA } from '../release/interim.ts';
import { cleanGenerated, generatedConfig, generatedPaths, partitionConflicts, rebuild, regenerateProblem, takeBaseSide } from '../workspace/regenerate.ts';
import type { Strategy } from '../workspace/regenerate.ts';
import { commandTemplate } from '../workspace/run.ts';

/**
 * Re-reads the base branch from the repository `forge pr open` pushes to, into its remote-tracking
 * ref, so a ref moved from the worktree (`git update-ref`) can't shrink the range the scan reads. The
 * fetch goes to the push URL: repo config can split `url` from `pushurl`, and a fetch from anywhere
 * else would vouch for a base the push never meets. Git applies one `url.*.insteadOf` rewrite per
 * resolution, so the push URL is resolved once more as a fetch would (`ls-remote --get-url`): a
 * chained rewrite would send the fetch to another repository. Under `block` a rewrite like that, or a
 * fetch that fails, refuses the open (the push needs the network anyway); under `warn` the fetch is
 * skipped and the scan runs against the ref as it is.
 */
export function refreshBase(job: Job, config: Config, mode: 'block' | 'warn'): void {
  const remote = config.git.remote;
  // Callers check the worktree first.
  const fetched = fetchBase(job.worktree!, config, job.base, `refs/remotes/${remote}/${job.base}`);
  // `=== true`, not truthiness: the tests' loose type check narrows the union only on the literal.
  if (fetched.ok === true || mode !== 'block') return;
  const fix = fetched.rewritten ? `fix the git config's insteadOf/pushInsteadOf entries` : `check that ${remote}'s push remote is reachable`;
  throw new ForgeError(`can't refresh base ${job.base} from the push remote before the secret scan (${fetched.why}); forge pr open won't push a range it can't scan against the real base: ${fix}, then retry forge pr open ${job.id}`, 'external', `forge pr open ${job.id}`);
}

/** fetchBase's answer: it worked, or why not (`rewritten`: a url.*.insteadOf chain sent the fetch elsewhere). */
type BaseFetch = { ok: true } | { ok: false; why: string; rewritten?: true };

/** Force-fetches `base` from the remote's push URL into `dest` (a fully qualified ref); never throws. */
function fetchBase(cwd: string, config: Config, base: string | null | undefined, dest: string): BaseFetch {
  const remote = config.git.remote;
  if (typeof base !== 'string' || !SAFE_REF.test(base) || !SAFE_REF.test(String(remote))) return { ok: false, why: 'unsafe base or remote name' };
  const url = git(cwd, ['remote', 'get-url', '--push', remote], { allowFail: true });
  const pushUrl = url.stdout.trim().split('\n')[0] ?? '';
  // A leading - would read as an option; the push would use the same value, so nothing is lost.
  if (!url.ok || !pushUrl || pushUrl.startsWith('-')) return { ok: false, why: `no usable push URL for ${remote}` };
  // Needs no network. Neither URL is ever printed: a URL can carry credentials.
  const resolved = git(cwd, ['ls-remote', '--get-url', '--', pushUrl], { allowFail: true });
  if (!resolved.ok || (resolved.stdout.trim().split('\n')[0] ?? '').trim() !== pushUrl) {
    return { ok: false, why: `${remote}'s push URL is rewritten again by url.*.insteadOf, so a fetch would reach another repository`, rewritten: true };
  }
  const fetched = git(cwd, ['-c', 'protocol.ext.allow=never', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--', pushUrl, `+refs/heads/${base}:${dest}`], { write: true, allowFail: true });
  // Only the exit status: git's stderr can quote the URL, and a URL can carry credentials.
  return fetched.ok ? { ok: true } : { ok: false, why: `git fetch from ${remote}'s push URL exited ${fetched.status}` };
}

/**
 * The commit `base` is at on the push remote right now, for a merge's checks: fetched into a
 * Forge-private ref, read, and the ref dropped. A merge never compares against `refs/remotes/<remote>/<base>`,
 * which the job's worktree shares with the clone and can move (`git update-ref`): a forged base would
 * hide a commit the approver never saw behind an empty diff. Throws when it can't be read.
 */
export function remoteBaseTip(cwd: string, config: Config, id: string, base: string | null | undefined): string {
  const dest = `refs/forge/merge-base/${id}`;
  if (!SAFE_REF.test(id)) throw new ForgeError(`${JSON.stringify(id.slice(0, 80))} is not a job id`);
  const fetched = fetchBase(cwd, config, base, dest);
  if (fetched.ok === false) throw new ForgeError(`can't re-read base ${String(base).slice(0, 80)} from ${config.git.remote}'s push remote (${fetched.why})`, 'external');
  const tip = git(cwd, ['rev-parse', '--verify', '--quiet', `${dest}^{commit}`], { env: historyEnv(), allowFail: true }).stdout.trim();
  git(cwd, ['update-ref', '-d', dest], { write: true, allowFail: true });
  if (!FULL_SHA.test(tip)) throw new ForgeError(`base ${String(base).slice(0, 80)} on ${config.git.remote} is not a commit`, 'external');
  return tip;
}

export function pushBranch(job: Job, config: Config, sha: string, opts: { force?: boolean } = {}): void {
  if (!FULL_SHA.test(sha)) throw new ForgeError(`refusing to push ${JSON.stringify(String(sha).slice(0, 80))}: not a commit id`);
  const args = ['push', '-u', config.git.remote, `${sha}:refs/heads/${job.branch}`];
  if (opts.force) args.splice(1, 0, '--force-with-lease');
  // Callers check the worktree first.
  git(job.worktree!, args, { write: true });
}

/** What pullPrHead did: `none` when the worktree already holds the PR's head, null when there was nothing to pull from. */
export type PrHeadPull = { pulled: 'none' | 'fast-forward' | 'merge' | 'conflicts'; head: string } | null;

/**
 * Before a rework round on an open PR, the PR branch's remote head joins the worktree, so a GitHub
 * "Update branch" or a person's push is built on rather than rejected by the next push. Fast-forward
 * when only the remote moved, a merge when both did; a conflicting merge is aborted, never left half
 * done for the builder. Only the job's own branch is fetched, from the configured remote: never a fork.
 */
export function pullPrHead(root: string, config: Config, job: Job): PrHeadPull {
  if (job.pr?.state !== 'OPEN' || !job.worktree || !exists(job.worktree) || !job.branch || !SAFE_REF.test(job.branch)) return null;
  const cwd = job.worktree;
  if (git(cwd, ['status', '--porcelain']).stdout.trim()) return null;
  const tracking = `refs/remotes/${config.git.remote}/${job.branch}`;
  if (!git(cwd, ['fetch', '--quiet', '--no-tags', config.git.remote, `+refs/heads/${job.branch}:${tracking}`], { write: true, allowFail: true }).ok) return null;
  const head = git(cwd, ['rev-parse', '--verify', '--quiet', `${tracking}^{commit}`], { allowFail: true }).stdout.trim();
  if (!isSha(head)) return null;
  const ancestor = (a: string, b: string) => git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).ok;
  let pulled: NonNullable<PrHeadPull>['pulled'];
  if (ancestor(head, 'HEAD')) pulled = 'none';
  else if (ancestor('HEAD', head)) pulled = git(cwd, ['merge', '--ff-only', head], { write: true, allowFail: true }).ok ? 'fast-forward' : 'conflicts';
  else if (git(cwd, ['merge', '--no-edit', head], { write: true, allowFail: true }).ok) pulled = 'merge';
  else {
    git(cwd, ['merge', '--abort'], { write: true, allowFail: true });
    pulled = 'conflicts';
  }
  if (pulled !== 'none') logEvent(root, job.id, 'pr-head-pulled', { head, pulled });
  return { pulled, head };
}

// ---- forge integrate: bringing the job branch up to date with its base ----

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
