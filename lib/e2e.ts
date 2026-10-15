// Whether `forge verify` should run the e2e command: unit tests alone don't prove UI work, but a
// browser suite is too slow to run on every backend-only change.
// Must not import worktree.ts (it imports this module).
import { verifySteps } from './config.ts';
import { inSpec, resolveBase } from './scope.ts';
import type { Config, Job } from './types.ts';
import { run } from './util.ts';

const SHOWN = 3;

/**
 * Committed files changed since the merge-base that match the globs (`forge job scope` matching).
 */
export function uiChanges(cwd: string, config: Config, job: Job, globs: string[]): { files: string[] } | { error: string } {
  try {
    const { mergeBase } = resolveBase(cwd, config, job);
    const changed = run('git', ['diff', '--name-only', '--no-renames', mergeBase, 'HEAD'], { cwd }).stdout.split('\n').filter(Boolean);
    return { files: changed.filter((f) => inSpec(f, globs)) };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * `null` means e2e is not part of verify at all (no step, no section). `template` is the resolved `e2e` command.
 */
export function e2ePlan(config: Config, job: Job, template: string | null): null | { run: boolean; reason: string } {
  const policy: Partial<Config['verifyE2e']> = config.verifyE2e ?? {};
  // Listed in `verify` (in a group too), it already ran as a normal step; running it again would double a slow suite.
  if (verifySteps(config.verify).includes('e2e') || policy.when === 'never' || !template) return null;
  if (policy.when === 'always') return { run: true, reason: 'verifyE2e.when: always' };
  // verify runs this only for a job with a worktree.
  const ui = uiChanges(job.worktree!, config, job, policy.paths ?? []);
  if ('error' in ui) return { run: true, reason: /^base .* not found$/.test(ui.error) ? 'base not found; ran to be safe' : `UI check failed (${ui.error.split('\n')[0]}); ran to be safe` };
  if (!ui.files.length) return { run: false, reason: 'no UI paths changed' };
  const more = ui.files.length > SHOWN ? ` (+${ui.files.length - SHOWN} more)` : '';
  return { run: true, reason: `UI paths changed: ${ui.files.slice(0, SHOWN).join(', ')}${more}` };
}
