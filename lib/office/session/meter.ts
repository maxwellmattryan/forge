// The supervisor's meter for one session: each result's cost, as a delta against a baseline held per spawn,
// appended to the scope's meter file (lib/engine/metrics/meter.ts), then enforced. A job scope runs the budget
// checkpoint `session-meter`; the inbox, the office and the chats stop at their daemon.dailyUsd cap (forge dash's gate
// runs share the office's through officeCapRefusal and officeCapLeft, and every chat the project's one chat cap,
// summed), and when a meter it sums can't be read the cap can't be checked, so they stop too. claude reports its cost
// itself, so a session's own reporting never moves what is enforced (docs/architecture/daemon-security.md).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '#core/paths.ts';
import { enforceBudget } from '#engine/metrics/budget.ts';
import { appendMeter, lastMeterCum, METER_VERSION, meterDelta, meterTodayUsd, readMeter, readMeterChecked } from '#engine/metrics/meter.ts';
import type { MeterCum, MeterRecord } from '#engine/metrics/meter.ts';
import { GATES_SCOPE, INBOX_SCOPE, OFFICE_SCOPE, isChatScope, validJobId } from '#core/job/requests.ts';
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

type Family = 'inbox' | 'office' | 'chat';

/** The inbox's, office's or chats' daemon.dailyUsd cap, or null for none (a job scope, a null key, or caps off). */
function dailyCap(c: Config, name: Family): number | null {
  const d: unknown = c?.daemon?.dailyUsd;
  if (!d || typeof d !== 'object') return null;
  const v = (d as Record<string, unknown>)[name];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/**
 * The meter files one shared scope's cap sums: the inbox's own; for the office family the office's and the gate
 * runs' (`_gates`), so gate runs never multiply daemon.dailyUsd.office; and for a chat every chat's meter in `meter/`, so opening more chats never multiplies daemon.dailyUsd.chat. That dir
 * must be missing or a real directory (a link or file there throws, and the cap fails closed); only names
 * whose scope isChatScope accepts are kept.
 */
function capScopes(root: string, shared: Family): string[] {
  if (shared === 'inbox') return [INBOX_SCOPE];
  if (shared === 'office') return [OFFICE_SCOPE, GATES_SCOPE];
  const dir = path.join(paths(root).runtime, 'meter');
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`);
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl') && isChatScope(n.slice(0, -'.jsonl'.length)))
    .map((n) => n.slice(0, -'.jsonl'.length))
    .sort();
}

/** The stop text when a family's cap can't be checked, so it fails closed. */
function unchecked(shared: Family, problem: string, fix: string): string {
  const whose = shared === 'chat' ? "the chat sessions'" : `the ${shared} session's`;
  return `meter: ${problem}, so ${whose} daily cap (daemon.dailyUsd.${shared}) can't be checked and it stops; ${fix}, then start it again`;
}

/** A family's metered spend today, or why one of its meters can't be read. */
function familySpend(root: string, shared: Family, at: number): { spent: number } | { problem: string } {
  let scopes: string[];
  try {
    scopes = capScopes(root, shared);
  } catch (e) {
    return { problem: unchecked(shared, (e as Error).message, 'fix or move it aside') };
  }
  let spent = 0;
  for (const s of scopes) {
    // A missing file reads as no records; any one that can't be read fails the whole family closed.
    const { records, problem } = readMeterChecked(root, s);
    if (problem) return { problem: unchecked(shared, problem, 'fix or move the file aside') };
    spent += meterTodayUsd(records, at);
  }
  return { spent };
}

/**
 * Why a family with a cap may not spend now, else null: its metered spend today reached the cap
 * (announced), or one of its meters can't be read, so the cap can't be checked and it fails closed.
 */
function familyOverCap(root: string, c: Config, shared: Family, at: number): { message: string; announce: 'daily-cap' | null } | null {
  const cap = dailyCap(c, shared);
  if (cap === null) return null;
  const s = familySpend(root, shared, at);
  if ('problem' in s) return { message: s.problem, announce: null };
  if (s.spent < cap) return null;
  const day = new Date(at).toISOString().slice(0, 10);
  const who = shared === 'office' ? 'the office session and its gate runs' : shared === 'chat' ? 'the chat sessions' : 'the inbox session';
  return { message: `daemon stopped: ${who} spent $${s.spent.toFixed(2)} of the $${cap.toFixed(2)} daily cap (daemon.dailyUsd.${shared}) on ${day} (UTC); start it again after midnight UTC, or raise the cap`, announce: 'daily-cap' };
}

/**
 * Why the office family (the office session and forge dash's gate runs, which share daemon.dailyUsd.office) may not
 * spend at `at`, else null: today's metered spend reached the cap, or a meter it sums can't be read (fails closed).
 */
export function officeCapRefusal(root: string, c: Config, at: number): { message: string } | null {
  const over = familyOverCap(root, c, 'office', at);
  return over ? { message: over.message } : null;
}

/** What is left of daemon.dailyUsd.office today, for a gate run's --max-budget-usd; null when there is no cap, 0 when a meter can't be read. */
export function officeCapLeft(root: string, c: Config, at: number): number | null {
  const cap = dailyCap(c, 'office');
  if (cap === null) return null;
  const s = familySpend(root, 'office', at);
  return 'problem' in s ? 0 : Math.max(0, cap - s.spent);
}

export function createMeter(core: SessionCore, stop: StopSelf) {
  const { root, scope } = core;
  const shared: Family | null = scope === INBOX_SCOPE ? 'inbox' : scope === OFFICE_SCOPE ? 'office' : isChatScope(scope) ? 'chat' : null;
  let spawnId: string | null = null;
  /** The cumulative this spawn measures from: zero for a fresh conversation, null until a rebase. */
  let base: MeterCum | null = ZERO;
  /** The read problem a job scope's log last named, so each is said once. */
  let unread: string | null = null;

  const overCap = (c: Config, at: number) => (shared ? familyOverCap(root, c, shared, at) : null);

  /** A shared scope's stop after a result, from overCap. Never throws: a check that throws stops it too (fails closed). */
  function sharedStop(at: number): MeterStop | null {
    try {
      const over = overCap(core.ctx.config(), at);
      return over ? { ...over, reason: 'daily-cap', keepWanted: false } : null;
    } catch (err) {
      return { message: unchecked(shared!, (err as Error).message, 'fix the cause'), reason: 'daily-cap', announce: null, keepWanted: false };
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
