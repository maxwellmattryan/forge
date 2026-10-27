// A closed mandate's retro: the Office pass's self-close and the owner's close (mandateWrite) each queue one
// `retro` request over the mandate's jobs, which the inbox turns into a retro job scoped to the mandate
// (`forge retro prepare --mandate`), its spec gate a human's like any retro. Once per mandate: no request
// when one for it exists in any status, checked under the retro queue's lock. The callers log the `retro`
// directive, since only they know the actor. docs/architecture/foreman.md › Director loop.
import { listArchived } from '#core/job/archive.ts';
import { enqueue, listRequests } from '#core/job/requests.ts';
import { listJobs } from '#core/job/store.ts';
import { withRetroQueueLock } from '#engine/evals/retro.ts';
import { foremanEnabled } from '#engine/pipeline/moves/foreman-gates.ts';
import type { Config } from '#core/types.ts';

/**
 * Queues mandate `id`'s retro: the request id and the count of its live and archived jobs, or null with
 * foreman.enabled off, for a mandate with no jobs, or when a `retro` request for it already exists.
 */
export function queueMandateRetro(root: string, config: Config, id: string): { request: string; jobs: number } | null {
  if (!foremanEnabled(config)) return null;
  const ids = new Set<string>();
  for (const j of listJobs(root)) if (j.mandate === id) ids.add(j.id);
  for (const a of listArchived(root)) if (a.job.mandate === id) ids.add(a.id);
  const jobs = ids.size;
  if (!jobs) return null;
  // The pass and an owner's close can overlap: the check and the enqueue happen under one lock.
  return withRetroQueueLock(root, () => {
    if (listRequests(root).some((r) => r.type === 'retro' && r.args?.mandate === id)) return null;
    const rec = enqueue(root, config, { type: 'retro', job: null, args: { mandate: id }, from: 'forge', text: `mandate ${id} closed: a retro over its ${jobs} jobs` });
    return { request: rec.id, jobs };
  });
}
