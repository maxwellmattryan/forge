// The Thread's progress lines: the job's events that a person follows (a stage change, a parked gate, an agent's closing line,
// checks, reviews, the decision, the PR) as compact lines between the requests, so the Thread tells the job's story without
// the Log's detail. They never count as unread: only requests and their replies need a reader. Plain functions, so
// node:test can pin them; events.jsonl is a file in the job dir, so every field is read defensively and its text kept plain.
import { STAGE_LABEL, WAIT_LABEL } from './labels.ts';
import type { JobEvent, Stage, WaitingOn } from './types.ts';
import type { ThreadItem } from './thread.ts';

export type Progress =
  | { kind: 'stage'; stage: Stage }
  | { kind: 'waiting'; on: WaitingOn | null; reason: string | null }
  | { kind: 'blocked'; reason: string | null }
  | { kind: 'ended'; state: 'done' | 'failed' | 'cancelled'; reason: string | null }
  | { kind: 'round'; round: number }
  | { kind: 'agent'; role: string; summary: string | null }
  | { kind: 'checks'; round: number; ok: boolean }
  | { kind: 'reviews'; round: number; pass: boolean }
  | { kind: 'decision'; approve: boolean; reason: string | null }
  | { kind: 'pr-opened'; number: number }
  | { kind: 'pr-merged'; number: number }
  | { kind: 'conflicts'; count: number }
  | { kind: 'note'; text: string };

export interface ProgressItem {
  id: string;
  at: string;
  line: Progress;
}

/** One Thread row: a message (a request, the opening, a secret note) or a progress line. */
export type FeedRow = { kind: 'message'; item: ThreadItem } | { kind: 'progress'; item: ProgressItem };

const MAX_TEXT = 300;
const ROLE = /^[a-z0-9:-]{1,60}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const int = (v: unknown, min: number): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= min ? v : null);
const stageOf = (v: unknown): Stage | null => (typeof v === 'string' && Object.hasOwn(STAGE_LABEL, v) ? (v as Stage) : null);
const waitOf = (v: unknown): WaitingOn | null => (typeof v === 'string' && Object.hasOwn(WAIT_LABEL, v) ? (v as WaitingOn) : null);

/** Agent or engine text on one line: control characters become spaces, at most 300 chars; null when nothing is left. */
export function plainLine(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const text = v.replace(/[\x00-\x1f\x7f\u2028\u2029]/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (!text) return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** A transition's progress line, first match wins: an end, a parked gate, a block, then a new stage; null for the rest (running → running). */
function transition(e: JobEvent): Progress | null {
  const from = obj(e.from);
  const to = obj(e.to);
  const reason = plainLine(e.reason);
  if (to.state === 'done' || to.state === 'failed' || to.state === 'cancelled') return from.state === to.state ? null : { kind: 'ended', state: to.state, reason };
  if (to.state === 'waiting') return from.state === 'waiting' && from.waitingOn === to.waitingOn ? null : { kind: 'waiting', on: waitOf(to.waitingOn), reason };
  if (to.state === 'blocked') return from.state === 'blocked' ? null : { kind: 'blocked', reason };
  const stage = stageOf(to.stage);
  return stage !== null && stage !== from.stage ? { kind: 'stage', stage } : null;
}

/** One event's progress line, or null for the events only the Log and Timeline show (commands, syncs, leases…). */
export function progressOf(e: JobEvent): Progress | null {
  const x = e as JobEvent & Record<string, unknown>;
  switch (e.type) {
    case 'transition':
      return transition(e);
    case 'round': {
      // The first round is the build starting, which its stage line already says.
      const round = int(x.round, 2);
      return round === null ? null : { kind: 'round', round };
    }
    case 'agent-end':
      return typeof e.role === 'string' && ROLE.test(e.role) ? { kind: 'agent', role: e.role, summary: plainLine(e.summary) } : null;
    case 'verify': {
      const round = int(x.round, 1);
      return round === null || typeof e.ok !== 'boolean' ? null : { kind: 'checks', round, ok: e.ok };
    }
    case 'verdicts': {
      const round = int(x.round, 1);
      return round === null || (x.outcome !== 'PASS' && x.outcome !== 'FAIL') ? null : { kind: 'reviews', round, pass: x.outcome === 'PASS' };
    }
    case 'decision':
      return x.decision === 'APPROVE' || x.decision === 'ESCALATE' ? { kind: 'decision', approve: x.decision === 'APPROVE', reason: plainLine(e.reason) } : null;
    case 'pr-opened':
    case 'pr-merged': {
      const n = int(x.number, 1);
      return n === null ? null : { kind: e.type, number: n };
    }
    case 'integrate-conflicts': {
      const count = Array.isArray(x.conflicts) ? x.conflicts.length : 0;
      return count > 0 ? { kind: 'conflicts', count } : null;
    }
    case 'note': {
      const text = plainLine(e.text);
      return text === null ? null : { kind: 'note', text };
    }
    default:
      return null;
  }
}

/** The events' progress lines, oldest first; an event without a time is dropped, as it can't be placed. */
export function threadProgress(events: JobEvent[] | null | undefined): ProgressItem[] {
  const out: ProgressItem[] = [];
  (events ?? []).forEach((e, index) => {
    if (!e || typeof e.ts !== 'string' || Number.isNaN(Date.parse(e.ts))) return;
    const progress = progressOf(e);
    if (progress) out.push({ id: `p:${e.ts}:${index}`, at: e.ts, line: progress });
  });
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * The messages with the progress lines merged in by time; a line goes before the first message that is newer, so on a
 * tie the message comes first. A message without a time (an opening with no creation time) keeps its place at the top.
 */
export function threadFeed(items: ThreadItem[], lines: ProgressItem[]): FeedRow[] {
  const rows: FeedRow[] = items.map((item) => ({ kind: 'message', item }));
  for (const m of lines) {
    const i = rows.findIndex((r) => r.kind === 'message' && r.item.at !== null && r.item.at > m.at);
    rows.splice(i < 0 ? rows.length : i, 0, { kind: 'progress', item: m });
  }
  return rows;
}
