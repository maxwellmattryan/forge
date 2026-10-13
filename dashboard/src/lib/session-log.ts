// A session log's structure, built from its raw lines: turns, text, thinking, tool calls with their
// results, subagents grouped by parent_tool_use_id, results, stderr and the supervisor's own events.
// Every line is session output, i.e. untrusted text: this returns plain strings, SessionLog.svelte
// renders them as text, and nothing here escapes or interprets markup.

/** One log line and its offset (the SSE id and the history key). */
export interface Entry {
  offset: number;
  line: string;
}

export interface Filters {
  text: string;
  tools: boolean;
  thinking: boolean;
  subagents: boolean;
}

export const DEFAULT_FILTERS: Filters = Object.freeze({ text: '', tools: true, thinking: false, subagents: true });
/** The client keeps at most this many lines; dropping the oldest means older ones are on the server. */
export const MAX_ENTRIES = 5000;
export const PREVIEW_CHARS = 300;
export const LONG_TEXT = 2000;
const SUMMARY_CHARS = 120;
const SUPERVISOR_KEYS = ['message', 'pid', 'sessionId', 'requests', 'held', 'jobs', 'code', 'signal', 'reason', 'state', 'maxConcurrent', 'bytes', 'from', 'to'];
const AGENT_TOOLS = new Set(['Agent', 'Task']);

export interface ToolResult {
  isError: boolean;
  preview: string;
  full: string;
  /** `full` is longer than `preview`. */
  more: boolean;
}

interface ItemBase {
  offset: number;
  tone: string | null;
}

export type Item =
  | (ItemBase & { kind: 'supervisor'; event: string; text: string })
  | (ItemBase & { kind: 'init'; model: string; session: string })
  | (ItemBase & { kind: 'text'; text: string; long: boolean })
  | (ItemBase & { kind: 'thinking'; text: string })
  | (ItemBase & { kind: 'tool'; id: string; name: string; summary: string; input: string; result: ToolResult | null })
  | (ItemBase & { kind: 'subagent'; id: string; role: string; description: string; summary: string; input: string; items: Item[]; result: ToolResult | null; known: boolean; hidden: number })
  | (ItemBase & { kind: 'result'; text: string; costUsd: number | null })
  | (ItemBase & { kind: 'stderr' | 'raw' | 'truncated' | 'rate-limit' | 'other'; text: string });

export type ItemKind = Item['kind'] | 'turn';

export interface TurnGroup {
  /** Offset of the turn event, or of the first line for "Session start". */
  offset: number;
  label: string;
  items: Item[];
}

export interface SessionView {
  turns: TurnGroup[];
  totals: { turns: number; costUsd: number; results: number };
}

/** What one line says, before grouping. A line may carry several content blocks, so parseEntry returns a list. */
export type Parsed =
  | { kind: 'turn'; offset: number; requests: number; turn: number | null }
  | { kind: 'item'; parent: string | null; item: Item }
  | { kind: 'tool-use'; offset: number; parent: string | null; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; offset: number; parent: string | null; id: string; isError: boolean; content: string };

const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});
const str = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2) ?? '';
  } catch {
    return String(v);
  }
};

/** A tool call's one-line summary: what a human scanning the log wants to see first. */
export function toolSummary(name: string, input: unknown): string {
  const i = obj(input);
  let s: string;
  if (name === 'Bash') s = str(i.command).split('\n')[0];
  else if (['Read', 'Edit', 'Write', 'MultiEdit'].includes(name)) s = str(i.file_path);
  else if (name === 'NotebookEdit') s = str(i.notebook_path);
  else if (name === 'Glob' || name === 'Grep') s = str(i.pattern) + (i.path ? ` in ${str(i.path)}` : '');
  else if (AGENT_TOOLS.has(name)) s = `${str(i.subagent_type) || 'agent'}: ${str(i.description)}`;
  else if (name === 'Skill') s = [str(i.skill ?? i.command), str(i.args)].filter(Boolean).join(' ');
  else if (name === 'WebFetch') s = str(i.url);
  else if (name === 'WebSearch') s = str(i.query);
  else if (name === 'TodoWrite') s = `${Array.isArray(i.todos) ? i.todos.length : 0} todos`;
  else s = JSON.stringify(input ?? {}) ?? '';
  return clip(s.trim(), SUMMARY_CHARS);
}

/** A tool_result's content as text: strings as is, text blocks joined, anything else named. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : pretty(content);
  return content
    .map(obj)
    .map((b) => (b.type === 'text' ? str(b.text) : b.type === 'image' ? '[image]' : pretty(b)))
    .join('\n');
}

export function toolResult(isError: boolean, content: string): ToolResult {
  return { isError, preview: clip(content, PREVIEW_CHARS), full: content, more: content.length > PREVIEW_CHARS };
}

function supervisorText(ev: Record<string, any>): string {
  const parts = [str(ev.event)];
  for (const k of SUPERVISOR_KEYS) if (ev[k] != null) parts.push(`${k}=${str(ev[k])}`);
  return parts.join(' ');
}

function supervisorTone(event: string): string {
  if (['error', 'resume-failed', 'line-truncated'].includes(event)) return 'bad';
  if (['held', 'waiting'].includes(event)) return 'warn';
  return 'muted';
}

const cache = new WeakMap<Entry, Parsed[]>();

/** One raw log line, parsed. Cached per entry, so rebuilding the view on each new line stays cheap. */
export function parseEntry(e: Entry): Parsed[] {
  const hit = cache.get(e);
  if (hit) return hit;
  const out = parseLine(e.offset, String(e.line ?? ''));
  cache.set(e, out);
  return out;
}

function parseLine(offset: number, line: string): Parsed[] {
  const item = (it: Item, parent: string | null = null): Parsed => ({ kind: 'item', parent, item: it });
  let ev: Record<string, any>;
  try {
    const v = JSON.parse(line);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    ev = v;
  } catch {
    return [item({ kind: 'raw', offset, tone: 'muted', text: line })];
  }
  const parent = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id ? ev.parent_tool_use_id : null;
  switch (ev.type) {
    case 'forge-daemon': {
      const event = str(ev.event);
      if (event === 'turn') return [{ kind: 'turn', offset, requests: Number(ev.requests) || 0, turn: Number.isInteger(ev.turn) && ev.turn > 0 ? ev.turn : null }];
      return [item({ kind: 'supervisor', offset, tone: supervisorTone(event), event, text: supervisorText(ev) })];
    }
    case 'forge-stderr':
      return [item({ kind: 'stderr', offset, tone: 'bad', text: str(ev.text) })];
    case 'forge-raw':
      return [item({ kind: 'raw', offset, tone: 'muted', text: str(ev.text) })];
    case 'forge-truncated':
      return [item({ kind: 'truncated', offset, tone: 'warn', text: `${str(ev.originalType ?? 'line')} · ${str(ev.bytes)} bytes` })];
    case 'system':
      if (ev.subtype === 'init') return [item({ kind: 'init', offset, tone: 'muted', model: str(ev.model), session: str(ev.session_id).slice(0, 8) }, parent)];
      return [item({ kind: 'other', offset, tone: 'muted', text: `system ${str(ev.subtype)}` }, parent)];
    case 'assistant': {
      const blocks = Array.isArray(obj(ev.message).content) ? (obj(ev.message).content as unknown[]).map(obj) : [];
      const out: Parsed[] = [];
      // An API failure (auth, overload) arrives as an assistant message flagged with `error`.
      const tone = ev.error || ev.is_api_error_message ? 'bad' : null;
      for (const b of blocks) {
        if (b.type === 'text' && str(b.text).trim()) out.push(item({ kind: 'text', offset, tone, text: str(b.text), long: str(b.text).length > LONG_TEXT }, parent));
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') out.push(item({ kind: 'thinking', offset, tone: 'muted', text: str(b.thinking ?? b.data ?? '') }, parent));
        else if (b.type === 'tool_use') out.push({ kind: 'tool-use', offset, parent, id: str(b.id), name: str(b.name), input: b.input });
      }
      return out;
    }
    case 'user': {
      const content = obj(ev.message).content;
      const blocks = Array.isArray(content) ? (content as unknown[]).map(obj) : [];
      const out: Parsed[] = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({ kind: 'tool-result' as const, offset, parent, id: str(b.tool_use_id), isError: b.is_error === true, content: resultText(b.content) }));
      // A subagent's prompt arrives as a user text message under its parent: show it like text.
      if (typeof content === 'string' && content.trim()) out.push(item({ kind: 'text', offset, tone: 'muted', text: content, long: content.length > LONG_TEXT }, parent));
      for (const b of blocks) if (b.type === 'text' && str(b.text).trim()) out.push(item({ kind: 'text', offset, tone: 'muted', text: str(b.text), long: str(b.text).length > LONG_TEXT }, parent));
      return out;
    }
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
      // claude marks an API failure (an expired login) is_error while still saying "success".
      const kind = ev.is_error === true && !str(ev.subtype).startsWith('error') ? `error (${str(ev.subtype) || 'result'})` : str(ev.subtype);
      const why = ev.is_error === true && typeof ev.result === 'string' && ev.result.trim() ? clip(ev.result.trim(), 200) : '';
      const bits = [kind, why, ev.num_turns != null ? `${str(ev.num_turns)} turns` : '', ev.duration_ms != null ? `${Math.round(Number(ev.duration_ms) / 1000)}s` : '', cost !== null ? `$${cost.toFixed(4)}` : ''];
      return [item({ kind: 'result', offset, tone: ev.is_error ? 'bad' : 'ok', text: bits.filter(Boolean).join(' · '), costUsd: cost }, parent)];
    }
    case 'rate_limit_event':
      return [item({ kind: 'rate-limit', offset, tone: 'warn', text: JSON.stringify(ev) }, parent)];
    default:
      return [item({ kind: 'other', offset, tone: 'muted', text: JSON.stringify(ev) }, parent)];
  }
}

/** The text a filter matches against. */
function haystack(it: Item): string {
  switch (it.kind) {
    case 'tool':
      return `${it.name} ${it.summary} ${it.input} ${it.result?.full ?? ''}`;
    case 'subagent':
      return `${it.role} ${it.description} ${it.input} ${it.result?.full ?? ''}`;
    case 'init':
      return `init ${it.model} ${it.session}`;
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
 * Groups a log's entries into turns, nests subagent lines under their Agent call, then filters.
 * `partial`: the entries start mid-log (older lines are on the server), so the lines before the
 * first turn are not the session's start. Turns are numbered by the supervisor when its event says.
 */
export function buildSessionView(entries: readonly Entry[], filters: Filters = DEFAULT_FILTERS, opts: { partial?: boolean } = {}): SessionView {
  const first = opts.partial ? 'Earlier lines' : 'Session start';
  const turns: TurnGroup[] = [];
  let current: TurnGroup | null = null;
  const totals = { turns: 0, costUsd: 0, results: 0 };
  const tools = new Map<string, Item & { kind: 'tool' | 'subagent' }>();
  const group = (offset: number): TurnGroup => {
    if (!current) {
      current = { offset, label: first, items: [] };
      turns.push(current);
    }
    return current;
  };
  /** Where a line with this parent goes: the turn, its Agent call's block, or a block for an unknown call. */
  const target = (offset: number, parent: string | null): Item[] => {
    const g = group(offset);
    if (!parent) return g.items;
    const known = tools.get(parent);
    if (known && known.kind === 'subagent') return known.items;
    const sub: Item = { kind: 'subagent', offset, tone: 'muted', id: parent, role: 'Subagent (unknown call)', description: '', summary: '', input: '', items: [], result: null, known: false, hidden: 0 };
    tools.set(parent, sub);
    g.items.push(sub);
    return sub.items;
  };
  for (const e of entries) {
    for (const p of parseEntry(e)) {
      if (p.kind === 'turn') {
        totals.turns++;
        current = { offset: p.offset, label: `Turn ${p.turn ?? totals.turns} · ${p.requests} ${p.requests === 1 ? 'request' : 'requests'}`, items: [] };
        turns.push(current);
      } else if (p.kind === 'item') {
        if (p.item.kind === 'result') {
          totals.results++;
          if (p.item.costUsd !== null) totals.costUsd += p.item.costUsd;
        }
        target(p.item.offset, p.parent).push(p.item);
      } else if (p.kind === 'tool-use') {
        const input = pretty(p.input ?? {});
        const summary = toolSummary(p.name, p.input);
        const it: Item & { kind: 'tool' | 'subagent' } = AGENT_TOOLS.has(p.name)
          ? { kind: 'subagent', offset: p.offset, tone: 'info', id: p.id, role: str(obj(p.input).subagent_type) || 'agent', description: str(obj(p.input).description), summary, input, items: [], result: null, known: true, hidden: 0 }
          : { kind: 'tool', offset: p.offset, tone: null, id: p.id, name: p.name, summary, input, result: null };
        const into = target(p.offset, p.parent);
        // A placeholder made for this id by an earlier child line is adopted, not duplicated.
        const early = tools.get(p.id);
        if (it.kind === 'subagent' && early?.kind === 'subagent' && !early.known) {
          Object.assign(early, { ...it, items: early.items, offset: Math.min(early.offset, it.offset) });
          continue;
        }
        if (p.id) tools.set(p.id, it);
        into.push(it);
      } else {
        const call = tools.get(p.id);
        const r = toolResult(p.isError, p.content);
        if (call) {
          call.result = r;
          if (p.isError) call.tone = 'bad';
        } else target(p.offset, p.parent).push({ kind: 'other', offset: p.offset, tone: p.isError ? 'bad' : 'muted', text: `result for an unknown call: ${r.preview}` });
      }
    }
  }
  const needle = filters.text.trim().toLowerCase();
  const filtered = turns.map((t) => ({ ...t, items: applyFilters(t.items, filters, needle) })).filter((t) => t.items.length || (!needle && t.label !== first));
  return { turns: filtered, totals };
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
