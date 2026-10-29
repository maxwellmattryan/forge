// The job drawer: its tabs and width with their keyboard rules, the file it shows, timeline lines and the verdict
// matrix, as plain functions node:test can pin. No DOM access.
import type { Job, JobEvent } from '../core/types.ts';
import type { Tone } from './state.ts';

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const s = (v: unknown): string => String(v ?? '');

/** The drawer's tabs, in strip order. */
export const DRAWER_TABS = ['thread', 'log', 'agents', 'files', 'timeline', 'details'] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number];

/** Opening a job lands on its conversation. */
export const DEFAULT_DRAWER_TAB: DrawerTab = 'thread';

/** The tab Left/Right (wrapping), Home or End moves to from `current`, or null for other keys. The strip is horizontal, so Up/Down do nothing. */
export function moveDrawerTab(current: DrawerTab, key: string): DrawerTab | null {
  const n = DRAWER_TABS.length;
  const i = Math.max(0, DRAWER_TABS.indexOf(current));
  if (key === 'ArrowLeft') return DRAWER_TABS[(i - 1 + n) % n];
  if (key === 'ArrowRight') return DRAWER_TABS[(i + 1) % n];
  if (key === 'Home') return DRAWER_TABS[0];
  if (key === 'End') return DRAWER_TABS[n - 1];
  return null;
}

// ---------- the job drawer over the view ----------

/** The narrowest the job drawer gets, px. */
export const PANE_MIN = 360;
/** The drawer's width until the viewer drags it. */
export const PANE_DEFAULT = 640;
/** The sidebar's default width, px: it mirrors `--size-sidebar` in style.css, so the drawer never covers the sidebar column. */
export const PANE_GUTTER = 236;

/**
 * The widest the drawer gets in a window `viewport` px wide (innerWidth): it stops at the sidebar's edge, `gutter` px
 * from the left (the sidebar's current width; the default width when not given).
 */
export const paneMax = (viewport: number, gutter = PANE_GUTTER): number => Math.max(PANE_MIN, Math.floor(viewport - gutter));

/** `w` within [PANE_MIN, paneMax(viewport, gutter)], whole px; a stored value that is not a number takes the default. */
export function clampPaneWidth(w: number, viewport: number, gutter = PANE_GUTTER): number {
  const width = Number.isFinite(w) ? w : PANE_DEFAULT;
  return Math.round(Math.min(paneMax(viewport, gutter), Math.max(PANE_MIN, width)));
}

/**
 * The drawer width after a key on the separator, or null for other keys. The separator is the drawer's left edge, so
 * Left widens it and Right narrows it: 16px a press, 64px with Shift. Home is the minimum, End the maximum.
 */
export function paneKey(w: number, key: string, shift: boolean, viewport: number, gutter = PANE_GUTTER): number | null {
  const step = shift ? 64 : 16;
  if (key === 'ArrowLeft') return clampPaneWidth(w + step, viewport, gutter);
  if (key === 'ArrowRight') return clampPaneWidth(w - step, viewport, gutter);
  if (key === 'Home') return clampPaneWidth(PANE_MIN, viewport, gutter);
  if (key === 'End') return paneMax(viewport, gutter);
  return null;
}

// ---------- files, timeline and verdicts ----------

const DRAWER_PREF = ['spec.md', 'decision.md', 'build.md', 'request.md'];

/** The file the drawer shows: the current one, its renamed match, or the preferred default. */
export function pickDrawerFile(files: string[], current: string | null): string | null {
  if (!current) return DRAWER_PREF.find((f) => files.includes(f)) ?? files[0] ?? null;
  if (!files.includes(current)) return files.find((f) => f.startsWith(current)) ?? current;
  return current;
}

/** A timeline row's detail as text around an optional bold part. */
export interface EventDetail {
  pre: string;
  bold: string | null;
  post: string;
}

export function eventDetail(e: JobEvent, fmt: { tokens: (n: number | null | undefined) => string; dur: (ms: number | null | undefined) => string }): EventDetail {
  const plain = (pre: string): EventDetail => ({ pre, bold: null, post: '' });
  if (e.type === 'transition') {
    const from = obj(e.from);
    const to = obj(e.to);
    return { pre: `${s(from.stage)}/${s(from.state)} → `, bold: `${s(to.stage)}/${s(to.state)}`, post: `${to.waitingOn ? ` (${s(to.waitingOn)})` : ''}${e.reason ? ` · ${s(e.reason)}` : ''}` };
  }
  if (e.type?.startsWith('agent-'))
    return plain(`${s(e.role)} ${e.model ? `(${s(e.model)})` : ''}${e.usage ? ` · ${fmt.tokens(e.usage.totalTokens)} tok` : ''}${e.summary ? ` · ${s(e.summary)}` : ''}`);
  if (e.type === 'command') return plain(`${s(e.name)} ${e.ok ? '✓' : `✗ exit ${s(e.exit)}`} · ${fmt.dur(e.durationMs)}`);
  if (e.type === 'note') return plain(s(e.text));
  if (e.type === 'human') return { pre: '', bold: s(e.action), post: e.note ? ` · ${s(e.note)}` : '' };
  // The actor has its own "by …" on the row, so the raw fallback leaves it out.
  return plain(JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['v', 'ts', 'type', 'actor'].includes(k)))).slice(0, 240));
}

/** An event the foreman recorded (a decision, a hand-off, a senior pass, a shelve): the timeline labels it so a reader can tell it from a person's. */
export const isForemanEvent = (e: Partial<JobEvent> | null | undefined): boolean => e?.actor?.source === 'foreman';

/** An event a chat session recorded (a CLI action the owner asked for in a chat): the timeline marks it with a `chat` chip. */
export const isChatEvent = (e: Partial<JobEvent> | null | undefined): boolean => e?.actor?.source === 'chat';

/**
 * The "by {login}" a timeline row shows for a person's action: the login (or `unknown` when none
 * resolved) and its source for the tooltip. Null for the foreman, whose rows carry their own chip,
 * and for events without an actor.
 */
export function actorLabel(e: Partial<JobEvent> | null | undefined): { login: string; source: string } | null {
  const a = e?.actor;
  if (!a || typeof a !== 'object' || a.source === 'foreman') return null;
  return { login: typeof a.login === 'string' && a.login ? a.login : 'unknown', source: String(a.source) };
}

/** Rounds of the drawer's verify/verdict matrix and the reviewer columns, or null when there is nothing to show. */
export function verdictMatrix(j: Partial<Job>, verifiers: Record<number, VerifierRound> = {}): { rounds: number[]; reviewers: string[] } | null {
  const verdicts = j.verdicts ?? {};
  const verify = j.verify ?? {};
  const rounds = Object.keys(verdicts).map(Number).sort((a, b) => a - b);
  if (!rounds.length && !Object.keys(verify).length && !Object.keys(verifiers).length) return null;
  const reviewers = [...new Set([...(j.reviewers ?? []), ...rounds.flatMap((r) => Object.keys(verdicts[r] ?? {}))])];
  return { rounds: [...new Set([...rounds, ...Object.keys(verify).map(Number), ...Object.keys(verifiers).map(Number)])].sort((a, b) => a - b), reviewers };
}

/** A round's verifiers result for the drawer's matrix: its latest `verifiers` record event. */
export interface VerifierRound {
  outcome: 'PASS' | 'CHANGES';
  blocking: number;
  warned: number;
}

const count = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

/** Each round's latest well-formed `verifiers` record; `run` events and malformed records are skipped. Empty: no column. */
export function verifierRounds(events: readonly JobEvent[] | null | undefined): Record<number, VerifierRound> {
  const out: Record<number, VerifierRound> = {};
  for (const e of events ?? []) {
    if (!e || e.type !== 'verifiers' || e.phase !== 'record') continue;
    const round = count(e.round);
    const blocking = count(e.blocking);
    const warned = count(e.warned);
    if (round === null || round < 1 || blocking === null || warned === null || (e.outcome !== 'PASS' && e.outcome !== 'CHANGES')) continue;
    out[round] = { outcome: e.outcome, blocking, warned };
  }
  return out;
}

/** The chip tone for a round's verifiers: bad for CHANGES, warn for a PASS with warnings, ok otherwise. */
export function verifierTone(v: VerifierRound): Tone {
  return v.outcome === 'CHANGES' ? 'bad' : v.warned > 0 ? 'warn' : 'ok';
}
