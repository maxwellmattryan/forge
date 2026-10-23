// What a session answers for: whether its job's agents keep it, the reconciler's facts, and what its
// exit lets go (agents lost, lease, claimed requests).
import fs from 'node:fs';
import { defaults } from '#core/config/load.ts';
import { UUID } from '#core/job/session-files.ts';
import { expireLease, markAgentsLost, requeueOrphanedRequests } from '#core/job/store.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, validJobId } from '#core/job/requests.ts';
import type { SessionFacts } from '../reconcile.ts';
import { sessionAgents } from '../session-agents.ts';
import type { SessionCore } from './contract.ts';
import type { Config } from '#core/types.ts';

/** The summary an agent gets when its session's child exits under it. */
export const LOST_SUMMARY = 'lost: its daemon session ended';

export function createOwned(core: SessionCore) {
  const { root, scope, o } = core;
  const agents = (at?: number) => sessionAgents(root, scope, typeof core.info.sessionId === 'string' ? core.info.sessionId : null, at);

  function computeKept(): 'agents' | null {
    return core.child && core.status !== 'stopping' && agents().keeps ? 'agents' : null;
  }

  /**
   * The child is gone, so every agent it drove is too: marking them lost lets the next session's
   * step respawn or retry them instead of waiting on phantoms. Only agents of a job this session
   * owns (sessionAgents), so another driver's agents are never touched. Never throws: an exit
   * must finish whatever job.json says.
   */
  function loseAgents(): void {
    if (!fs.existsSync(root)) return;
    try {
      const { running } = agents();
      if (!running.length) return;
      let cfg: Config;
      try {
        cfg = o.readConfig(root).config;
      } catch {
        cfg = defaults();
      }
      const roles = markAgentsLost(root, scope, running, LOST_SUMMARY, cfg, core.info.sessionId);
      if (roles.length) core.logEvent('agents-lost', { roles });
    } catch (e) {
      core.logEvent('error', { message: `marking agents lost: ${(e as Error).message}` });
    }
  }

  function keptBy(at = Date.now()): 'agents' | null {
    return agents(at).keeps ? 'agents' : null;
  }

  /** Every id this scope's sessions ran under: current, past and the one its child was spawned with. */
  function sessionIds(): string[] {
    const ids = [core.info.sessionId, core.info.spawnSessionId, ...(Array.isArray(core.info.pastSessionIds) ? core.info.pastSessionIds : [])];
    return [...new Set(ids.filter((s): s is string => typeof s === 'string' && UUID.test(s)))];
  }

  function facts(): SessionFacts {
    const background = core.child?._forge.background;
    return { ids: sessionIds(), status: core.status, background: typeof background === 'number' ? background : -1, idleSince: core.status === 'idle' ? core.lastResultAt : null };
  }

  /**
   * The child is gone, so nothing it held is driven: its job's lease expires when one of its ids
   * drives it (driver and epoch kept: anyone may now claim), and requests it claimed go back to
   * pending (lib/core/job/requests.ts requeueOrphans). Never throws: an exit must finish.
   */
  function letGo(reason: string): void {
    if (!fs.existsSync(root)) return;
    const ids = sessionIds();
    if (scope !== INBOX_SCOPE && scope !== OFFICE_SCOPE && validJobId(scope)) {
      try {
        const session = expireLease(root, scope, ids, reason);
        if (session) core.logEvent('lease-expired', { session, reason });
      } catch (e) {
        core.logEvent('error', { message: `expiring the lease: ${(e as Error).message}` });
      }
    }
    try {
      // No claim-age rule here: this session can't see which of the pool's others are mid-turn; the pool's reconciler can.
      const { requeued, rejected } = requeueOrphanedRequests(root, { exited: ids, byAge: false });
      if (requeued.length || rejected.length) core.logEvent('requeued', { requests: requeued.map((r) => r.id), rejected: rejected.map((r) => r.id) });
    } catch (e) {
      core.logEvent('error', { message: `requeueing claimed requests: ${(e as Error).message}` });
    }
  }

  return { agents, computeKept, keptBy, facts, loseAgents, letGo };
}
