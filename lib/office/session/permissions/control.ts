// The permission-prompt and mode-switch policy: which prompts a human sees and which are denied
// unasked, the deny a prompt nobody answers within daemon.permissionTimeoutMinutes gets (with the
// session's in-memory history of those and its job's permission-timed-out event), and what a refused
// or unconfirmed mode switch does. Every line it sends claude goes through the child's ClaudeChild,
// which builds it from fixed text (lib/integrations/claude/stream.ts). Every answer sent is also appended,
// without its input and without any rule holding a known secret, to the prompt history `forge daemon prompts` reads (history.ts).
import crypto from 'node:crypto';
import { modeReach } from '#integrations/claude/argv.ts';
import { PROMPT_INPUT_CHARS } from '#integrations/claude/stream.ts';
import type { ClaudeChild, ClaudeEvent } from '#integrations/claude/types.ts';
import { sharedScope, validJobId } from '#core/job/requests.ts';
import { logEvent as logJobEvent } from '#core/job/store.ts';
import { SAFE_TOOL } from '#core/text.ts';
import { now } from '#core/utils.ts';
import type { SessionCore } from '../contract.ts';
import { recordPrompt, type PromptReason } from './history.ts';
import type { DaemonPermissionMode, DaemonPermissionPrompt, DaemonTimedOutPrompt, EventActor, PermissionDecision } from '#core/types.ts';

/** Prompts waiting at once per session (and per code turn, lib/office/code/relay.ts); past this, new ones are denied without asking. */
export const MAX_PROMPTS = 20;
/** Timed-out prompts a session keeps for the dashboard, newest first. */
export const MAX_TIMED_OUT = 10;
/** setTimeout's own ceiling (about 24.8 days); a longer timeout is none. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** One session's control channel: the permission prompts waiting on a human and the mode switches waiting on claude. */
export function createControl(core: SessionCore) {
  const { scope, ctx, o } = core;
  /** Permission prompts waiting on a human, by the supervisor's id, oldest first, each with its timeout (null: none armed). */
  const prompts = new Map<string, { child: ClaudeChild; requestId: string; prompt: DaemonPermissionPrompt; timer: NodeJS.Timeout | null }>();
  /** Prompts denied at their timeout, newest first. Kept across child exits, respawns and reset(); gone with the session. */
  const timedOutPrompts: DaemonTimedOutPrompt[] = [];
  /** Mode switches sent to the current child and not yet answered, by request id, each with its confirmation deadline. */
  const modeRequests = new Map<string, { mode: DaemonPermissionMode; timer: NodeJS.Timeout }>();

  /**
   * An answer claude was sent, into the prompt history; never throws. A rule can be most of the command, so the
   * history drops any rule holding a value the session's log would redact; with those values unreadable no rule is kept.
   */
  function record(tool: string | null, rules: readonly string[], decision: PermissionDecision, reason: PromptReason | null): void {
    let known: readonly string[] = [];
    let kept = rules;
    try {
      known = o.redactor(core.root, scope, ctx.config());
    } catch {
      kept = [];
    }
    recordPrompt(core.root, { scope, tool, rules: kept, decision, reason, known });
  }

  /** The one way a prompt leaves the map, so its timer never outlives it. */
  function removePrompt(id: string): void {
    const p = prompts.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    prompts.delete(id);
  }

  /** Its child is gone, so nothing can answer them. */
  function dropPrompts(): void {
    for (const id of [...prompts.keys()]) removePrompt(id);
    clearModeRequests();
  }

  function clearModeRequests(): void {
    for (const r of modeRequests.values()) clearTimeout(r.timer);
    modeRequests.clear();
  }

  /** The timeout a prompt asked now gets, in ms: the test option, else the config read now; null arms none. */
  function promptTimeoutMs(): number | null {
    let ms = o.permissionTimeoutMs;
    if (ms === null) {
      let minutes: unknown;
      try {
        minutes = ctx.config().daemon?.permissionTimeoutMinutes;
      } catch {}
      if (typeof minutes !== 'number') return null;
      ms = minutes * 60_000;
    }
    return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS ? ms : null;
  }

  /**
   * Nobody answered the prompt in time: it is denied with TIMEOUT_DENIED, never allowed. Only a prompt
   * still pending, asked by the session's current child, is answered, so a timer racing a human's answer,
   * a cancel or a respawn writes nothing.
   */
  function onTimeout(id: string): void {
    const p = prompts.get(id);
    if (!p || core.closed || p.child !== core.child?.claude) return;
    removePrompt(id);
    const sent = p.child.answerPermission(p.requestId, 'deny', 'timeout');
    if (sent) {
      core.logEvent('permission', { id, tool: p.prompt.tool, decision: 'deny', reason: 'timeout' });
      record(p.prompt.tool, p.prompt.sessionRules, 'deny', 'timeout');
      timedOutPrompts.unshift({ ...p.prompt, deniedAt: now() });
      timedOutPrompts.length = Math.min(timedOutPrompts.length, MAX_TIMED_OUT);
      // The tool name only: the input may hold secrets, and claude's tool name is checked again before it reaches the job.
      if (validJobId(scope) && !sharedScope(scope)) {
        try {
          logJobEvent(core.root, scope, 'permission-timed-out', { tool: SAFE_TOOL.test(p.prompt.tool) ? p.prompt.tool : 'unknown' });
        } catch {}
      }
    }
    core.changed();
  }

  /** A tool call claude asked about: a prompt the dashboard shows until a human answers it, or a deny without asking. */
  function onAsked(child: ClaudeChild, e: Extract<ClaudeEvent, { kind: 'permission-asked' }>): void {
    const deny = (reason: PromptReason) => {
      core.logEvent('permission', { tool: e.tool ?? 'unknown', decision: 'deny', reason });
      if (child.answerPermission(e.requestId, 'deny')) record(e.tool, e.rules, 'deny', reason);
    };
    if (prompts.size >= MAX_PROMPTS) return deny('too-many');
    // The dashboard must show the whole input, because an allow runs all of it: a call it can't show
    // whole is refused rather than shown cut short, and so is one whose tool name is unusable.
    if (e.input === null) return deny('unserialisable-input');
    if (e.input.length > PROMPT_INPUT_CHARS) return deny('too-large');
    if (e.tool === null) return deny('unusable-tool-name');
    const id = crypto.randomUUID();
    const prompt: DaemonPermissionPrompt = {
      id,
      tool: e.tool,
      input: e.input,
      description: e.description,
      agentId: e.agentId,
      blockedPath: e.blockedPath,
      sessionRules: e.rules,
      sessionDirs: e.dirs,
      at: now(),
    };
    // Read as the prompt is asked, so a config change applies to the next prompt; a real timer, so it fires even if the session logs nothing else.
    const ms = promptTimeoutMs();
    const timer = ms === null ? null : setTimeout(() => onTimeout(id), ms);
    timer?.unref?.();
    prompts.set(id, { child, requestId: e.requestId, prompt, timer });
    core.logEvent('permission-asked', { id, tool: e.tool });
    core.changed();
  }

  /** claude withdrew a request (its turn was interrupted): the prompt goes away unanswered. */
  function onCancelled(requestId: string): void {
    for (const [id, p] of prompts) {
      if (p.requestId !== requestId) continue;
      removePrompt(id);
      core.logEvent('permission-cancelled', { id, tool: p.prompt.tool });
      core.changed();
    }
  }

  function setPermissionMode(mode: DaemonPermissionMode): boolean {
    const proc = core.child;
    if (!proc) return false;
    const requestId = proc.claude.setPermissionMode(mode);
    if (requestId === null) return false;
    const timer = setTimeout(() => {
      if (!modeRequests.delete(requestId) || core.child !== proc) return;
      modeFailed(mode, `claude did not confirm permission mode ${mode}`);
    }, o.modeConfirmMs);
    timer.unref?.();
    modeRequests.set(requestId, { mode, timer });
    core.logEvent('permission-mode-requested', { mode });
    return true;
  }

  /** claude answered a mode switch the supervisor sent. */
  function onModeAnswer(e: Extract<ClaudeEvent, { kind: 'mode-answer' }>): void {
    const pending = modeRequests.get(e.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    modeRequests.delete(e.requestId);
    const { mode } = pending;
    if (e.ok) return void core.logEvent('permission-mode', { mode });
    modeFailed(mode, `claude refused permission mode ${mode}: ${e.error ?? 'no reason given'}`);
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
    if (!p || p.child !== core.child?.claude) return null;
    removePrompt(id);
    const sent = p.child.answerPermission(p.requestId, decision);
    if (sent) {
      core.logEvent('permission', { id, tool: p.prompt.tool, decision, ...(actor ? { actor } : {}) });
      record(p.prompt.tool, p.prompt.sessionRules, decision, decision === 'deny' ? 'human' : null);
    }
    core.changed();
    return sent ? p.prompt.tool : null;
  }

  /** The prompts state() shows, oldest first. */
  const permissions = (): DaemonPermissionPrompt[] => [...prompts.values()].map((p) => p.prompt);

  /** The prompts denied at their timeout that state() shows, newest first: a copy. */
  const timedOut = (): DaemonTimedOutPrompt[] => timedOutPrompts.map((p) => ({ ...p }));

  return { onAsked, onCancelled, onModeAnswer, setPermissionMode, answerPermission, modeFailed, dropPrompts, clearModeRequests, permissions, timedOut };
}
