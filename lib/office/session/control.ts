// The permission-prompt and mode-switch policy: which prompts a human sees and which are denied
// unasked, and what a refused or unconfirmed mode switch does. Every line it sends claude goes through
// the child's ClaudeChild, which builds it from fixed text (lib/integrations/claude/stream.ts).
import crypto from 'node:crypto';
import { modeReach } from '#integrations/claude/argv.ts';
import { PROMPT_INPUT_CHARS } from '#integrations/claude/stream.ts';
import type { ClaudeChild, ClaudeEvent } from '#integrations/claude/types.ts';
import { now } from '#core/utils.ts';
import type { SessionCore } from './contract.ts';
import type { DaemonPermissionMode, DaemonPermissionPrompt, EventActor, PermissionDecision } from '#core/types.ts';

/** Prompts waiting at once per session; past this, new ones are denied without asking. */
const MAX_PROMPTS = 20;

/** One session's control channel: the permission prompts waiting on a human and the mode switches waiting on claude. */
export function createControl(core: SessionCore) {
  const { scope, ctx, o } = core;
  /** Permission prompts waiting on a human, by the supervisor's id, oldest first. */
  const prompts = new Map<string, { child: ClaudeChild; requestId: string; prompt: DaemonPermissionPrompt }>();
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

  /** A tool call claude asked about: a prompt the dashboard shows until a human answers it, or a deny without asking. */
  function onAsked(child: ClaudeChild, e: Extract<ClaudeEvent, { kind: 'permission-asked' }>): void {
    const deny = (reason: string) => {
      core.logEvent('permission', { tool: e.tool ?? 'unknown', decision: 'deny', reason });
      child.answerPermission(e.requestId, 'deny');
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
    prompts.set(id, { child, requestId: e.requestId, prompt });
    core.logEvent('permission-asked', { id, tool: e.tool });
    core.changed();
  }

  /** claude withdrew a request (its turn was interrupted): the prompt goes away unanswered. */
  function onCancelled(requestId: string): void {
    for (const [id, p] of prompts) {
      if (p.requestId !== requestId) continue;
      prompts.delete(id);
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
    prompts.delete(id);
    const sent = p.child.answerPermission(p.requestId, decision);
    if (sent) core.logEvent('permission', { id, tool: p.prompt.tool, decision, ...(actor ? { actor } : {}) });
    core.changed();
    return sent ? p.prompt.tool : null;
  }

  /** The prompts state() shows, oldest first. */
  const permissions = (): DaemonPermissionPrompt[] => [...prompts.values()].map((p) => p.prompt);

  return { onAsked, onCancelled, onModeAnswer, setPermissionMode, answerPermission, modeFailed, dropPrompts, clearModeRequests, permissions };
}
