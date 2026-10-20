// The status bar's pure half: its Foreman and daemon indicators, the facts strip's drop order, the model label, the
// connection state, the prompt announcement, and the rule of the sidebar's "New job or command" input. No DOM and no svelte import, so node:test can pin them.
// Model strings come from config.yml and the roster, session state from session output: all plain strings, rendered as text.
import { obj, poolModel, sessionPill } from './daemon.ts';
import type { Pill, PoolInput } from './daemon.ts';
import { activeSessions } from './live.ts';
import { pendingPrompts } from './permissions.ts';
import { OFFICE_SCOPE } from './types.ts';
import type { Roster } from './types.ts';

// ---------- models ----------

export interface ModelLabel {
  /** The configured value as written; `inherit` for a blank or non-string one. */
  raw: string;
  /** The display name ("Opus 5.5"), the raw value when no family is recognised, or null for the session's own model. */
  label: string | null;
  provider: string | null;
  /** The value was `inherit` and resolved through the orchestrator. */
  inherited: boolean;
}

const FAMILY = /(opus|sonnet|haiku|fable)/i;
/** A version after the family: `-5-5`, `-4-5-20250929`, `-4-20250514`. A group of 8+ digits is a date, never a version. */
const VERSION_AFTER = /-(\d+)(?:-(\d+))?/g;
/** Old ids put the version before the family: `claude-3-5-haiku-20241022`. */
const VERSION_BEFORE = /claude-(\d+)(?:-(\d))?-/;
const isInherit = (v: string): boolean => v.toLowerCase() === 'inherit';
const clean = (v: unknown): string => (typeof v === 'string' && v.trim() ? v.trim() : 'inherit');

function versionAfter(s: string): string | null {
  for (const m of s.matchAll(VERSION_AFTER)) {
    if (m[1].length >= 8) continue;
    return m[2] !== undefined && m[2].length <= 2 ? `${m[1]}.${m[2]}` : m[1];
  }
  return null;
}

/**
 * A model value's display label. `inherit` resolves once through `models.orchestrator`; pass no `models` for the
 * orchestrator itself. An alias shows only its family ("Opus"): Claude Code, not Forge, maps an alias to a version.
 */
export function modelLabel(raw: unknown, models?: Record<string, unknown> | null): ModelLabel {
  const value = clean(raw);
  let resolved = value;
  let inherited = false;
  if (isInherit(value) && models) {
    resolved = clean(models.orchestrator);
    inherited = true;
  }
  if (isInherit(resolved)) return { raw: value, label: null, provider: 'Anthropic', inherited };
  const fam = FAMILY.exec(resolved);
  if (!fam) return { raw: value, label: resolved, provider: null, inherited };
  const name = fam[1][0].toUpperCase() + fam[1].slice(1).toLowerCase();
  const at = fam.index;
  let version = versionAfter(resolved.slice(at + fam[1].length));
  if (version === null) {
    const old = VERSION_BEFORE.exec(resolved.slice(0, at));
    if (old) version = old[2] !== undefined ? `${old[1]}.${old[2]}` : old[1];
  }
  return { raw: value, label: version === null ? name : `${name} ${version}`, provider: 'Anthropic', inherited };
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The bar's model: the builder's label, plus an effort only when it is a known level. */
export function modelSummary(models: Record<string, unknown> | null | undefined, effort?: unknown): ModelLabel & { effort: string | null } {
  const m = obj(models);
  return { ...modelLabel(m.builder, m), effort: typeof effort === 'string' && EFFORT_LEVELS.includes(effort) ? effort : null };
}

/** The summary as one line: provider, label (or `session` for the session's own model), effort, joined by ` · `. */
export function summaryText(s: ModelLabel & { effort: string | null }, session: string, effortText: (effort: string) => string = (e) => e): string {
  return [s.provider, s.label ?? session, s.effort === null ? null : effortText(s.effort)].filter((x): x is string => x !== null).join(' · ');
}

/** Roles in the order Forge runs them; any other key of `models` follows, sorted. */
export const ROLE_ORDER = ['orchestrator', 'planner', 'spec-writer', 'designer', 'builder', 'reviewer', 'approver', 'integrator', 'retro', 'judge'] as const;

export function roleRows(models: Record<string, unknown> | null | undefined): { role: string; model: ModelLabel }[] {
  const m = obj(models);
  const keys = Object.keys(m);
  const known: string[] = ROLE_ORDER.filter((r) => keys.includes(r));
  const rest = keys.filter((k) => !known.includes(k)).sort();
  return [...known, ...rest].map((role) => ({ role, model: modelLabel(m[role], role === 'orchestrator' ? null : m) }));
}

export function reviewerRows(roster: Pick<Roster, 'reviewers'> | null | undefined, models: Record<string, unknown> | null | undefined): { name: string; model: ModelLabel; always: boolean }[] {
  const list = Array.isArray(roster?.reviewers) ? roster.reviewers : [];
  return list.map((r) => ({ name: String(obj(r).name ?? ''), model: modelLabel(obj(r).model, obj(models)), always: obj(r).always === true }));
}

// ---------- connection ----------

export type ConnectionState = 'connecting' | 'live' | 'offline' | 'outdated';
export type ConnectionTone = 'muted' | 'ok' | 'bad' | 'warn';

/** No poll finished yet, the last one failed, the server speaks a newer API, or all is well. */
export function connectionState({ online, apiVersion, clientApi }: { online: boolean | null; apiVersion: number | null | undefined; clientApi: number }): { state: ConnectionState; tone: ConnectionTone } {
  if (online === null) return { state: 'connecting', tone: 'muted' };
  if (!online) return { state: 'offline', tone: 'bad' };
  if (typeof apiVersion === 'number' && apiVersion > clientApi) return { state: 'outdated', tone: 'warn' };
  return { state: 'live', tone: 'ok' };
}

// ---------- daemon and foreman ----------

/** Off, the bar still shows `Daemon 0/<cap>`: cap is daemon.maxConcurrent, 0 when the server sends none. */
export type DaemonIndicator = { off: true; active: false; cap: number } | { off: false; pill: Pill; live: number; cap: number; active: boolean };

/** The Foreman (the office session) supervises the pool, so the bar always shows it, even while it or the daemon is off. */
export type ForemanIndicator = { on: false } | { on: true; daemon: boolean; pill: Pill; active: boolean; prompts: number };

export interface BarModel {
  daemon: DaemonIndicator;
  /** On exactly while foreman.enabled; an older server that sends no flag reads as off. */
  foreman: ForemanIndicator;
  /** Pending permission prompts across the whole pool, the office's included: the Needs-you badge counts them. */
  prompts: number;
  held: number;
  waiting: number;
}

/** The left cluster, built only from poolModel, activeSessions and pendingPrompts, so the bar and the board agree. */
export function barModel(pool: PoolInput, opts: { pending: boolean }): BarModel {
  const m = poolModel(pool, opts);
  const prompts = pendingPrompts(pool ?? null).length;
  const p = obj(pool);
  const office = p.office ?? null;
  const foreman: ForemanIndicator =
    p.foreman === true
      ? { on: true, daemon: m !== null, pill: sessionPill(office), active: obj(office).status === 'busy', prompts: pendingPrompts(pool ?? null, OFFICE_SCOPE).length }
      : { on: false };
  return {
    daemon: m ? { off: false, pill: m.pill, live: m.live, cap: m.cap, active: activeSessions(pool).count > 0 } : { off: true, active: false, cap: Number(p.maxConcurrent) || 0 },
    foreman,
    prompts,
    held: m ? m.held.length : 0,
    waiting: m ? m.waiting.length : 0,
  };
}

/** What the bar's live region says: the new count, only when it rose to a non-zero value; silence when it fell or held. */
export const promptAnnouncement = (prev: number, next: number): number | null => (next > prev && next > 0 ? next : null);

// ---------- the facts strip ----------

/** What the facts strip drops as it runs short: its one fact is FOCUS, whose word goes (the focused job's id stays). */
export const FACTS_DROP = ['focusWord'] as const;
export type FactsPart = (typeof FACTS_DROP)[number];
export const FACTS_MAX = FACTS_DROP.length;

/** Which facts a fit level hides: level n hides the first n of FACTS_DROP. */
export function factsHidden(level: number): Record<FactsPart, boolean> {
  const n = Math.max(0, Math.min(Math.floor(level), FACTS_MAX));
  return { focusWord: n >= 1 };
}

// ---------- the sidebar's command input ----------

export interface InlineInputEvent {
  type: 'input' | 'compositionend' | 'keydown';
  value: string;
  key?: string;
  composing: boolean;
}

/**
 * `open` hands the input to the palette: typed or pasted text (never mid-composition), composed text, or Enter or
 * ArrowDown on an empty input. Focus and clicks alone open nothing.
 */
export function inlineInputAction(e: InlineInputEvent): 'open' | null {
  if (e.type === 'input') return !e.composing && e.value.length > 0 ? 'open' : null;
  if (e.type === 'compositionend') return e.value.length > 0 ? 'open' : null;
  if (e.composing || e.value.length > 0) return null;
  return e.key === 'Enter' || e.key === 'ArrowDown' ? 'open' : null;
}
