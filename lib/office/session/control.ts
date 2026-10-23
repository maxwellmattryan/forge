// Every line the supervisor writes to claude's stdin, and the control channel: the one fixed turn,
// permission answers and mode switches. Nothing from requests, HTTP or config reaches any of them
// (docs/ARCHITECTURE.md "Daemon security").
import crypto from 'node:crypto';
import path from 'node:path';
import { PERMISSION_MODES, modeReach } from '#integrations/claude/argv.ts';
import { now } from '#core/utils.ts';
import type { DaemonChild, SessionCore } from './contract.ts';
import type { DaemonPermissionMode, DaemonPermissionPrompt, EventActor, PermissionDecision } from '#core/types.ts';

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
/** Prompts waiting at once per session; past this, new ones are denied without asking. */
const MAX_PROMPTS = 20;
/**
 * The longest tool input a prompt shows. It is never truncated: what the human reads is exactly
 * what an allow runs, so a longer input is denied without asking.
 */
export const PROMPT_INPUT_CHARS = 4000;
const PROMPT_TEXT_CHARS = 500;
const PROMPT_PATH_CHARS = 1000;

export const cap = (v: unknown, n: number): string | null => (typeof v === 'string' && v ? (v.length > n ? `${v.slice(0, n)}…` : v) : null);
const record =(v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {});

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

/** One session's control channel: the permission prompts waiting on a human and the mode switches waiting on claude. */
export function createControl(core: SessionCore) {
  const { scope, ctx, o } = core;
  /** Permission prompts waiting on a human, by the supervisor's id, oldest first. */
  const prompts = new Map<string, { proc: DaemonChild; requestId: string; input: Record<string, unknown>; grant: SessionGrant; prompt: DaemonPermissionPrompt }>();
  /** Mode switches sent to the current child and not yet answered, by request id, each with its confirmation deadline. */
  const modeRequests = new Map<string, { mode: DaemonPermissionMode; timer: NodeJS.Timeout }>();

  /** Its child is gone, so nothing can answer them. */
  function dropPrompts(): void {
    prompts.clear();
    clearModeRequests();
  }

  function clearModeRequests(): void {
    for (const r of modeRequests.values()) clearTimeout(r.timer);
    modeRequests.clear();
  }

  function writeControl(proc: DaemonChild, line: string): void {
    proc.stdin?.write(line);
  }

  /**
   * A `control_request` from claude. `can_use_tool` becomes a prompt the dashboard shows until a
   * human answers it; claude sends no other subtype unless asked to, so any other gets an error
   * rather than leaving claude waiting.
   */
  function onControl(proc: DaemonChild, ev: Record<string, any>): void {
    const requestId = ev.request_id;
    if (typeof requestId !== 'string' || !requestId || requestId.length > 200) return void core.logEvent('error', { message: 'ignored a control_request without a usable request_id' });
    const req = record(ev.request);
    if (req.subtype !== 'can_use_tool') {
      const error = `forge does not handle ${String(req.subtype).slice(0, 40)} control requests`;
      return writeControl(proc, JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error } }) + '\n');
    }
    const tool = cap(req.tool_name, 200) ?? 'unknown';
    const input = record(req.input);
    const deny = (reason: string) => {
      core.logEvent('permission', { tool, decision: 'deny', reason });
      writeControl(proc, permissionResponse(requestId, 'deny', input, { rules: [], dirs: [] }));
    };
    if (prompts.size >= MAX_PROMPTS) return deny('too-many');
    let json: string | undefined;
    try {
      json = JSON.stringify(input);
    } catch {}
    // The dashboard must show the whole input, because an allow runs all of it: a call it can't show
    // whole is refused rather than shown cut short, and so is one whose tool name was cut.
    if (typeof json !== 'string') return deny('unserialisable-input');
    if (json.length > PROMPT_INPUT_CHARS) return deny('too-large');
    if (tool === 'unknown' || tool.endsWith('…')) return deny('unusable-tool-name');
    const grant = sessionGrant(req.permission_suggestions);
    const id = crypto.randomUUID();
    const prompt: DaemonPermissionPrompt = {
      id,
      tool,
      input: json,
      description: cap(req.description, PROMPT_TEXT_CHARS),
      agentId: cap(req.agent_id, 64),
      blockedPath: cap(req.blocked_path, PROMPT_PATH_CHARS),
      sessionRules: grant.rules.map(ruleText),
      sessionDirs: grant.dirs,
      at: now(),
    };
    prompts.set(id, { proc, requestId, input, grant, prompt });
    core.logEvent('permission-asked', { id, tool });
    core.changed();
  }

  /** claude withdrew a request (its turn was interrupted): the prompt goes away unanswered. */
  function onControlCancel(ev: Record<string, any>): void {
    for (const [id, p] of prompts) {
      if (p.requestId !== ev.request_id) continue;
      prompts.delete(id);
      core.logEvent('permission-cancelled', { id, tool: p.prompt.tool });
      core.changed();
    }
  }

  function setPermissionMode(mode: DaemonPermissionMode): boolean {
    if (!core.child || !PERMISSION_MODES.includes(mode)) return false;
    const requestId = `forge-mode-${crypto.randomUUID()}`;
    const proc = core.child;
    const timer = setTimeout(() => {
      if (!modeRequests.delete(requestId) || core.child !== proc) return;
      modeFailed(mode, `claude did not confirm permission mode ${mode}`);
    }, o.modeConfirmMs);
    timer.unref?.();
    modeRequests.set(requestId, { mode, timer });
    writeControl(core.child, modeRequest(requestId, mode));
    core.logEvent('permission-mode-requested', { mode });
    return true;
  }

  /** claude's answer to a control_request the supervisor sent: only mode switches are ever sent. */
  function onControlResponse(ev: Record<string, any>): void {
    const res = record(ev.response);
    const requestId = res.request_id;
    if (typeof requestId !== 'string') return;
    const pending = modeRequests.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    modeRequests.delete(requestId);
    const { mode } = pending;
    if (res.subtype === 'success') return void core.logEvent('permission-mode', { mode });
    modeFailed(mode, `claude refused permission mode ${mode}: ${cap(res.error, PROMPT_TEXT_CHARS) ?? 'no reason given'}`);
  }

  /**
   * A switch claude refused or never confirmed. One that would have widened the session falls back:
   * the dashboard shows the mode the session still runs in. One that would have narrowed it stops
   * the child instead, so the session never keeps more reach than the human chose: its next spawn
   * starts in the chosen mode.
   */
  function modeFailed(mode: DaemonPermissionMode, why: string): void {
    if (modeReach(mode) < modeReach(core.liveMode)) {
      core.logEvent('error', { message: `${why}; stopping the session so it starts in ${mode}` });
      void core.kill('stop', true, 'permission-mode');
      return;
    }
    core.logEvent('error', { message: why });
    ctx.permissionModeRefused(scope, mode, core.liveMode);
    core.changed();
  }

  function answerPermission(id: string, decision: PermissionDecision, actor?: EventActor): string | null {
    const p = prompts.get(id);
    if (!p || p.proc !== core.child) return null;
    prompts.delete(id);
    writeControl(p.proc, permissionResponse(p.requestId, decision, p.input, p.grant));
    core.logEvent('permission', { id, tool: p.prompt.tool, decision, ...(actor ? { actor } : {}) });
    core.changed();
    return p.prompt.tool;
  }

  /** The prompts state() shows, oldest first. */
  const permissions = (): DaemonPermissionPrompt[] => [...prompts.values()].map((p) => p.prompt);

  return { onControl, onControlCancel, onControlResponse, setPermissionMode, answerPermission, modeFailed, dropPrompts, clearModeRequests, permissions };
}
