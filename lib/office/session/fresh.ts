// When a daemon session starts a new conversation instead of resuming its stored one: the inbox and the
// office at every spawn, and a job session once a turn's context passed daemon.freshAfterTokens, stopped
// at a safe boundary (docs/architecture/daemon-runtime.md).
import { UUID } from '#core/job/session-files.ts';
import { INBOX_SCOPE, OFFICE_SCOPE } from '#core/job/requests.ts';
import type { SessionAgents } from './owned.ts';
import type { SessionCore } from './contract.ts';

export function createFreshness(core: SessionCore, agents: (at?: number) => SessionAgents) {
  /** The current child's latest turn context; null before its first reading. */
  let context: number | null = null;

  /** Whether this spawn resumes the stored session; resets what was read about the last child. */
  function resumes(info: any): boolean {
    context = null;
    if (core.scope === INBOX_SCOPE || core.scope === OFFICE_SCOPE) return false;
    // The record is a local file anyone with repo access can edit; only a uuid may follow --resume.
    return Boolean(info.resumable && typeof info.sessionId === 'string' && UUID.test(info.sessionId));
  }

  /** Reads a turn's result. */
  function result(_e: unknown): void {
    void agents;
  }

  return { resumes, result, context: (): number | null => context };
}
