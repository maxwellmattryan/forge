// One session log line, parsed: what a raw line of claude's stream (or a Claude Code transcript, or the supervisor's own
// events) says, before session-log.ts groups it into turns. No DOM access.
// Every line is session output, i.e. untrusted text: this returns plain strings, and nothing here escapes or
// interprets markup.
import { dur, tokensShort } from '../core/util.ts';

/** One log line and its offset (the SSE id and the history key). */
export interface Entry {
  offset: number;
  line: string;
}

export const PREVIEW_CHARS = 300;
export const LONG_TEXT = 2000;
const SUMMARY_CHARS = 120;
const SUPERVISOR_KEYS = ['message', 'pid', 'sessionId', 'requests', 'held', 'jobs', 'code', 'signal', 'reason', 'state', 'maxConcurrent', 'bytes', 'from', 'to', 'tool', 'decision', 'mode', 'roles', 'level', 'source', 'cap'];
/** The tools that start a subagent, whose lines nest under the call. */
export const AGENT_TOOLS = new Set(['Agent', 'Task']);
/**
 * claude's bookkeeping lines, dropped: a thinking-token meter, the skill catalog (several KiB per
 * line), the background task list (task_started says the same), hook start/progress (hook_response
 * has the outcome) and the Agent heartbeat (task_progress has the elapsed time).
 */
const NOISE = new Set(['thinking_tokens', 'commands_changed', 'background_tasks_changed', 'hook_started', 'hook_progress']);
/**
 * Claude Code transcript bookkeeping (the on-disk transcripts the drawer's Agents tab and an interactive owner's log read),
 * dropped rather than dumped as JSON: file snapshots, queue operations, summaries, progress, attachments and the last
 * prompt. `user` lines flagged isMeta (injected context) are dropped too.
 */
export const TRANSCRIPT_NOISE = new Set(['file-history-snapshot', 'queue-operation', 'summary', 'progress', 'attachment', 'last-prompt']);

export interface ToolResult {
  isError: boolean;
  preview: string;
  full: string;
  /** `full` is longer than `preview`. */
  more: boolean;
}

/**
 * What claude's task_started / task_progress / task_updated / task_notification lines said about a
 * background task (an Agent call or a backgrounded Bash), latest first wins.
 */
export interface TaskInfo {
  /** running, completed, failed, … as claude names them. */
  status: string | null;
  /** The task's current step, from task_progress ("Editing lib/engine/pipeline/step.ts"). */
  activity: string;
  tokens: number | null;
  toolUses: number | null;
  durationMs: number | null;
  /** Time of the latest line about the task. */
  at: string | null;
  /** The one-line rendering of the above. */
  text: string;
}

interface ItemBase {
  offset: number;
  tone: string | null;
  /** When the line was written (claude's `timestamp`, or the receipt time the supervisor stamps as `at`). */
  at: string | null;
}

export type Item =
  | (ItemBase & { kind: 'supervisor'; event: string; text: string })
  | (ItemBase & { kind: 'init'; model: string; session: string })
  | (ItemBase & { kind: 'text'; text: string; long: boolean })
  | (ItemBase & { kind: 'thinking'; text: string })
  | (ItemBase & { kind: 'tool'; id: string; name: string; summary: string; input: string; result: ToolResult | null; task: TaskInfo | null })
  | (ItemBase & { kind: 'subagent'; id: string; role: string; description: string; summary: string; input: string; prompt: string; items: Item[]; result: ToolResult | null; known: boolean; hidden: number; task: TaskInfo | null })
  | (ItemBase & { kind: 'result'; text: string; costUsd: number | null })
  /** A task line whose call is not in the loaded window: one item per task, updated in place. */
  | (ItemBase & { kind: 'task'; id: string; role: string; task: TaskInfo; text: string })
  | (ItemBase & { kind: 'stderr' | 'raw' | 'truncated' | 'rate-limit' | 'denied' | 'hook' | 'other'; text: string });

export type ItemKind = Item['kind'] | 'turn';

export type TaskPatch = Partial<Omit<TaskInfo, 'text'>>;

/** What one line says, before grouping. A line may carry several content blocks, so parseEntry returns a list. */
export type Parsed =
  | { kind: 'turn'; offset: number; at: string | null; requests: number; turn: number | null }
  | { kind: 'item'; parent: string | null; item: Item }
  | { kind: 'tool-use'; offset: number; at: string | null; parent: string | null; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; offset: number; at: string | null; parent: string | null; id: string; isError: boolean; content: string }
  /** `id` is the call's tool_use_id; task_updated names only the task_id, resolved through an earlier line about the same task. */
  | { kind: 'task'; offset: number; at: string | null; id: string | null; taskId: string; role: string; patch: TaskPatch };

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
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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

/** The task's one line: `completed · Editing lib/engine/pipeline/step.ts · 12 tools · 32k tokens · 1m 7s`, whichever parts are known. */
export function taskText(t: Omit<TaskInfo, 'text'>): string {
  const bits = [t.status ?? '', clip(t.activity, SUMMARY_CHARS), t.toolUses !== null ? `${t.toolUses} ${t.toolUses === 1 ? 'tool' : 'tools'}` : '', t.tokens !== null ? `${tokensShort(t.tokens)} tokens` : '', t.durationMs !== null ? dur(t.durationMs) : ''];
  return bits.filter(Boolean).join(' · ');
}

/** A task's info with a later line's patch applied: empty values never overwrite what an earlier line said. */
export function mergeTask(prev: TaskInfo | null, patch: TaskPatch): TaskInfo {
  const base: Omit<TaskInfo, 'text'> = prev ?? { status: null, activity: '', tokens: null, toolUses: null, durationMs: null, at: null };
  const next = { ...base };
  for (const k of Object.keys(patch) as (keyof TaskPatch)[]) if (patch[k] !== undefined && patch[k] !== null && patch[k] !== '') (next as Record<string, unknown>)[k] = patch[k];
  return { ...next, text: taskText(next) };
}

function supervisorText(ev: Record<string, any>): string {
  const parts = [str(ev.event)];
  for (const k of SUPERVISOR_KEYS) if (ev[k] != null) parts.push(`${k}=${str(ev[k])}`);
  return parts.join(' ');
}

function supervisorTone(event: string): string {
  if (['error', 'resume-failed', 'line-truncated'].includes(event)) return 'bad';
  if (['held', 'waiting', 'permission-asked', 'agents-lost', 'missed-agent-end'].includes(event)) return 'warn';
  return 'muted';
}

/** `rate_limit_event` as one line: the status and each window's utilisation. */
function rateLimitText(info: Record<string, any>): string {
  const windows = obj(info.unifiedWindows);
  const parts = [str(info.status), str(info.rateLimitType)];
  for (const [name, w] of Object.entries(windows)) {
    const u = numOrNull(obj(w).utilization);
    if (u !== null) parts.push(`${name} ${Math.round(u * 100)}%`);
  }
  if (info.isUsingOverage === true) parts.push('overage');
  return parts.filter(Boolean).join(' · ') || JSON.stringify(info);
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
    return [item({ kind: 'raw', offset, at: null, tone: 'muted', text: line })];
  }
  if (TRANSCRIPT_NOISE.has(ev.type) || (ev.type === 'user' && ev.isMeta === true)) return [];
  const parent = typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id ? ev.parent_tool_use_id : null;
  const at = typeof ev.timestamp === 'string' ? ev.timestamp : typeof ev.at === 'string' ? ev.at : null;
  switch (ev.type) {
    case 'forge-daemon': {
      const event = str(ev.event);
      if (event === 'turn') return [{ kind: 'turn', offset, at, requests: Number(ev.requests) || 0, turn: Number.isInteger(ev.turn) && ev.turn > 0 ? ev.turn : null }];
      return [item({ kind: 'supervisor', offset, at, tone: supervisorTone(event), event, text: supervisorText(ev) })];
    }
    case 'forge-stderr':
      return [item({ kind: 'stderr', offset, at, tone: 'bad', text: str(ev.text) })];
    case 'forge-raw':
      return [item({ kind: 'raw', offset, at, tone: 'muted', text: str(ev.text) })];
    case 'forge-truncated':
      return [item({ kind: 'truncated', offset, at, tone: 'warn', text: `${str(ev.originalType ?? 'line')} · ${str(ev.bytes)} bytes` })];
    case 'system': {
      const sub = str(ev.subtype);
      if (sub === 'init') return [item({ kind: 'init', offset, at, tone: 'muted', model: str(ev.model), session: str(ev.session_id).slice(0, 8) }, parent)];
      if (NOISE.has(sub)) return [];
      // Background task lines name the call they report on by tool_use_id, not parent_tool_use_id.
      if (sub.startsWith('task_') && (typeof ev.tool_use_id === 'string' && ev.tool_use_id || typeof ev.task_id === 'string' && ev.task_id)) {
        const role = str(ev.subagent_type) || str(ev.task_type);
        const usage = obj(ev.usage);
        const patch: TaskPatch =
          sub === 'task_progress'
            ? { activity: str(ev.description), tokens: numOrNull(usage.total_tokens), toolUses: numOrNull(usage.tool_uses), durationMs: numOrNull(usage.duration_ms), at }
            : sub === 'task_notification'
              ? { status: str(ev.status), at }
              : sub === 'task_updated'
                ? { status: str(obj(ev.patch).status), at }
                : sub === 'task_started'
                  ? { status: 'running', at }
                  : { at };
        return [{ kind: 'task', offset, at, id: typeof ev.tool_use_id === 'string' && ev.tool_use_id ? ev.tool_use_id : null, taskId: str(ev.task_id), role, patch }];
      }
      if (sub === 'permission_denied') return [item({ kind: 'denied', offset, at, tone: 'warn', text: [str(ev.tool_name), clip(str(ev.message), 200)].filter(Boolean).join(': ') }, parent)];
      if (sub === 'hook_response') {
        const outcome = str(ev.outcome);
        const bits = [str(ev.hook_name), outcome, ev.exit_code != null ? `exit ${str(ev.exit_code)}` : '', outcome && outcome !== 'success' ? clip(str(ev.stderr ?? ev.output).trim(), 200) : ''];
        return [item({ kind: 'hook', offset, at, tone: outcome && outcome !== 'success' ? 'warn' : 'muted', text: bits.filter(Boolean).join(' · ') }, parent)];
      }
      return [item({ kind: 'other', offset, at, tone: 'muted', text: `system ${sub}` }, parent)];
    }
    case 'tool_progress':
    // The supervisor logs each as permission-asked / permission-cancelled with the same tool name, and
    // claude's answer to a mode switch as permission-mode or an error.
    case 'control_request':
    case 'control_cancel_request':
    case 'control_response':
      return [];
    case 'assistant': {
      const blocks = Array.isArray(obj(ev.message).content) ? (obj(ev.message).content as unknown[]).map(obj) : [];
      const out: Parsed[] = [];
      // An API failure (auth, overload) arrives as an assistant message flagged with `error`.
      const tone = ev.error || ev.is_api_error_message ? 'bad' : null;
      for (const b of blocks) {
        if (b.type === 'text' && str(b.text).trim()) out.push(item({ kind: 'text', offset, at, tone, text: str(b.text), long: str(b.text).length > LONG_TEXT }, parent));
        else if (b.type === 'thinking' || b.type === 'redacted_thinking') out.push(item({ kind: 'thinking', offset, at, tone: 'muted', text: str(b.thinking ?? b.data ?? '') }, parent));
        else if (b.type === 'tool_use') out.push({ kind: 'tool-use', offset, at, parent, id: str(b.id), name: str(b.name), input: b.input });
      }
      return out;
    }
    case 'user': {
      const content = obj(ev.message).content;
      const blocks = Array.isArray(content) ? (content as unknown[]).map(obj) : [];
      const out: Parsed[] = blocks
        .filter((b) => b.type === 'tool_result')
        .map((b) => ({ kind: 'tool-result' as const, offset, at, parent, id: str(b.tool_use_id), isError: b.is_error === true, content: resultText(b.content) }));
      // A subagent's prompt arrives as a user text message under its parent: show it like text.
      if (typeof content === 'string' && content.trim()) out.push(item({ kind: 'text', offset, at, tone: 'muted', text: content, long: content.length > LONG_TEXT }, parent));
      for (const b of blocks) if (b.type === 'text' && str(b.text).trim()) out.push(item({ kind: 'text', offset, at, tone: 'muted', text: str(b.text), long: str(b.text).length > LONG_TEXT }, parent));
      return out;
    }
    case 'result': {
      const cost = typeof ev.total_cost_usd === 'number' && Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
      // claude marks an API failure (an expired login) is_error while still saying "success".
      const kind = ev.is_error === true && !str(ev.subtype).startsWith('error') ? 'turn failed' : str(ev.subtype);
      const why = ev.is_error === true && typeof ev.result === 'string' && ev.result.trim() ? clip(ev.result.trim(), 200) : '';
      const bits = [kind, why, ev.num_turns != null ? `${str(ev.num_turns)} turns` : '', ev.duration_ms != null ? `${Math.round(Number(ev.duration_ms) / 1000)}s` : '', cost !== null ? `$${cost.toFixed(4)}` : ''];
      return [item({ kind: 'result', offset, at, tone: ev.is_error ? 'bad' : 'ok', text: bits.filter(Boolean).join(' · '), costUsd: cost }, parent)];
    }
    case 'rate_limit_event': {
      const info = obj(ev.rate_limit_info);
      const status = str(info.status);
      return [item({ kind: 'rate-limit', offset, at, tone: status && status !== 'allowed' ? 'warn' : 'muted', text: rateLimitText(info) }, parent)];
    }
    default:
      return [item({ kind: 'other', offset, at, tone: 'muted', text: JSON.stringify(ev) }, parent)];
  }
}
