// What a session answers for: whether its job's agents keep it, the reconciler's facts, and the one
// release (lib/office/driver.ts releaseSession) its exit runs over every id it has had.
import { defaults } from '#core/config/load.ts';
import type { SessionFacts } from '../reconcile.ts';
import { recordIds, releaseSession } from '../driver.ts';
import { sessionAgents } from '../session-agents.ts';
import type { SessionCore } from './contract.ts';
import type { Config } from '#core/types.ts';

export function createOwned(core: SessionCore) {
  const { root, scope, o } = core;
  const agents = (at?: number) => sessionAgents(root, scope, recordIds(core.info), at);

  function computeKept(): 'agents' | null {
    return core.child && core.status !== 'stopping' && agents().keeps ? 'agents' : null;
  }

  function keptBy(at = Date.now()): 'agents' | null {
    return agents(at).keeps ? 'agents' : null;
  }

  function facts(): SessionFacts {
    const background = core.child?.meta.background;
    return { ids: recordIds(core.info), status: core.status, background: typeof background === 'number' ? background : -1, idleSince: core.status === 'idle' ? core.lastResultAt : null };
  }

  /**
   * The child is gone, so nothing it held is driven: every job one of its ids drives has its running
   * agents marked lost (the next session's step respawns or retries them instead of waiting on
   * phantoms) and its live lease expired, and requests it claimed go back to pending. No claim-age
   * rule: this session can't see which of the pool's others are mid-turn; the pool's reconciler can.
   * Never throws: an exit must finish.
   */
  function release(reason: string): void {
    let cfg: Config;
    try {
      cfg = o.readConfig(root).config;
    } catch {
      cfg = defaults();
    }
    const r = releaseSession(root, recordIds(core.info), { reason, config: cfg });
    for (const j of r.jobs) {
      if (j.lost.length) core.logEvent('agents-lost', { job: j.job, roles: j.lost });
      if (j.expired) core.logEvent('lease-expired', { job: j.job, session: j.expired, reason });
    }
    if (r.requeued.length || r.rejected.length) core.logEvent('requeued', { requests: r.requeued, rejected: r.rejected });
    for (const message of r.errors) core.logEvent('error', { message });
  }

  return { agents, computeKept, keptBy, facts, release };
}
