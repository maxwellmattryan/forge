// A session's two timers: the turn limit (daemon.turnTimeoutMinutes), which stops a hung turn, and
// the idle stop (daemon.idleStopMinutes), which stops a child nothing keeps; and its freshness: the inbox
// and the office start a new conversation at every spawn, and a job session whose turn's context passed
// daemon.freshAfterTokens stops at a safe boundary and starts its next spawn fresh. Each stops the child
// through the session's own kill, so its exit lets go of what it held (docs/architecture/daemon-runtime.md).
import { UUID } from '#core/job/session-files.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, sharedScope, validJobId } from '#core/job/requests.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';
import type { SessionAgents } from './owned.ts';
import type { DaemonChild, SessionCore } from './contract.ts';
import type { Config } from '#core/types.ts';

export function createTimers(core: SessionCore, agents: (at?: number) => SessionAgents) {
  const { ctx, o } = core;
  let idleTimer: NodeJS.Timeout | null = null;
  /** When the idle timer was last armed (spawn or result), in ms. */
  let idleSince = 0;
  /** Armed at each written turn, cleared by its result or the child's exit: daemon.turnTimeoutMinutes. */
  let turnTimer: NodeJS.Timeout | null = null;

  function clearTurn(): void {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
  }

  /**
   * A turn still busy past daemon.turnTimeoutMinutes (or turnTimeoutMs) is stopped: the exit lets go
   * of its agents, lease and claims, and the session stays wanted, so the pool respawns it for the
   * requeued work. setTimeout is monotonic, so a wall-clock jump never fires it.
   */
  function armTurn(proc: DaemonChild): void {
    clearTurn();
    let ms = o.turnTimeoutMs;
    if (ms === null) {
      let minutes: unknown;
      try {
        minutes = ctx.config().daemon?.turnTimeoutMinutes;
      } catch {}
      if (typeof minutes !== 'number' || !(minutes > 0)) return;
      ms = minutes * 60_000;
    }
    // setTimeout's own ceiling (about 24.8 days); a longer limit is no limit.
    if (!(ms > 0) || ms > 2 ** 31 - 1) return;
    const limit = ms;
    turnTimer = setTimeout(() => {
      turnTimer = null;
      if (core.closed || core.child !== proc || core.status !== 'busy') return;
      core.logEvent('turn-timeout', { minutes: Math.round((limit / 60_000) * 1000) / 1000 });
      void core.kill('stop', true, 'turn-timeout');
    }, limit);
    turnTimer.unref?.();
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function armIdle(c: Config): void {
    clearIdle();
    const minutes = c?.daemon?.idleStopMinutes;
    if (typeof minutes !== 'number' || !(minutes > 0)) return;
    idleSince = Date.now();
    idleAfter(minutes * 60_000, minutes * 60_000);
  }

  /**
   * The window counts from the later of the arming and the last agent end, and never runs out while
   * an agent keeps the session: an orchestrator waiting on background reviewers is idle, not done.
   */
  function idleAfter(delay: number, ms: number): void {
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (core.status !== 'idle' || !core.child) return;
      const a = agents();
      if (a.keeps) return idleAfter(ms, ms);
      const end = a.lastEndAt ? Date.parse(a.lastEndAt) : NaN;
      const left = Math.max(idleSince, Number.isFinite(end) ? end : 0) + ms - Date.now();
      // Never longer than the window, so no job.json time can push setTimeout past its 2^31-1 ms limit.
      if (left > 0) return idleAfter(Math.min(left, ms), ms);
      void core.kill('idle-stop', true, 'idle');
    }, delay);
    idleTimer.unref?.();
  }

  return { armTurn, clearTurn, armIdle, clearIdle };
}

/** When a session starts a new conversation instead of resuming its stored one. */
export function createFreshness(core: SessionCore, agents: (at?: number) => SessionAgents) {
  /** The current child's latest turn context; null before its first reading. */
  let context: number | null = null;
  /** The current child passed the threshold: it no longer resumes, and stops at the first safe boundary. */
  let due = false;

  /** Whether this spawn resumes the stored session; resets what was read about the last child. */
  function resumes(info: any): boolean {
    context = null;
    due = false;
    if (core.scope === INBOX_SCOPE || core.scope === OFFICE_SCOPE) return false;
    // The record is a local file anyone with repo access can edit; only a uuid may follow --resume.
    return Boolean(info.resumable && typeof info.sessionId === 'string' && UUID.test(info.sessionId));
  }

  /** The configured threshold, or null when it never rotates (null, unreadable or not a positive integer). */
  function threshold(): number | null {
    try {
      const t = core.ctx.config().daemon?.freshAfterTokens;
      return typeof t === 'number' && Number.isInteger(t) && t > 0 ? t : null;
    } catch {
      return null;
    }
  }

  /**
   * After a turn's other result handling: records its context, and a job session whose context passed the
   * threshold stops resuming (the record says so at once, so any later stop leaves the next spawn fresh) and
   * stops at the first safe boundary: idle, not kept by its job's agents, and no background task reported.
   * A due session that is not there yet waits for a later result (a background agent's end wakes it).
   */
  function result(e: Extract<ClaudeEvent, { kind: 'turn-ended' }>): void {
    const tokens = typeof e.context === 'number' ? e.context : null;
    if (tokens !== null) context = tokens;
    if (!validJobId(core.scope) || sharedScope(core.scope)) return;
    if (!due && tokens !== null) {
      const limit = threshold();
      if (limit !== null && tokens > limit) {
        due = true;
        core.info = { ...core.info, resumable: false };
        core.persist();
        core.logEvent('rotated', { tokens, threshold: limit });
        core.changed();
      }
    }
    const child = core.child;
    if (!due || core.closed || !child || core.status !== 'idle' || agents().keeps || (child.meta.background ?? 0) > 0) return;
    void core.kill('stop', true, 'rotate');
  }

  return { resumes, result, context: (): number | null => context };
}
