// The Office page's Office runs table, its pure half: /api/state's DaemonPoolState.office as rows, newest first (the
// 50 kept), and the table's header line. Every field is read defensively and a malformed run is dropped: a reason is
// CLI or model text, so a row holds only plain strings the component renders as text. Tokens are the headline;
// dollars go only in a title.
import { obj } from '../sessions/daemon.ts';
import { MANDATE_ID_SOURCE, OFFICE_RUN_OUTCOMES } from '../core/types.ts';
import type { OfficeRunOutcome } from '../core/types.ts';
import { ago, tokensShort, usd } from '../core/util.ts';
import type { GateRunTone } from './gate-runs.ts';

/** What a row's chip says: how the run ended, or that it runs. */
export type OfficeRunShown = OfficeRunOutcome | 'running';

/** A draft or a direct run done is ok, a stale or given-back one muted, a refusal warns, a failure is bad. */
export const OFFICE_RUN_TONE: Record<OfficeRunShown, GateRunTone> = {
  drafted: 'ok',
  directed: 'ok',
  stale: 'muted',
  requeued: 'muted',
  refused: 'warn',
  failed: 'bad',
  running: 'live',
};

export interface OfficeRunRow {
  /** The request's id: the row's key. */
  key: string;
  type: 'draft' | 'direct';
  /** A draft run's mandate; null for a direct run. */
  mandate: string | null;
  outcome: OfficeRunShown;
  tone: GateRunTone;
  reason: string | null;
  /** When it started, as `ago`. */
  started: string;
  tokens: string;
  /** Its metered dollars, for the row's title only. */
  usd: string;
}

export interface OfficeRunsHeader {
  /** daemon.enabled and foreman.enabled: false reads as off. */
  enabled: boolean;
  live: number;
  /** A daily-cap hold says why; a retry or limit hold says until when. */
  held: { kind: 'cap'; message: string } | { kind: 'until'; until: string } | null;
}

const KEPT = 50;
const REASON_MAX = 200;
const MANDATE_ID = new RegExp(MANDATE_ID_SOURCE);
const isOutcome = (v: unknown): v is OfficeRunOutcome => (OFFICE_RUN_OUTCOMES as readonly unknown[]).includes(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const time = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** One run as a row, or null when any field it needs is missing or malformed. */
function row(raw: unknown, now: number): OfficeRunRow | null {
  const r = obj(raw);
  const key = text(r.request, 80);
  const startedAt = time(r.startedAt);
  if (key === null || startedAt === null || (r.type !== 'draft' && r.type !== 'direct')) return null;
  // A draft run names its mandate; a direct run names none.
  const mandate = typeof r.mandate === 'string' && MANDATE_ID.test(r.mandate) ? r.mandate : null;
  if ((r.type === 'draft') !== (mandate !== null)) return null;
  const outcome: OfficeRunShown | null = r.status === 'running' ? 'running' : r.status === 'done' && isOutcome(r.outcome) ? r.outcome : null;
  const tokens = count(r.tokens);
  const dollars = count(r.usd);
  if (outcome === null || tokens === null || dollars === null) return null;
  return {
    key,
    type: r.type,
    mandate,
    outcome,
    tone: OFFICE_RUN_TONE[outcome],
    reason: text(r.reason, REASON_MAX),
    started: ago(startedAt, now),
    tokens: tokensShort(tokens),
    usd: usd(dollars),
  };
}

/** The runs as rows, newest first by start (the server's order, re-checked), at most the 50 kept, malformed ones dropped. */
export function officeRunRows(office: unknown, now: number = Date.now()): OfficeRunRow[] {
  const runs = obj(office).runs;
  if (!Array.isArray(runs)) return [];
  const out: { row: OfficeRunRow; at: number }[] = [];
  for (const raw of runs.slice(0, KEPT * 2)) {
    const r = row(raw, now);
    if (r) out.push({ row: r, at: Date.parse(obj(raw).startedAt as string) });
  }
  // A stable sort keeps the server's order among runs that started together.
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, KEPT)
    .map((x) => x.row);
}

/** The table's header: whether runs are on, the live count, and a hold. An older server's state for the retired office session reads as off. */
export function officeRunsHeader(office: unknown): OfficeRunsHeader {
  const o = obj(office);
  const held = obj(o.held);
  const until = time(held.until);
  const message = text(held.message, 300);
  return {
    enabled: o.enabled === true,
    live: count(o.live) ?? 0,
    held: held.reason === 'daily-cap' && message !== null ? { kind: 'cap', message } : (held.reason === 'retry' || held.reason === 'limit') && until !== null ? { kind: 'until', until } : null,
  };
}
