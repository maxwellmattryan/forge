// Every line the supervisor writes to claude's stdin, and the control channel: the one fixed turn,
// permission answers and mode switches. Nothing from requests, HTTP or config reaches any of them
// (docs/ARCHITECTURE.md "Daemon security").
import path from 'node:path';
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
export function modeRequest(requestId: string, mode: DaemonPermissionMode): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'set_permission_mode', mode } }) + '\n';
}

/** What a denied tool call returns to the agent. Fixed text: nothing a human types reaches the session. */
export const PERMISSION_DENIED =
  'A human denied this tool call from the Forge dashboard. Do not retry it or work around it with another tool: continue without it, or record what you needed and why in your output file.';
/** Prompts waiting at once per session; past this, new ones are denied without asking. */
export const MAX_PROMPTS = 20;
/**
 * The longest tool input a prompt shows. It is never truncated: what the human reads is exactly
 * what an allow runs, so a longer input is denied without asking.
 */
export const PROMPT_INPUT_CHARS = 4000;
export const PROMPT_TEXT_CHARS = 500;
export const PROMPT_PATH_CHARS = 1000;

export const cap = (v: unknown, n: number): string | null => (typeof v === 'string' && v ? (v.length > n ? `${v.slice(0, n)}…` : v) : null);
export const record = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

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
export function permissionResponse(requestId: string, decision: PermissionDecision, input: Record<string, unknown>, grant: SessionGrant): string {
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
