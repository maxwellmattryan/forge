// The supervisor's meter for one session: each result's cost, as a delta against a baseline held per spawn,
// appended to the scope's meter file (lib/engine/metrics/meter.ts), then enforced. A job scope runs the budget
// checkpoint `session-meter`; the inbox and the office stop at their daemon.dailyUsd cap. claude reports its
// cost itself, so a session's own reporting never moves what is enforced (docs/architecture/daemon-security.md).
import crypto from 'node:crypto';
import { enforceBudget } from '#engine/metrics/budget.ts';
import { appendMeter, lastMeterCum, METER_VERSION, meterDelta, meterTodayUsd, readMeter } from '#engine/metrics/meter.ts';
import type { MeterCum, MeterRecord } from '#engine/metrics/meter.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, validJobId } from '#core/job/requests.ts';
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

export function createMeter(core: SessionCore, stop: StopSelf) {
  const { root, scope } = core;
  const shared = scope === INBOX_SCOPE ? 'inbox' : scope === OFFICE_SCOPE ? 'office' : null;
  let spawnId: string | null = null;
  /** The cumulative this spawn measures from: zero for a fresh conversation, null until a rebase. */
  let base: MeterCum | null = ZERO;

  /** The stop text once a shared scope's metered spend today reaches its cap, else null. */
  function overCap(c: Config, at: number): string | null {
    const cap = shared ? dailyCap(c, shared) : null;
    if (cap === null) return null;
    const spent = meterTodayUsd(readMeter(root, scope), at);
    if (spent < cap) return null;
    const day = new Date(at).toISOString().slice(0, 10);
    return `daemon stopped: the ${shared} session spent $${spent.toFixed(2)} of its $${cap.toFixed(2)} daily cap (daemon.dailyUsd.${shared}) on ${day} (UTC); start it again after midnight UTC, or raise the cap`;
  }

  return {
    /**
     * A spawn is starting. A shared scope at its daily cap is refused (null). Otherwise the spawn's baseline is
     * set, and its usd returned for the --max-budget-usd cap: claude's cumulative already includes it on a resume.
     */
    spawned(c: Config, resume: boolean): number | null {
      const capped = overCap(c, Date.now());
      if (capped) {
        stop(capped, 'daily-cap', null, false);
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
        return null;
      }
      base = rec.cum;
      core.logEvent('meter', { usd: rec.usd, tokens: rec.tokens, turn });
      try {
        if (shared) {
          const capped = overCap(core.ctx.config(), at);
          return capped ? { message: capped, reason: 'daily-cap', announce: 'daily-cap', keepWanted: false } : null;
        }
        if (!validJobId(scope)) return null;
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
