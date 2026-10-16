// The one write path for focus, shared by `forge focus` and POST /api/focus (as config-set.ts is
// for config): validation, the locked write and the events. Kept apart from lib/focus.ts, which
// jobs.ts imports, so this module may import jobs.ts without a cycle.
import fs from 'node:fs';
import path from 'node:path';
import { currentActor } from './actor.ts';
import { isActive, jobDir, loadJob, logEvent, logHumanEvent } from './jobs.ts';
import { readFocusRecord, resolveFocus, setFocus } from './focus.ts';
import { validJobId } from './requests.ts';
import type { EventActor, FocusResponse } from './types.ts';
import { ForgeError } from './util.ts';

/** Refused because the job is done or cancelled: a `usage` error the server answers with 409. */
export class InactiveJobError extends ForgeError {}

const jobExists = (root: string, id: string): boolean => validJobId(id) && fs.existsSync(path.join(jobDir(root, id), 'job.json'));

/** The current focus by the same rule everywhere: a live record naming an active job. */
export function currentFocus(root: string): FocusResponse['focus'] {
  return resolveFocus(readFocusRecord(root), (id) => (jobExists(root, id) ? loadJob(root, id) : null));
}

/**
 * Focuses `id`, or clears focus for null. Re-focusing the focused job changes and logs nothing.
 * Nothing here starts, stops or signals a process.
 */
export function focusJob(root: string, id: string | null, from: 'cli' | 'dashboard', actor?: EventActor): FocusResponse {
  if (id === null) {
    const { previous, changed } = setFocus(root, null);
    if (changed && previous && jobExists(root, previous)) logHumanEvent(root, previous, 'unfocus', { reason: 'cleared' }, actor ?? currentActor(root));
    return { focus: null, previous };
  }
  if (!validJobId(id)) throw new ForgeError(`invalid job id ${JSON.stringify(id).slice(0, 80)}`, 'usage');
  const job = loadJob(root, id);
  if (!isActive(job)) throw new InactiveJobError(`job ${job.id} is ${job.state}; only an active job can be focused`, 'usage');
  const { previous, changed } = setFocus(root, job.id);
  if (changed) {
    logHumanEvent(root, job.id, 'focus', { from }, actor ?? currentActor(root));
    if (previous && jobExists(root, previous)) logEvent(root, previous, 'unfocus', { reason: 'switched' });
  }
  return { focus: currentFocus(root), previous };
}
