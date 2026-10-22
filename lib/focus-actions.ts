// The one write path for focus, shared by `forge focus` and POST /api/focus (as config-set.ts is
// for config): validation, the locked write and the events. Kept apart from lib/focus.ts, which
// jobs.ts imports, so this module may import jobs.ts without a cycle.
import fs from 'node:fs';
import path from 'node:path';
import { currentActor } from './actor.ts';
import { CheckoutError, applyCheckout, failureLine, readCheckoutRecord, undoCheckout, withCheckoutLock } from './checkout.ts';
import type { CheckoutReport, StepRunner } from './checkout.ts';
import { loadConfig } from './core/config/load.ts';
import { containedWorktree } from './editor.ts';
import { isActive, jobDir, loadJob, logEvent, logHumanEvent } from './core/job/store.ts';
import { readFocusRecord, resolveFocus, setFocus } from './core/job/focus.ts';
import { validJobId } from './core/job/requests.ts';
import { ensureEnvironment } from './environment-lifecycle.ts';
import type { Config, EnvironmentUpResult, EventActor, FocusResponse, Job } from './core/types.ts';
import { ForgeError } from './core/errors.ts';
import { runCommandAsync } from './worktree.ts';

/** Refused because the job is done or cancelled: a `usage` error the server answers with 409. */
export class InactiveJobError extends ForgeError {}

const jobExists = (root: string, id: string): boolean => validJobId(id) && fs.existsSync(path.join(jobDir(root, id), 'job.json'));

/** The current focus by the same rule everywhere: a live record naming an active job. */
export function currentFocus(root: string): FocusResponse['focus'] {
  return resolveFocus(readFocusRecord(root), (id) => (jobExists(root, id) ? loadJob(root, id) : null));
}

/** Moves the focus record and logs the events, as focus did before checkout steps existed. */
function moveFocus(root: string, job: Job | null, from: 'cli' | 'dashboard', actor?: EventActor): FocusResponse {
  if (job === null) {
    const { previous, changed } = setFocus(root, null);
    if (changed && previous && jobExists(root, previous)) logHumanEvent(root, previous, 'unfocus', { reason: 'cleared' }, actor ?? currentActor(root));
    return { focus: null, previous };
  }
  const { previous, changed } = setFocus(root, job.id);
  if (changed) {
    logHumanEvent(root, job.id, 'focus', { from }, actor ?? currentActor(root));
    if (previous && jobExists(root, previous)) logEvent(root, previous, 'unfocus', { reason: 'switched' });
  }
  return { focus: currentFocus(root), previous };
}

/** `forge run`'s runner for checkout steps: the same command, cwd, env, log file and event. */
const stepRunner =
  (root: string, config: Config): StepRunner =>
  (id, name, label) =>
    runCommandAsync(root, config, id, name, { label, tail: 20 });

/**
 * Focuses `id`, or clears focus for null. Re-focusing the focused job changes and logs nothing.
 * With `checkout` steps configured, the recorded job's steps are undone and the new job's applied
 * first (lib/checkout.ts); a failing step rolls back, re-applies the previous job's steps and
 * leaves focus where it was. Those steps may run configured commands. Once focus has moved onto a
 * job, its environment's backing services start (ensure up, lib/environment-lifecycle.ts); a failure there
 * never undoes the focus and reaches the caller only through `onEnvironment`, so the reply's shape
 * stays the same. No background process is started or signalled.
 */
export async function focusJob(
  root: string,
  id: string | null,
  from: 'cli' | 'dashboard',
  actor?: EventActor,
  opts: { config?: Config; run?: StepRunner; onEnvironment?: (r: EnvironmentUpResult) => void } = {},
): Promise<FocusResponse> {
  const config = opts.config ?? loadConfig(root).config;
  const out = await moveFocusWithSteps(root, id, from, actor, { ...opts, config });
  if (out.focus && config.backing?.length) {
    const env = ensureEnvironment(root, config, loadJob(root, out.focus.id), 'focus');
    opts.onEnvironment?.(env);
  }
  return out;
}

async function moveFocusWithSteps(root: string, id: string | null, from: 'cli' | 'dashboard', actor: EventActor | undefined, opts: { config?: Config; run?: StepRunner }): Promise<FocusResponse> {
  let job: Job | null = null;
  if (id !== null) {
    if (!validJobId(id)) throw new ForgeError(`invalid job id ${JSON.stringify(id).slice(0, 80)}`, 'usage');
    job = loadJob(root, id);
    if (!isActive(job)) throw new InactiveJobError(`job ${job.id} is ${job.state}; only an active job can be focused`, 'usage');
  }
  const config = opts.config ?? loadConfig(root).config;
  if (!(config.checkout ?? []).length && !readCheckoutRecord(root)) return moveFocus(root, job, from, actor);
  const run = opts.run ?? stepRunner(root, config);
  return withCheckoutLock(root, async () => {
    const record = readCheckoutRecord(root);
    // Already checked out: re-focusing is a no-op, as it is without steps.
    if (job !== null && record?.job === job.id) return moveFocus(root, job, from, actor);
    const undone = record ? await undoCheckout(root, config, run) : null;
    const applied = job ? await applyCheckout(root, config, job, run) : { ok: true, results: [] };
    const report: CheckoutReport = { undone: undone?.results ?? [], applied: applied.results, ...(undone ? { job: undone.job } : {}) };
    if (!applied.ok) {
      // Best effort: the job focus stays on gets its steps back, when it still can.
      const prev = undone && jobExists(root, undone.job) ? loadJob(root, undone.job) : null;
      if (prev && isActive(prev) && containedWorktree(root, config, prev)) {
        try {
          await applyCheckout(root, config, prev, run);
        } catch {}
      }
      throw new CheckoutError(`${failureLine(applied.failed!)}; focus stays on ${currentFocus(root)?.id ?? 'no job'}`, report);
    }
    const out = moveFocus(root, job, from, actor);
    return undone || applied.results.length ? { ...out, checkout: report } : out;
  });
}
