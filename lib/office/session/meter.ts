// The supervisor's meter for one session: each result's cost, as a delta against a baseline held per spawn,
// appended to the scope's meter file (lib/engine/metrics/meter.ts), then enforced. A job scope runs the budget
// checkpoint `session-meter`; the inbox and the office stop at their daemon.dailyUsd cap (the assistant foremen share
// the office's, summed), and when a meter it sums can't be read the cap can't be checked, so they stop too. claude reports its cost itself, so a session's own
// reporting never moves what is enforced (docs/architecture/daemon-security.md).
import crypto from 'node:crypto';
import { enforceBudget } from '#engine/metrics/budget.ts';
import { appendMeter, lastMeterCum, METER_VERSION, meterDelta, meterTodayUsd, readMeter, readMeterChecked } from '#engine/metrics/meter.ts';
import type { MeterCum, MeterRecord } from '#engine/metrics/meter.ts';
import { INBOX_SCOPE, MAX_ASSISTANTS, OFFICE_SCOPE, assistantScope, isAssistantScope, validJobId } from '#core/job/requests.ts';
import type { ClaudeEvent } from '#integrations/claude/types.ts';
import type { SessionCore } from './contract.ts';
import type { Config } from '#core/types.ts';

/** How a result's check stops its session: the stopSelf arguments. */
export interface MeterStop {
  message: string;
  reason: 'budget' | 'daily-cap';
  announce: 'daily-cap' | null;
  /** A job parked on its budget stays wanted, so its held requests start it again once a person clears it. */
  keepWanted: boolean;
}

type StopSelf = (message: string, reason: string, announce: 'failed-turns' | 'daily-cap' | null, keepWanted: boolean) => void;

const ZERO: MeterCum = { usd: 0, models: {} };

/** The inbox's or office's daemon.dailyUsd cap, or null for none (a job scope, a null key, or caps off). */
function dailyCap(c: Config, name: 'inbox' | 'office'): number | null {
  const d: unknown = c?.daemon?.dailyUsd;
  if (!d || typeof d !== 'object') return null;
  const v = (d as Record<string, unknown>)[name];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The meter files one shared scope's cap sums: the inbox's own, or for the office family (the office and every
 * assistant foreman) all 17, so running more assistants never multiplies daemon.dailyUsd.office.
 */
function capScopes(shared: 'inbox' | 'office'): string[] {
  return shared === 'inbox' ? [INBOX_SCOPE] : [OFFICE_SCOPE, ...Array.from({ length: MAX_ASSISTANTS }, (_, i) => assistantScope(i + 1))];
}

export function createMeter(core: SessionCore, stop: StopSelf) {
  const { root, scope } = core;
  const shared = scope === INBOX_SCOPE ? 'inbox' : scope === OFFICE_SCOPE || isAssistantScope(scope) ? 'office' : null;
  let spawnId: string | null = null;
  /** The cumulative this spawn measures from: zero for a fresh conversation, null until a rebase. */
  let base: MeterCum | null = ZERO;
  /** The read problem a job scope's log last named, so each is said once. */
  let unread: string | null = null;

  /** The stop text when a shared scope's cap can't be checked, so it fails closed. */
  function unchecked(problem: string, fix: string): string {
    return `meter: ${problem}, so the ${shared} session's daily cap (daemon.dailyUsd.${shared}) can't be checked and it stops; ${fix}, then start it again`;
  }

  /**
   * Why a shared scope with a cap may not spend now, else null: its metered spend today reached the cap
   * (announced), or its meter can't be read, so the cap can't be checked and it fails closed.
   */
  function overCap(c: Config, at: number): { message: string; announce: 'daily-cap' | null } | null {
    const cap = shared ? dailyCap(c, shared) : null;
    if (cap === null || !shared) return null;
    let spent = 0;
    for (const s of capScopes(shared)) {
      // A missing file reads as no records; any one that can't be read fails the whole family closed.
      const { records, problem } = readMeterChecked(root, s);
      if (problem) return { message: unchecked(problem, 'fix or move the file aside'), announce: null };
      spent += meterTodayUsd(records, at);
    }
    if (spent < cap) return null;
    const day = new Date(at).toISOString().slice(0, 10);
    const who = shared === 'office' ? 'the office session and its assistant foremen' : 'the inbox session';
    return { message: `daemon stopped: ${who} spent $${spent.toFixed(2)} of the $${cap.toFixed(2)} daily cap (daemon.dailyUsd.${shared}) on ${day} (UTC); start it again after midnight UTC, or raise the cap`, announce: 'daily-cap' };
  }

  /** A shared scope's stop after a result, from overCap. Never throws: a check that throws stops it too (fails closed). */
  function sharedStop(at: number): MeterStop | null {
    try {
      const over = overCap(core.ctx.config(), at);
      return over ? { ...over, reason: 'daily-cap', keepWanted: false } : null;
    } catch (err) {
      return { message: unchecked((err as Error).message, 'fix the cause'), reason: 'daily-cap', announce: null, keepWanted: false };
    }
  }

  /** A job's meter that can't be read leaves its budget checks on the reported figure: its log says so once per problem. */
  function sayUnread(): void {
    const { problem } = readMeterChecked(root, scope);
    if (problem && problem !== unread) core.logEvent('error', { message: `meter: ${problem}; this job's budget checks fall back to its reported spend` });
    unread = problem;
  }

  return {
    /**
     * A spawn is starting. A shared scope at its daily cap, or whose meter can't be read, is refused (null).
     * Otherwise the spawn's baseline is set, and its usd returned for the --max-budget-usd cap: claude's
     * cumulative already includes it on a resume.
     */
    spawned(c: Config, resume: boolean): number | null {
      const over = overCap(c, Date.now());
      if (over) {
        stop(over.message, 'daily-cap', null, false);
        return null;
      }
      spawnId = crypto.randomUUID();
      base = resume ? lastMeterCum(readMeter(root, scope), core.info.sessionId) : ZERO;
      return base?.usd ?? 0;
    },

    /** Meters one result and says whether the session must stop. Never throws: a record that can't be written logs an error. */
    result(e: Extract<ClaudeEvent, { kind: 'turn-ended' }>, turn: number): MeterStop | null {
      if (!e.cost) return null;
      const at = Date.now();
      let rec: MeterRecord;
      try {
        rec = { v: METER_VERSION, ts: new Date(at).toISOString(), scope, sessionId: core.info.sessionId ?? null, spawnId: (spawnId ??= crypto.randomUUID()), turn, ...meterDelta(base, e.cost) };
        appendMeter(root, rec);
      } catch (err) {
        core.logEvent('error', { message: `meter: ${(err as Error).message}` });
        // A job's record that can't be written never stops its session; a shared scope's cap check fails closed.
        return shared ? sharedStop(at) : null;
      }
      base = rec.cum;
      core.logEvent('meter', { usd: rec.usd, tokens: rec.tokens, turn });
      if (shared) return sharedStop(at);
      try {
        if (!validJobId(scope)) return null;
        sayUnread();
        const r = enforceBudget(root, core.ctx.config(), scope, 'session-meter');
        if (!r?.stopped) return null;
        const message = `daemon stopped: this job's metered spend is over its budget (${r.reason}); raise or acknowledge the job's budget in the dashboard, then approve the budget gate`;
        return { message, reason: 'budget', announce: null, keepWanted: true };
      } catch (err) {
        core.logEvent('error', { message: `meter: ${(err as Error).message}` });
        return null;
      }
    },
  };
}
