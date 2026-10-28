// Claude Code's stream-json protocol, with no I/O of its own: claude's output lines become ClaudeEvents,
// and every line written to its stdin is built here: the one fixed turn, permission answers and mode
// switches from a fixed list, an error reply that repeats claude's own capped subtype back to it, the
// fixed verdict retry, and two free-text lines: in a chat session only, the owner's own message (writeMessage),
// and in a role child or a gate run only, the brief the CLI built (writeBrief, sent once by role.ts
// runRoleChild or by lib/office/foreman/attempt.ts). Nothing from requests or config reaches any of them
// (docs/architecture/daemon-security.md).
import crypto from 'node:crypto';
import path from 'node:path';
import { CHAT_MESSAGE_MAX } from '#api/constants.ts';
import { now } from '#core/utils.ts';
import { PERMISSION_MODES } from './argv.ts';
import type { ClaudeEvent, ModelCost, SessionCost } from './types.ts';
import type { DaemonPermissionMode, PermissionDecision } from '#core/types.ts';

/**
 * The fixed user message the daemon writes to a session's stdin. The other lines are permission answers
 * (permissionResponse) and mode switches (modeRequest), whose only variable part is a value from a fixed
 * list, a chat session's owner messages (chatMessageLine), which only lib/office/session/lifecycle.ts
 * writeChat sends and only in a chat scope, and a role child's or gate run's brief (briefLine), which only role.ts
 * runRoleChild and lib/office/foreman/attempt.ts send, from a brief the CLI built, plus the fixed verdict retry.
 * Nothing from requests or config reaches any of them, so inbox text can't become a prompt: the session reads
 * requests through `forge requests`, where they are fenced as data.
 */
export const TURN = Object.freeze({
  type: 'user',
  message: Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: '/forge requests' })]) }),
});
export const TURN_LINE = JSON.stringify(TURN) + '\n';

/**
 * The stdin line for one owner message in a chat, or null for anything but a string that is non-empty
 * once trimmed and at most CHAT_MESSAGE_MAX characters. JSON.stringify escapes every newline and quote,
 * so the text stays one user line whatever it holds and can never become a control line.
 */
export function chatMessageLine(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim() || text.length > CHAT_MESSAGE_MAX) return null;
  return userLine(text);
}

/** The longest brief a role child or gate run is sent: far above any CLI-built brief, which holds paths and lines, not files. */
export const BRIEF_MAX_CHARS = 200_000;

const userLine = (text: string): string => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) + '\n';

/**
 * The stdin line carrying a role child's or gate run's brief, its first user message, or null for anything but a
 * string that is non-empty once trimmed and at most BRIEF_MAX_CHARS characters. Built like
 * chatMessageLine: JSON.stringify escapes every newline and quote, so the brief stays one user line.
 */
export function briefLine(text: unknown): string | null {
  if (typeof text !== 'string' || !text.trim() || text.length > BRIEF_MAX_CHARS) return null;
  return userLine(text);
}

/** The fixed message a gate run sends once when the assistant's reply did not end with a well-formed verdict line. */
export const VERDICT_RETRY_LINE = userLine(
  'Your reply did not end with the line Forge needs. Reply with exactly one line: `ASSIST: approve|revise|rework|escalate · <reason>`, the reason under 200 characters without quotes, backticks, $ or backslashes.',
);

/** The most of a result line's `result` text a working turn reports (a gate run's verdict is its last line). */
export const RESULT_TEXT_MAX = 4000;

/** The control_request line asking claude to switch the session's permission mode. */
function modeRequest(requestId: string, mode: DaemonPermissionMode): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } }) + '\n';
}

/** What a denied tool call returns to the agent. Fixed text: nothing a human types reaches the session. */
export const PERMISSION_DENIED =
  'A human denied this tool call from the Forge dashboard. Do not retry it or work around it with another tool: continue without it, or record what you needed and why in your output file.';
/** What a tool call outside the allowed list returns to an unattended role child, where no one is there to approve it. Fixed text. */
export const UNATTENDED_DENIED =
  'This role runs unattended: no one is there to approve tool calls outside its allowed list, so this one was denied. Do not retry it or work around it with another tool: continue without it, and record what you needed and why in your output file.';
/**
 * The longest tool input a prompt shows. It is never truncated: what the human reads is exactly
 * what an allow runs, so a longer input is denied without asking.
 */
export const PROMPT_INPUT_CHARS = 4000;
const PROMPT_TEXT_CHARS = 500;
const PROMPT_PATH_CHARS = 1000;
const ID_CHARS = 200;
export const STDERR_CAP = 4096;

export const cap = (v: unknown, n: number): string | null => (typeof v === 'string' && v ? (v.length > n ? `${v.slice(0, n)}…` : v) : null);
const record = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

/** The updatedPermissions "allow for this session" sends: claude's own suggestions, rebuilt from their checked fields. */
export interface SessionGrant {
  rules: { toolName: string; ruleContent?: string }[];
  dirs: string[];
}

/**
 * The parts of claude's `permission_suggestions` the supervisor may grant: allow rules and extra
 * directories, always for this session only. A suggestion to save rules to a settings file or to
 * change the permission mode is dropped, because either outlives the human's view of this call.
 * So is a rule that would allow a tool's every call (a bare tool name, or a wildcard-only pattern):
 * the human saw one call, and a grant that wide is a config change, not an answer to it.
 */
export function sessionGrant(suggestions: unknown): SessionGrant {
  const rules: SessionGrant['rules'] = [];
  const dirs: string[] = [];
  for (const raw of Array.isArray(suggestions) ? suggestions.slice(0, 20) : []) {
    const sug = record(raw);
    if (sug.type === 'addRules' && sug.behavior === 'allow' && Array.isArray(sug.rules)) {
      for (const r of sug.rules.slice(0, 20).map(record)) {
        if (typeof r.toolName !== 'string' || !r.toolName || r.toolName.length > 200) continue;
        if (typeof r.ruleContent !== 'string' || r.ruleContent.length > PROMPT_INPUT_CHARS || WILDCARD_RULE.test(r.ruleContent)) continue;
        rules.push({ toolName: r.toolName, ruleContent: r.ruleContent });
      }
    } else if (sug.type === 'addDirectories' && Array.isArray(sug.directories)) {
      for (const d of sug.directories.slice(0, 20)) if (typeof d === 'string' && path.isAbsolute(d) && d.length <= PROMPT_PATH_CHARS) dirs.push(d);
    }
  }
  return { rules, dirs };
}

/** A rule content that matches everything: only `*`, `:` and whitespace (`*`, `:*`, `**`). */
const WILDCARD_RULE = /^[\s*:]*$/;

/** A rule as claude's settings write it: `Bash(npm test)`, or a bare tool name. */
export function ruleText(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`;
}

/**
 * The control_response line answering a `can_use_tool` request. An allow echoes the input claude
 * sent, unchanged; a deny carries PERMISSION_DENIED, or UNATTENDED_DENIED when `why` is `unattended`.
 * The human picks only the decision.
 */
function permissionResponse(requestId: string, decision: PermissionDecision, input: Record<string, unknown>, grant: SessionGrant, why?: 'unattended'): string {
  let response: Record<string, unknown>;
  if (decision === 'deny') response = { behavior: 'deny', message: why === 'unattended' ? UNATTENDED_DENIED : PERMISSION_DENIED };
  else {
    response = { behavior: 'allow', updatedInput: input };
    if (decision === 'session') {
      const updates: Record<string, unknown>[] = [];
      if (grant.rules.length) updates.push({ type: 'addRules', rules: grant.rules, behavior: 'allow', destination: 'session' });
      if (grant.dirs.length) updates.push({ type: 'addDirectories', directories: grant.dirs, destination: 'session' });
      if (updates.length) response.updatedPermissions = updates;
    }
  }
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
}

/**
 * A failed turn whose message says the account is out of quota, not that the request is broken:
 * it is retried for as long as it takes, never counted as a strike. Claude Code's wording for the
 * subscription windows and the API's 400 for a spend cap ("usage limits"), 429 and 529 all match.
 */
export const LIMIT_TEXT = /usage limit|rate limit|limit reached|hit your limit|too many requests|\b429\b|overloaded|\b529\b/i;

/**
 * A failed turn whose message reads like an expired or missing login: retrying can't help until a
 * human logs in again. Only checked when the turn is neither a quota limit nor the dollar cap.
 */
export const AUTH_TEXT = /\/login\b|not logged in|invalid api key|invalid x-api-key|oauth token|token (has )?expired|authentication[_ ]error|\b401\b/i;

/** The longest summary an ok result gives: its first non-empty line, as `forge job agent end --summary` keeps it. */
const SUMMARY_CHARS = 280;

/** The first non-empty line of a result's text, trimmed and cut to SUMMARY_CHARS; null without one. */
function firstLine(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const line = v.split('\n').find((l) => l.trim());
  return line ? line.trim().slice(0, SUMMARY_CHARS) : null;
}

/** The part of a `rate_limit_event` the supervisor uses: whether the last request was refused, and when the window resets. */
export interface RateLimitInfo {
  status: string;
  /** ms since the epoch */
  resetsAt: number | null;
}

/** Reads `rate_limit_info` from a `rate_limit_event` line tolerantly; the shape is Claude Code's, not a contract. */
export function parseRateLimit(info: unknown): RateLimitInfo | null {
  if (!info || typeof info !== 'object') return null;
  const r = info as Record<string, unknown>;
  if (typeof r.status !== 'string') return null;
  const raw = typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) && r.resetsAt > 0 ? r.resetsAt : null;
  // Observed as epoch seconds; accept milliseconds too, in case that changes.
  const resetsAt = raw === null ? null : raw < 1e12 ? Math.round(raw * 1000) : Math.round(raw);
  return { status: r.status, resetsAt };
}

/** What a `tool-use` event keeps of one assistant line: this many distinct tool names, each cut to this many characters. */
const MAX_TOOLS_PER_LINE = 20;
const TOOL_NAME_CHARS = 100;
const MAX_COST_MODELS = 20;
const costCount = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/**
 * The cost a result line reports: `total_cost_usd` and up to 20 `modelUsage` entries, each number finite
 * and >= 0 or else 0. Null when it carries neither. The supervisor meters it (lib/office/session/meter.ts),
 * so a model name is a short string and never `__proto__`.
 */
export function resultCost(ev: Record<string, any>): SessionCost | null {
  const total = ev.total_cost_usd;
  const usd = typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : null;
  const entries = Object.entries(record(ev.modelUsage))
    .slice(0, MAX_COST_MODELS)
    .filter(([name]) => name && name.length <= 100 && name !== '__proto__')
    .map(([name, raw]): [string, ModelCost] => {
      const m = record(raw);
      return [name, { usd: costCount(m.costUSD), input: costCount(m.inputTokens), output: costCount(m.outputTokens), cacheRead: costCount(m.cacheReadInputTokens), cacheWrite: costCount(m.cacheCreationInputTokens) }];
    });
  if (usd === null && !entries.length) return null;
  return { usd, models: Object.fromEntries(entries) };
}

/**
 * claude stamps only its assistant and user lines (`timestamp`); its system, result and
 * progress events carry no time at all. Those get the receipt time as `at`, the key the
 * supervisor's own events use, so the dashboard can show a time on every line. A line that
 * already has either key is logged verbatim.
 */
export function stamped(ev: any, line: string): string {
  if (Array.isArray(ev) || typeof ev.timestamp === 'string' || typeof ev.at === 'string') return line;
  return JSON.stringify({ ...ev, at: now() });
}

/**
 * Byte-capped line splitter, so one runaway line can't grow memory without bound. A line longer
 * than `max` is dropped up to its newline and reported through `onTooLong`; with no
 * `onTooLong` its first `max` bytes are kept instead.
 */
export function splitter(max: number, onLine: (line: string) => void, onTooLong: ((bytes: number) => void) | null): (data: Buffer | string) => void {
  let parts: Buffer[] = [];
  let size = 0;
  let dropping = false;
  let dropped = 0;
  return (data: Buffer | string) => {
    const chunk = typeof data === 'string' ? Buffer.from(data) : data;
    let start = 0;
    while (start <= chunk.length) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      const piece = chunk.subarray(start, end);
      if (dropping) dropped += piece.length;
      else if (size + piece.length > max) {
        dropping = true;
        dropped = size + piece.length;
        if (onTooLong) parts = [];
        else parts.push(piece.subarray(0, max - size));
        size = 0;
      } else if (piece.length) {
        parts.push(piece);
        size += piece.length;
      }
      if (nl === -1) break;
      if (dropping && onTooLong) onTooLong(dropped);
      else {
        const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '');
        if (line.trim()) onLine(line);
      }
      parts = [];
      size = 0;
      dropping = false;
      dropped = 0;
      start = nl + 1;
    }
  };
}

/** One child's protocol: feed it stdout and stderr chunks, and it emits events and writes answers through `write`. */
export interface ClaudeStream {
  stdout(chunk: Buffer | string): void;
  stderr(chunk: Buffer | string): void;
  writeTurn(): void;
  /** Writes one owner message (chatMessageLine); false, writing nothing, for a text it refuses. */
  writeMessage(text: string): boolean;
  /** Writes a role child's or gate run's brief (briefLine); false, writing nothing, for a text it refuses. */
  writeBrief(text: string): boolean;
  /** Writes VERDICT_RETRY_LINE. */
  writeVerdictRetry(): void;
  answerPermission(requestId: string, decision: PermissionDecision, why?: 'unattended'): boolean;
  setPermissionMode(mode: DaemonPermissionMode): string | null;
}

/**
 * One child's protocol state. Each stdout line emits its `log` event first, then what it means. The
 * input and grant of every `can_use_tool` request still waiting are kept here, so an allow echoes
 * claude's own input and the office never supplies it.
 */
export function createStream(write: (line: string) => void, emit: (e: ClaudeEvent) => void, maxLineBytes: number): ClaudeStream {
  const pending = new Map<string, { input: Record<string, unknown>; grant: SessionGrant }>();
  /** Mode switches sent and not yet answered: a response to any other id is ignored. */
  const modeIds = new Set<string>();
  /** The last rate_limit_event since the last written turn. */
  let rateLimit: RateLimitInfo | null = null;
  /** The context of the last main-loop assistant line since the last result; null while none carried a usage. */
  let context: number | null = null;
  /** Whether this stream's `first-request` event is out: once per stream, never per turn. */
  let firstSent = false;

  function onLine(line: string): void {
    let ev: any = null;
    try {
      ev = JSON.parse(line);
    } catch {}
    if (!ev || typeof ev !== 'object') {
      emit({ kind: 'log', stream: 'stdout', line: JSON.stringify({ type: 'forge-raw', at: now(), text: line }) });
      return emit({ kind: 'unreadable-line' });
    }
    emit({ kind: 'log', stream: 'stdout', line: stamped(ev, line) });
    if (ev.type === 'system') onSystem(ev);
    else if (ev.type === 'control_request') onControl(ev);
    else if (ev.type === 'control_response') onControlResponse(record(ev.response));
    else if (ev.type === 'control_cancel_request') {
      if (typeof ev.request_id === 'string' && pending.delete(ev.request_id)) emit({ kind: 'permission-cancelled', requestId: ev.request_id });
    } else if (ev.type === 'rate_limit_event') rateLimit = parseRateLimit(ev.rate_limit_info) ?? rateLimit;
    else if (ev.type === 'result') onResult(ev);
    else if (ev.type === 'assistant') onAssistant(ev);
  }

  /**
   * One API call's context: its input, cache-read and cache-creation tokens, each finite and >= 0 or else 0.
   * Only a main-loop line counts: a subagent's (a non-empty parent_tool_use_id) runs in its own context.
   * The stream's first such line also emits `first-request`: whether a fork's opening call read its context from the cache.
   * A main-loop line's `tool_use` blocks emit `tool-use` with their distinct names (a block without a usable name reads
   * `unknown`). The cap counts distinct names, never blocks: a line of 20 Reads and then a Bash still reports both, and a
   * line with 20 distinct names holds 19 that are not `Read`, which is as much as a caller needs to refuse it.
   */
  function onAssistant(ev: Record<string, any>): void {
    if (typeof ev.parent_tool_use_id === 'string' && ev.parent_tool_use_id) return;
    const message = record(ev.message);
    const names = new Set<string>();
    for (const raw of Array.isArray(message.content) ? message.content : []) {
      const block = record(raw);
      if (block.type !== 'tool_use') continue;
      names.add(typeof block.name === 'string' && block.name ? block.name.slice(0, TOOL_NAME_CHARS) : 'unknown');
      if (names.size >= MAX_TOOLS_PER_LINE) break;
    }
    if (names.size) emit({ kind: 'tool-use', names: [...names] });
    const usage = message.usage;
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return;
    const input = costCount(usage.input_tokens);
    const cacheRead = costCount(usage.cache_read_input_tokens);
    const cacheWrite = costCount(usage.cache_creation_input_tokens);
    context = input + cacheRead + cacheWrite;
    if (firstSent) return;
    firstSent = true;
    emit({ kind: 'first-request', input, cacheRead, cacheWrite });
  }

  function onSystem(ev: Record<string, any>): void {
    if (ev.subtype === 'init') {
      emit({ kind: 'turn-started' });
      if (typeof ev.session_id === 'string' && ev.session_id) emit({ kind: 'session-id', id: ev.session_id });
    }
    // claude reports its mode at each turn's init and in a status event after every switch.
    if (ev.subtype === 'init' || ev.subtype === 'status') {
      const mode = cap(ev.permissionMode, 40);
      if (mode !== null) emit({ kind: 'permission-mode', mode });
    }
    if (ev.subtype === 'background_tasks_changed' && Array.isArray(ev.tasks)) emit({ kind: 'background', count: ev.tasks.length });
  }

  /**
   * A `control_request` from claude. `can_use_tool` is asked of the office; claude sends no other
   * subtype unless asked to, so any other gets an error rather than leaving claude waiting.
   */
  function onControl(ev: Record<string, any>): void {
    const requestId = ev.request_id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > ID_CHARS) return emit({ kind: 'protocol-error', message: 'ignored a control_request without a usable request_id' });
    const req = record(ev.request);
    if (req.subtype !== 'can_use_tool') {
      const error = `forge does not handle ${String(req.subtype).slice(0, 40)} control requests`;
      return write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }) + '\n');
    }
    // A repeated id would replace the input the first prompt's allow runs while the office still shows both,
    // so the human could allow one call and run the other. The first request keeps its id; the repeat is dropped.
    if (pending.has(requestId)) return emit({ kind: 'protocol-error', message: 'ignored a can_use_tool request whose request_id is already waiting for an answer' });
    const input = record(req.input);
    let json: string | null = null;
    try {
      json = JSON.stringify(input) ?? null;
    } catch {}
    const grant = sessionGrant(req.permission_suggestions);
    pending.set(requestId, { input, grant });
    const tool = typeof req.tool_name === 'string' && req.tool_name && req.tool_name.length <= 200 ? req.tool_name : null;
    emit({
      kind: 'permission-asked',
      requestId,
      tool,
      input: json,
      description: cap(req.description, PROMPT_TEXT_CHARS),
      agentId: cap(req.agent_id, 64),
      blockedPath: cap(req.blocked_path, PROMPT_PATH_CHARS),
      rules: grant.rules.map(ruleText),
      dirs: grant.dirs,
    });
  }

  /** claude's answer to a control_request sent from here: only mode switches ever are. */
  function onControlResponse(res: Record<string, any>): void {
    const requestId = res.request_id;
    if (typeof requestId !== 'string' || !modeIds.delete(requestId)) return;
    const ok = res.subtype === 'success';
    emit({ kind: 'mode-answer', requestId, ok, error: ok ? null : cap(res.error, PROMPT_TEXT_CHARS) });
  }

  /**
   * claude reports an API failure (an expired login, an exhausted quota) as a result with is_error,
   * often with subtype "success". It is a quota limit when a rate_limit_event since the last written
   * turn said `rejected`, or when its text reads like one; a login failure when it is neither that nor
   * the dollar cap and its text reads like AUTH_TEXT. Either carries the turn's context when it had one,
   * and the next turn starts unmeasured.
   */
  function onResult(ev: Record<string, any>): void {
    const cost = resultCost(ev);
    const measured = context !== null ? { context } : {};
    context = null;
    // The --max-budget-usd stop is a failed turn whatever is_error says, and never a quota limit to wait out.
    const budget = ev.subtype === 'error_max_budget_usd';
    if (ev.is_error !== true && !budget) return emit({ kind: 'turn-ended', ok: true, summary: firstLine(ev.result), cost, text: typeof ev.result === 'string' ? ev.result.slice(-RESULT_TEXT_MAX) : null, ...measured });
    const reason = (typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : String(ev.subtype ?? 'error')).slice(0, 300);
    const rejected = rateLimit?.status === 'rejected';
    const limit = budget ? false : rejected || LIMIT_TEXT.test(reason);
    emit({ kind: 'turn-ended', ok: false, reason, limit, auth: !limit && !budget && AUTH_TEXT.test(reason), resetsAt: rejected && !budget ? rateLimit!.resetsAt : null, budget, cost, ...measured });
  }

  return {
    stdout: splitter(maxLineBytes, onLine, (bytes) => emit({ kind: 'line-too-long', bytes })),
    stderr: splitter(STDERR_CAP, (text) => emit({ kind: 'log', stream: 'stderr', line: JSON.stringify({ type: 'forge-stderr', at: now(), text }) }), null),
    writeTurn() {
      rateLimit = null;
      write(TURN_LINE);
    },
    writeMessage(text) {
      const msg = chatMessageLine(text);
      if (msg === null) return false;
      rateLimit = null;
      write(msg);
      return true;
    },
    writeBrief(text) {
      const line = briefLine(text);
      if (line === null) return false;
      rateLimit = null;
      write(line);
      return true;
    },
    writeVerdictRetry() {
      rateLimit = null;
      write(VERDICT_RETRY_LINE);
    },
    answerPermission(requestId, decision, why) {
      const p = pending.get(requestId);
      if (!p) return false;
      pending.delete(requestId);
      write(permissionResponse(requestId, decision, p.input, p.grant, why));
      return true;
    },
    setPermissionMode(mode) {
      if (!PERMISSION_MODES.includes(mode)) return null;
      const requestId = `forge-mode-${crypto.randomUUID()}`;
      modeIds.add(requestId);
      write(modeRequest(requestId, mode));
      return requestId;
    },
  };
}
