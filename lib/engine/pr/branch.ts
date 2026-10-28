// The job branch against its remote: the base refresh before the secret scan, the base's tip for a
// merge's checks, the push of the checked commit, and pulling a PR head that moved.
import { logEvent } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import type { Config, Job } from '#core/types.ts';
import { ForgeError } from '#core/errors.ts';
import { SAFE_REF } from '#core/text.ts';
import { git, historyEnv } from '#integrations/git/runner.ts';
import { isSha } from './delta.ts';
import { FULL_SHA } from '../release/interim.ts';

/**
 * Re-reads the base branch from the repository `forge pr open` pushes to, into its remote-tracking
 * ref, so a ref moved from the worktree (`git update-ref`) can't shrink the range the scan reads. The
 * fetch goes to the push URL: repo config can split `url` from `pushurl`, and a fetch from anywhere
 * else would vouch for a base the push never meets. Git applies one `url.*.insteadOf` rewrite per
 * resolution, so the push URL is resolved once more as a fetch would (`ls-remote --get-url`): a
 * chained rewrite would send the fetch to another repository. Under `block` a rewrite like that, or a
 * fetch that fails, refuses the open (the push needs the network anyway); under `warn` the fetch is
 * skipped and the scan runs against the ref as it is. Returns whether the ref was refreshed, so the
 * held push (which reads the same ref for its CI diff) can refuse a base it could not re-read.
 */
export function refreshBase(job: Job, config: Config, mode: 'block' | 'warn'): boolean {
  const remote = config.git.remote;
  // Callers check the worktree first.
  const fetched = fetchBase(job.worktree!, config, job.base, `refs/remotes/${remote}/${job.base}`);
  // `=== true`, not truthiness: the tests' loose type check narrows the union only on the literal.
  if (fetched.ok === true) return true;
  if (mode !== 'block') return false;
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
