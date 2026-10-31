// Cancelling a lens run: a late verify failure under review.startAfter fast voids the round's lens runs,
// running or ended, so the next pass reviews again (`forge job agent <id> cancel`, step's RV13).
// A cancelled run is ignored, never killed: its late end only bills it (cancelledRunEnd in lib/core/job/lens.ts).
import { logEvent, updateJob, type Fence } from '#core/job/store.ts';
import { recordRun } from '#core/job/schema.ts';
import { now } from '#core/utils.ts';

/** The summary a running lens run is cancelled with. */
export const CANCELLED_SUMMARY = 'cancelled: verify failed while the panel reviewed';

/** `forge job agent <id> cancel`'s result: `changed` false for a role already cancelled, with no record, or from an earlier round. */
export interface CancelLensResult {
  role: string;
  status: string | null;
  wasRunning: boolean;
  changed: boolean;
}

/**
 * Marks `role`'s run of this round `cancelled`, under the job lock (and `fence`, when given): a running one ends
 * now with the fixed summary and a `cancelled` run, an ended one and its last run are relabelled. Then one
 * `agent-cancelled` event. A no-op writes nothing. The caller checks the role is `reviewer:<lens>`.
 */
export function cancelLensRun(root: string, id: string, role: string, fence?: Fence): CancelLensResult {
  const unchanged = new Error('nothing to cancel');
  let out: CancelLensResult = { role, status: null, wasRunning: false, changed: false };
  let round = 0;
  try {
    updateJob(
      root,
      id,
      (j) => {
        const a = Object.hasOwn(j.agents, role) ? j.agents[role] : undefined;
        out = { ...out, status: a?.status ?? null };
        // Thrown rather than returned, so a no-op leaves job.json untouched.
        if (!a || a.status === 'cancelled' || a.round !== j.round || !a.startedAt) throw unchanged;
        round = j.round;
        const wasRunning = a.status === 'running';
        a.status = 'cancelled';
        if (wasRunning) {
          a.endedAt = now();
          a.summary = CANCELLED_SUMMARY;
          recordRun(a, { wasRunning: true, at: a.endedAt, round: j.round, status: 'cancelled', model: a.model ?? null });
        } else {
          const last = Array.isArray(a.runHistory) ? a.runHistory.at(-1) : undefined;
          if (last) last.status = 'cancelled';
        }
        out = { role, status: 'cancelled', wasRunning, changed: true };
      },
      fence,
    );
  } catch (e) {
    if (e === unchanged) return out;
    throw e;
  }
  logEvent(root, id, 'agent-cancelled', { role, round, wasRunning: out.wasRunning });
  return out;
}
