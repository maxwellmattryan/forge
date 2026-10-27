// The recompute of a job's components from its committed diff, run by `forge verify` before anything
// reads a component, so the commands verify picks follow what the build changed rather than the spec's estimate.
import { componentsForChanges } from '#core/config/components.ts';
import { logEvent, updateJob } from '#core/job/store.ts';
import type { Config, Job, LoadedJob } from '#core/types.ts';
import { committedChanges, resolveBase } from '../pipeline/scope.ts';

/** One of verify's member worktrees, with the HEAD this run records for it. */
export interface ComponentMember {
  member: Pick<Job['repos'][number], 'repo' | 'base' | 'verifyOnly'>;
  worktree: string;
  head: string;
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * Recomputes `job.components` from the committed changes since the merge base: the root worktree up to
 * `sha` and each pushed member up to its head, each matched against its own repo's components. Writes
 * `componentsFromDiff` and `components`, and logs one `components` event when `components` changes.
 * Returns the job unchanged, writing nothing, with no components configured, an empty diff everywhere
 * (the declared list stands) or a diff that can't be computed: the protected step reports that, and
 * verify never fails because of the recompute.
 */
export function recordComponents(root: string, config: Config, job: LoadedJob, sha: string, members: readonly ComponentMember[]): LoadedJob {
  if (!config.components?.length || !job.worktree) return job;
  const changed = new Map<string | null, string[]>();
  try {
    changed.set(null, committedChanges(job.worktree, resolveBase(job.worktree, config, job, sha).mergeBase, sha));
    for (const m of members) {
      if (m.member.verifyOnly || typeof m.member.repo !== 'string') continue;
      changed.set(m.member.repo, committedChanges(m.worktree, resolveBase(m.worktree, config, { base: m.member.base }, m.head).mergeBase, m.head));
    }
  } catch {
    return job;
  }
  if ([...changed.values()].every((files) => !files.length)) return job;
  const next = componentsForChanges(config, changed);
  // Read under the job's lock, so the event compares against what the write replaced.
  let before: string[] = [];
  let declared: string[] | null = null;
  const updated = updateJob(root, job.id, (j) => {
    before = j.components;
    declared = j.componentsDeclared;
    j.componentsFromDiff = next;
    j.components = next;
  });
  if (!same(before, next)) {
    const estimate: string[] = declared ?? [];
    logEvent(root, job.id, 'components', {
      declared,
      components: next,
      added: next.filter((n) => !estimate.includes(n)),
      dropped: estimate.filter((n) => !next.includes(n)),
      sha,
    });
  }
  return updated;
}
