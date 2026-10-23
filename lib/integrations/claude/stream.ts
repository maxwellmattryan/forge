// Claude Code's stream-json protocol, with no I/O of its own: claude's output lines become ClaudeEvents,
// and every line written to its stdin is built here, from fixed text or a fixed list: the one turn,
// permission answers and mode switches. Nothing from requests, HTTP or config reaches any of them
// (docs/ARCHITECTURE.md "Daemon security").
import crypto from 'node:crypto';
import path from 'node:path';
import { now } from '#core/utils.ts';
import { PERMISSION_MODES } from './argv.ts';
import type { ClaudeEvent } from './types.ts';
import type { DaemonPermissionMode, PermissionDecision } from '#core/types.ts';

/**
 * The only user message the daemon ever writes to the child's stdin; the only other lines are
 * permission answers (permissionResponse) and mode switches (modeRequest), whose only variable part
 * is a value from a fixed list. Nothing from requests, HTTP or config reaches either,
 * so inbox text can't become a prompt: the session reads requests through `forge requests`,
 * where they are fenced as data.
 */
export const TURN = Object.freeze({
  type: 'user',
  message: Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: '/forge requests' })]) }),
});
export const TURN_LINE = JSON.stringify(TURN) + '\n';

/** The control_request line asking claude to switch the session's permission mode. */
function modeRequest(requestId: string, mode: DaemonPermissionMode): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } }) + '\n';
}

/** What a denied tool call returns to the agent. Fixed text: nothing a human types reaches the session. */
export const PERMISSION_DENIED =
  'A human denied this tool call from the Forge dashboard. Do not retry it or work around it with another tool: continue without it, or record what you needed and why in your output file.';
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
 * sent, unchanged; a deny carries PERMISSION_DENIED. The human picks only the decision.
 */
function permissionResponse(requestId: string, decision: PermissionDecision, input: Record<string, unknown>, grant: SessionGrant): string {
  let response: Record<string, unknown>;
  if (decision === 'deny') response = { behavior: 'deny', message: PERMISSION_DENIED };
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
  answerPermission(requestId: string, decision: PermissionDecision): boolean;
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

  function onLine(line: string): void {
    let ev: any = null;
    try {
      ev = JSON.parse(line);
    } catch {}
    if (!ev || typeof ev !== 'object') return emit({ kind: 'log', stream: 'stdout', line: JSON.stringify({ type: 'forge-raw', at: now(), text: line }) });
    emit({ kind: 'log', stream: 'stdout', line: stamped(ev, line) });
    if (ev.type === 'system') onSystem(ev);
    else if (ev.type === 'control_request') onControl(ev);
    else if (ev.type === 'control_response') onControlResponse(record(ev.response));
    else if (ev.type === 'control_cancel_request') {
      if (typeof ev.request_id === 'string' && pending.delete(ev.request_id)) emit({ kind: 'permission-cancelled', requestId: ev.request_id });
    } else if (ev.type === 'rate_limit_event') rateLimit = parseRateLimit(ev.rate_limit_info) ?? rateLimit;
    else if (ev.type === 'result') onResult(ev);
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
   * turn said `rejected`, or when its text reads like one.
   */
  function onResult(ev: Record<string, any>): void {
    if (ev.is_error !== true) return emit({ kind: 'turn-ended', ok: true });
    const reason = (typeof ev.result === 'string' && ev.result.trim() ? ev.result.trim() : String(ev.subtype ?? 'error')).slice(0, 300);
    const rejected = rateLimit?.status === 'rejected';
    emit({ kind: 'turn-ended', ok: false, reason, limit: rejected || LIMIT_TEXT.test(reason), resetsAt: rejected ? rateLimit!.resetsAt : null });
  }

  return {
    stdout: splitter(maxLineBytes, onLine, (bytes) => emit({ kind: 'line-too-long', bytes })),
    stderr: splitter(STDERR_CAP, (text) => emit({ kind: 'log', stream: 'stderr', line: JSON.stringify({ type: 'forge-stderr', at: now(), text }) }), null),
    writeTurn() {
      rateLimit = null;
      write(TURN_LINE);
    },
    answerPermission(requestId, decision) {
      const p = pending.get(requestId);
      if (!p) return false;
      pending.delete(requestId);
      write(permissionResponse(requestId, decision, p.input, p.grant));
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
