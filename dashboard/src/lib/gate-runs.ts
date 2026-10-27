// The Foreman popover's gate activity list, its pure half: /api/state's DaemonPoolState.gates as rows, newest first
// (the 50 kept), and the list's header. Every field is read defensively and a malformed run is dropped: the runs are
// seeded from the gate log, a local file, and a reason is model or policy text, so a row holds only plain strings
// the component renders as text. Tokens are the headline; dollars go only in a title.
import { obj } from './daemon.ts';
import { GATE_LABEL } from './labels.ts';
import { GATE_RUN_OUTCOMES, OFFICE_GATES } from './types.ts';
import type { GateClass, GateRunOutcome } from './types.ts';
import { ago, tokensShort, usd } from './util.ts';

/** What a row's chip says: how the run ended, or that it runs. */
export type GateRunShown = GateRunOutcome | 'running';
export type GateRunTone = 'ok' | 'info' | 'warn' | 'bad' | 'you' | 'muted' | 'live';

/** A decision is ok or info, a gate left for a person is you, a refusal or a shelve warns, a failure is bad, the rest muted. */
export const GATE_RUN_TONE: Record<GateRunShown, GateRunTone> = {
  approve: 'ok',
  revise: 'info',
  rework: 'info',
  'no-action': 'muted',
  escalated: 'you',
  reserved: 'you',
  refused: 'warn',
  stale: 'muted',
  requeued: 'muted',
  failed: 'bad',
  shelved: 'warn',
  running: 'live',
};

export interface GateRunRow {
  /** The gate request's id: the row's key. */
  key: string;
  gate: GateClass;
  label: string;
  /** The job, which opens its drawer, or null for a milestone draft's run (then `mandate`, shown as text). */
  job: string | null;
  mandate: string | null;
  outcome: GateRunShown;
  tone: GateRunTone;
  reason: string | null;
  /** When it started, as `ago`. */
  started: string;
  tokens: string;
  /** Its metered dollars, for the row's title only. */
  usd: string;
}

export interface GateRunsHeader {
  /** foreman.assistants.enabled (with foreman.enabled): false reads as off. */
  enabled: boolean;
  live: number;
  parallel: number;
  /** A daily-cap hold says why; a retry or limit hold says until when. */
  held: { kind: 'cap'; message: string } | { kind: 'until'; until: string } | null;
}

const KEPT = 50;
const REASON_MAX = 200;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MANDATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isGate = (v: unknown): v is GateClass => (OFFICE_GATES as readonly unknown[]).includes(v);
const isOutcome = (v: unknown): v is GateRunOutcome => (GATE_RUN_OUTCOMES as readonly unknown[]).includes(v);
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const time = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

/** One run as a row, or null when any field it needs is missing or malformed. */
function row(raw: unknown, now: number): GateRunRow | null {
  const r = obj(raw);
  const key = text(r.request, 80);
  const startedAt = time(r.startedAt);
  if (key === null || startedAt === null || !isGate(r.gate)) return null;
  const job = typeof r.job === 'string' && JOB_ID.test(r.job) ? r.job : null;
  const mandate = typeof r.mandate === 'string' && MANDATE_ID.test(r.mandate) ? r.mandate : null;
  if ((job === null) === (mandate === null)) return null;
  const outcome: GateRunShown | null = r.status === 'running' ? 'running' : r.status === 'done' && isOutcome(r.outcome) ? r.outcome : null;
  const tokens = count(r.tokens);
  const dollars = count(r.usd);
  if (outcome === null || tokens === null || dollars === null) return null;
  return {
    key,
    gate: r.gate,
    label: GATE_LABEL[r.gate],
    job,
    mandate,
    outcome,
    tone: GATE_RUN_TONE[outcome],
    reason: text(r.reason, REASON_MAX),
    started: ago(startedAt, now),
    tokens: tokensShort(tokens),
    usd: usd(dollars),
  };
}

/** The runs as rows, newest first by start (the server's order, re-checked), at most the 50 kept, malformed ones dropped. */
export function gateRunRows(gates: unknown, now: number = Date.now()): GateRunRow[] {
  const runs = obj(gates).runs;
  if (!Array.isArray(runs)) return [];
  const out: { row: GateRunRow; at: number }[] = [];
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

/** The list's header: whether runs are on, live of parallel, and a hold. An older server with no `gates` reads as off. */
export function gateRunsHeader(gates: unknown): GateRunsHeader {
  const g = obj(gates);
  const held = obj(g.held);
  const until = time(held.until);
  const message = text(held.message, 300);
  return {
    enabled: g.enabled === true,
    live: count(g.live) ?? 0,
    parallel: count(g.parallel) ?? 0,
    held: held.reason === 'daily-cap' && message !== null ? { kind: 'cap', message } : (held.reason === 'retry' || held.reason === 'limit') && until !== null ? { kind: 'until', until } : null,
  };
}
