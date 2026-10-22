// A session log's structure, built from its raw lines (parsed by session-parse.ts): turns, text, thinking, tool calls
// with their results, subagents grouped by parent_tool_use_id, background task progress folded into the call it
// reports on, results, stderr and the supervisor's own events; plus the log pane's filters and follow rule. No DOM access.
// Every line is session output, i.e. untrusted text: this returns plain strings, and nothing here escapes or
// interprets markup. SessionLog.svelte renders them as text, except text/thinking bodies and a subagent's prompt
// and result, which go only through the escape-first md().
import { AGENT_TOOLS, mergeTask, parseEntry, toolResult, toolSummary } from './session-parse.ts';
import type { Entry, Item } from './session-parse.ts';

export interface Filters {
  text: string;
  tools: boolean;
  thinking: boolean;
  subagents: boolean;
}

export const DEFAULT_FILTERS: Filters = Object.freeze({ text: '', tools: true, thinking: false, subagents: true });
/** Whether any filter differs from DEFAULT_FILTERS (whitespace-only search text counts as none). */
export const filtersActive = (f: Filters): boolean =>
  f.text.trim() !== '' || f.tools !== DEFAULT_FILTERS.tools || f.thinking !== DEFAULT_FILTERS.thinking || f.subagents !== DEFAULT_FILTERS.subagents;
/** The client keeps at most this many lines; dropping the oldest means older ones are on the server. */
export const MAX_ENTRIES = 5000;
/** How far from the bottom (px) the pane still counts as at the bottom, so Follow stays on. */
export const FOLLOW_SLACK = 24;
/** Whether a scrolled pane is within `slack` px of its bottom; content shorter than the pane always is. */
export const atBottom = (scrollHeight: number, scrollTop: number, clientHeight: number, slack = FOLLOW_SLACK): boolean => scrollHeight - scrollTop - clientHeight <= slack;

export interface TurnGroup {
  /** Offset of the turn event, or of the first line for "Session start". */
  offset: number;
  label: string;
  at: string | null;
  items: Item[];
}

export interface SessionView {
  turns: TurnGroup[];
  totals: { turns: number; costUsd: number; results: number };
}

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
};

/** The text a filter matches against. */
function haystack(it: Item): string {
  switch (it.kind) {
    case 'tool':
      return `${it.name} ${it.summary} ${it.input} ${it.result?.full ?? ''} ${it.task?.text ?? ''}`;
    case 'subagent':
      return `${it.role} ${it.description} ${it.prompt} ${it.input} ${it.result?.full ?? ''} ${it.task?.text ?? ''}`;
    case 'init':
      return `init ${it.model} ${it.session}`;
    case 'task':
      return `${it.role} ${it.text}`;
    case 'supervisor':
      return it.text;
    default:
      return it.text;
  }
}

function applyFilters(items: Item[], f: Filters, needle: string): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    if (it.kind === 'tool' && !f.tools) continue;
    if (it.kind === 'thinking' && !f.thinking) continue;
    if (it.kind === 'subagent') {
      const children = f.subagents ? applyFilters(it.items, f, needle) : [];
      const self = !needle || haystack(it).toLowerCase().includes(needle);
      if (!self && !children.length) continue;
      // A match on the block itself keeps all its (filtered-by-kind) children.
      const kept = f.subagents ? (self && needle ? applyFilters(it.items, f, '') : children) : [];
      out.push({ ...it, items: kept, hidden: f.subagents ? 0 : it.items.length });
      continue;
    }
    if (needle && !haystack(it).toLowerCase().includes(needle)) continue;
    out.push(it);
  }
  return out;
}

/**
 * Groups a log's entries into turns, nests subagent lines under their Agent call, folds background
 * task lines into the call they report on, then filters.
 * `partial`: the entries start mid-log (older lines are on the server), so the lines before the
 * first turn are not the session's start. Turns are numbered by the supervisor when its event says.
 */
export function buildSessionView(entries: readonly Entry[], filters: Filters = DEFAULT_FILTERS, opts: { partial?: boolean } = {}): SessionView {
  const first = opts.partial ? 'Earlier lines' : 'Session start';
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  const totals = { turns: 0, costUsd: 0, results: 0 };
  const tools = new Map<string, Item & { kind: 'tool' | 'subagent' }>();
  /** Task lines whose call is not in the window: one item each, kept current. */
  const orphans = new Map<string, Item & { kind: 'task' }>();
  /** task_id → tool_use_id, from the task lines that carry both. */
  const callOfTask = new Map<string, string>();
  const group = (offset: number, at: string | null): TurnGroup => {
    if (!current) {
      current = { offset, label: first, at, items: [] };
      turns.push(current);
    }
    return current;
  };
  /** Where a line with this parent goes: the turn, its Agent call's block, or a block for an unknown call. */
  const target = (offset: number, at: string | null, parent: string | null): Item[] => {
    const g = group(offset, at);
    if (!parent) return g.items;
    const known = tools.get(parent);
    if (known && known.kind === 'subagent') return known.items;
    const sub: Item = { kind: 'subagent', offset, at, tone: 'muted', id: parent, role: 'Subagent (unknown call)', description: '', summary: '', input: '', prompt: '', items: [], result: null, known: false, hidden: 0, task: null };
    tools.set(parent, sub);
    g.items.push(sub);
    return sub.items;
  };
  for (const e of entries) {
    for (const p of parseEntry(e)) {
      if (p.kind === 'turn') {
        totals.turns++;
        current = { offset: p.offset, label: `Turn ${p.turn ?? totals.turns} · ${p.requests} ${p.requests === 1 ? 'request' : 'requests'}`, at: p.at, items: [] };
        turns.push(current);
      } else if (p.kind === 'item') {
        if (p.item.kind === 'result') {
          totals.results++;
          if (p.item.costUsd !== null) totals.costUsd += p.item.costUsd;
        }
        target(p.item.offset, p.item.at, p.parent).push(p.item);
      } else if (p.kind === 'tool-use') {
        const input = pretty(p.input ?? {});
        const summary = toolSummary(p.name, p.input);
        const it: Item & { kind: 'tool' | 'subagent' } = AGENT_TOOLS.has(p.name)
          ? { kind: 'subagent', offset: p.offset, at: p.at, tone: 'info', id: p.id, role: str(obj(p.input).subagent_type) || 'agent', description: str(obj(p.input).description), summary, input, prompt: str(obj(p.input).prompt), items: [], result: null, known: true, hidden: 0, task: null }
          : { kind: 'tool', offset: p.offset, at: p.at, tone: null, id: p.id, name: p.name, summary, input, result: null, task: null };
        const into = target(p.offset, p.at, p.parent);
        // A placeholder made for this id by an earlier child line is adopted, not duplicated.
        const early = tools.get(p.id);
        if (it.kind === 'subagent' && early?.kind === 'subagent' && !early.known) {
          Object.assign(early, { ...it, items: early.items, offset: Math.min(early.offset, it.offset), task: early.task });
          continue;
        }
        if (p.id) tools.set(p.id, it);
        into.push(it);
      } else if (p.kind === 'task') {
        if (p.id && p.taskId) callOfTask.set(p.taskId, p.id);
        const id = p.id ?? callOfTask.get(p.taskId);
        // A task_updated for a task no loaded line has named: nothing to attach it to, and the notification repeats its status.
        if (!id) continue;
        const call = tools.get(id);
        if (call) {
          call.task = mergeTask(call.task, p.patch);
          if (p.patch.status === 'failed') call.tone = 'bad';
          continue;
        }
        const seen = orphans.get(id);
        if (seen) {
          seen.task = mergeTask(seen.task, p.patch);
          seen.text = seen.task.text;
          if (p.patch.status === 'failed') seen.tone = 'bad';
          continue;
        }
        const task = mergeTask(null, p.patch);
        const it: Item & { kind: 'task' } = { kind: 'task', offset: p.offset, at: p.at, tone: p.patch.status === 'failed' ? 'bad' : 'muted', id, role: p.role, task, text: task.text };
        orphans.set(id, it);
        target(p.offset, p.at, null).push(it);
      } else {
        const call = tools.get(p.id);
        const r = toolResult(p.isError, p.content);
        if (call) {
          call.result = r;
          if (p.isError) call.tone = 'bad';
        } else target(p.offset, p.at, p.parent).push({ kind: 'other', offset: p.offset, at: p.at, tone: p.isError ? 'bad' : 'muted', text: `result for an unknown call: ${r.preview}` });
      }
    }
  }
  const needle = filters.text.trim().toLowerCase();
  const filtered = turns.map((t) => ({ ...t, items: applyFilters(t.items, filters, needle) })).filter((t) => t.items.length || (!needle && t.label !== first));
  return { turns: filtered, totals };
}

/**
 * The model on the newest session `init` line in the entries, or null when none names one. A subagent's init line (one
 * with a parent call) reports the subagent's model, not the session's, so it is skipped. Read through parseEntry, the
 * parser buildSessionView uses; the model is session output, rendered as text.
 */
export function latestInitModel(entries: readonly Entry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const parsed = parseEntry(entries[i]);
    for (let j = parsed.length - 1; j >= 0; j--) {
      const p = parsed[j];
      if (p.kind === 'item' && p.parent === null && p.item.kind === 'init' && p.item.model) return p.item.model;
    }
  }
  return null;
}

/**
 * Inserts a line into an offset-sorted buffer. Returns false for a duplicate offset or one older
 * than the loaded window (Load older fetches those).
 */
export function mergeEntry(buf: Entry[], e: Entry): boolean {
  if (!Number.isFinite(e.offset)) return false;
  const n = buf.length;
  if (!n || e.offset > buf[n - 1].offset) {
    buf.push(e);
    return true;
  }
  if (e.offset < buf[0].offset) return false;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (buf[mid].offset < e.offset) lo = mid + 1;
    else hi = mid;
  }
  if (buf[lo].offset === e.offset) return false;
  buf.splice(lo, 0, e);
  return true;
}

/** Filters as stored in the `sessionFilters` pref: anything unparseable falls back to the defaults. */
export function readFilters(raw: string | null | undefined): Filters {
  try {
    const v = obj(JSON.parse(String(raw)));
    return {
      text: typeof v.text === 'string' ? v.text : DEFAULT_FILTERS.text,
      tools: typeof v.tools === 'boolean' ? v.tools : DEFAULT_FILTERS.tools,
      thinking: typeof v.thinking === 'boolean' ? v.thinking : DEFAULT_FILTERS.thinking,
      subagents: typeof v.subagents === 'boolean' ? v.subagents : DEFAULT_FILTERS.subagents,
    };
  } catch {
    return { ...DEFAULT_FILTERS };
  }
}
