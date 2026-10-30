// A code turn's permission prompts: each role run (`forge job agent run --ipc`) sends its child's `can_use_tool` asks to
// the code driver over IPC, and the relay shows them in the dashboard, answers each to the runner that asked, and denies
// unasked what control.ts would deny a session's (too many waiting, an input it can't show whole, an unusable tool name).
// It mirrors lib/office/session/permissions/control.ts but holds prompts from several runners at once, so it is its own
// module. Every IPC field is checked by type and length before use; a message that fails is dropped.
import crypto from 'node:crypto';
import { PROMPT_INPUT_CHARS } from '#integrations/claude/stream.ts';
import { logEvent as logJobEvent } from '#core/job/store.ts';
import { SAFE_TOOL } from '#core/text.ts';
import { now } from '#core/utils.ts';
import { MAX_PROMPTS, MAX_TIMED_OUT } from '../session/permissions/control.ts';
import { recordPrompt, type PromptReason } from '../session/permissions/history.ts';
import type { Redactor } from '../session/contract.ts';
import type { Config, DaemonPermissionPrompt, DaemonTimedOutPrompt, EventActor, PermissionDecision } from '#core/types.ts';

/** The runner a prompt is answered through: startForge's `send` (./children.ts). */
export interface RelayRunner {
  send(msg: unknown): boolean;
}

export interface RelayDeps {
  root: string;
  /** The job scope the turn drives. */
  scope: string;
  config(): Config;
  /** A test's timeout over daemon.permissionTimeoutMinutes, and the scope's known values for the prompt history. */
  o: { permissionTimeoutMs: number | null; redactor: Redactor };
  /** A line in the scope's log. */
  logEvent(event: string, extra?: Record<string, unknown>): void;
  /** The prompts changed: the dashboard's state is stale. */
  changed(): void;
}

/** setTimeout's own ceiling (about 24.8 days); a longer timeout is none. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** The caps stream.ts puts on what claude sent (lib/integrations/claude/stream.ts permission-asked), checked again here. */
const ID_CHARS = 200;
const TEXT_CHARS = 500;
const AGENT_CHARS = 64;
const PATH_CHARS = 1000;
const RULE_CHARS = PROMPT_INPUT_CHARS + 210;
const LIST_MAX = 20;

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const nullableStr = (v: unknown, max: number): v is string | null => v === null || str(v, max);
const strList = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= LIST_MAX && v.every((x) => str(x, max));

/** An `ask` from a runner, every field checked; null for anything else. */
function readAsk(msg: unknown): { requestId: string; tool: string | null; input: string | null; description: string | null; agentId: string | null; blockedPath: string | null; rules: string[]; dirs: string[] } | null {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return null;
  const m = msg as Record<string, unknown>;
  if (!str(m.requestId, ID_CHARS) || !m.requestId) return null;
  if (!nullableStr(m.tool, ID_CHARS) || !(m.input === null || typeof m.input === 'string')) return null;
  if (!nullableStr(m.description, TEXT_CHARS) || !nullableStr(m.agentId, AGENT_CHARS) || !nullableStr(m.blockedPath, PATH_CHARS)) return null;
  if (!strList(m.rules, RULE_CHARS) || !strList(m.dirs, PATH_CHARS)) return null;
  return { requestId: m.requestId, tool: m.tool || null, input: m.input as string | null, description: m.description, agentId: m.agentId, blockedPath: m.blockedPath, rules: [...m.rules], dirs: [...m.dirs] };
}

/** One code turn's relay: the prompts its runners asked, by the supervisor's own id. */
export function createRelay(d: RelayDeps) {
  const prompts = new Map<string, { runner: RelayRunner; requestId: string; prompt: DaemonPermissionPrompt; timer: NodeJS.Timeout | null }>();
  /** Prompts denied at their timeout, newest first, kept for the dashboard. */
  const timedOutPrompts: DaemonTimedOutPrompt[] = [];

  /** An answer sent, into the prompt history, as control.ts records a session's: never its input, nor a rule with a known value. */
  function record(tool: string | null, rules: readonly string[], decision: PermissionDecision, reason: PromptReason | null): void {
    let known: readonly string[] = [];
    let kept = rules;
    try {
      known = d.o.redactor(d.root, d.scope, d.config());
    } catch {
      kept = [];
    }
    recordPrompt(d.root, { scope: d.scope, tool, rules: kept, decision, reason, known });
  }

  const reply = (runner: RelayRunner, requestId: string, decision: PermissionDecision, why?: 'timeout'): boolean =>
    runner.send({ type: 'forge-answer', requestId, decision, ...(why ? { why } : {}) });

  function removePrompt(id: string): void {
    const p = prompts.get(id);
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    prompts.delete(id);
  }

  function timeoutMs(): number | null {
    let ms = d.o.permissionTimeoutMs;
    if (ms === null) {
      let minutes: unknown;
      try {
        minutes = d.config().daemon?.permissionTimeoutMinutes;
      } catch {}
      if (typeof minutes !== 'number') return null;
      ms = minutes * 60_000;
    }
    return Number.isFinite(ms) && ms > 0 && ms <= MAX_TIMER_MS ? ms : null;
  }

  /** Nobody answered in time: denied with the timeout text, never allowed, and only while the prompt still waits. */
  function onTimeout(id: string): void {
    const p = prompts.get(id);
    if (!p) return;
    removePrompt(id);
    if (reply(p.runner, p.requestId, 'deny', 'timeout')) {
      d.logEvent('permission', { id, tool: p.prompt.tool, role: p.prompt.role, decision: 'deny', reason: 'timeout' });
      record(p.prompt.tool, p.prompt.sessionRules, 'deny', 'timeout');
      timedOutPrompts.unshift({ ...p.prompt, deniedAt: now() });
      timedOutPrompts.length = Math.min(timedOutPrompts.length, MAX_TIMED_OUT);
      // The tool name only, checked again: the input may hold secrets.
      try {
        logJobEvent(d.root, d.scope, 'permission-timed-out', { tool: SAFE_TOOL.test(p.prompt.tool) ? p.prompt.tool : 'unknown' });
      } catch {}
    }
    d.changed();
  }

  /** A runner's ask: a prompt the dashboard shows, a deny without asking, or (malformed) nothing. */
  function ask(runner: RelayRunner, role: string, msg: unknown): void {
    const e = readAsk(msg);
    if (!e) return;
    // A request id already waiting from this runner keeps its first prompt: a repeat must not swap the input an allow runs.
    for (const p of prompts.values()) if (p.runner === runner && p.requestId === e.requestId) return;
    const deny = (reason: PromptReason) => {
      d.logEvent('permission', { tool: e.tool ?? 'unknown', role, decision: 'deny', reason });
      if (reply(runner, e.requestId, 'deny')) record(e.tool, e.rules, 'deny', reason);
    };
    if (prompts.size >= MAX_PROMPTS) return deny('too-many');
    if (e.input === null) return deny('unserialisable-input');
    if (e.input.length > PROMPT_INPUT_CHARS) return deny('too-large');
    if (e.tool === null) return deny('unusable-tool-name');
    const id = crypto.randomUUID();
    const prompt: DaemonPermissionPrompt = { id, tool: e.tool, input: e.input, description: e.description, agentId: e.agentId, blockedPath: e.blockedPath, sessionRules: e.rules, sessionDirs: e.dirs, at: now(), role };
    const ms = timeoutMs();
    const timer = ms === null ? null : setTimeout(() => onTimeout(id), ms);
    timer?.unref?.();
    prompts.set(id, { runner, requestId: e.requestId, prompt, timer });
    d.logEvent('permission-asked', { id, tool: e.tool, role });
    d.changed();
  }

  /** claude withdrew a request: its prompt goes away unanswered. A malformed id matches nothing. */
  function cancel(runner: RelayRunner, requestId: unknown): void {
    if (!str(requestId, ID_CHARS)) return;
    for (const [id, p] of prompts) {
      if (p.runner !== runner || p.requestId !== requestId) continue;
      removePrompt(id);
      d.logEvent('permission-cancelled', { id, tool: p.prompt.tool, role: p.prompt.role });
      d.changed();
    }
  }

  /** The runner is gone, so nothing can answer its prompts. */
  function drop(runner: RelayRunner): void {
    let any = false;
    for (const [id, p] of prompts) {
      if (p.runner !== runner) continue;
      removePrompt(id);
      any = true;
    }
    if (any) d.changed();
  }

  /** A human's answer, sent to the runner that asked only; returns the tool, or null when no such prompt waits or the runner is gone. */
  function answer(id: string, decision: PermissionDecision, actor?: EventActor): string | null {
    const p = prompts.get(id);
    if (!p) return null;
    removePrompt(id);
    const sent = reply(p.runner, p.requestId, decision);
    if (sent) {
      d.logEvent('permission', { id, tool: p.prompt.tool, role: p.prompt.role, decision, ...(actor ? { actor } : {}) });
      record(p.prompt.tool, p.prompt.sessionRules, decision, decision === 'deny' ? 'human' : null);
    }
    d.changed();
    return sent ? p.prompt.tool : null;
  }

  /** A runner's IPC message: an `ask` or a `cancel` from `forge job agent run --ipc`; anything else (another type or event) is ignored. */
  function message(runner: RelayRunner, role: string, msg: unknown): void {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
    const m = msg as Record<string, unknown>;
    if (m.type !== 'forge-role') return;
    if (m.event === 'ask') ask(runner, role, m);
    else if (m.event === 'cancel') cancel(runner, m.requestId);
  }

  const permissions = (): DaemonPermissionPrompt[] => [...prompts.values()].map((p) => p.prompt);
  const timedOut = (): DaemonTimedOutPrompt[] => timedOutPrompts.map((p) => ({ ...p }));
  /** Every prompt goes, with its timer: the turn ended. */
  const clear = (): void => {
    for (const id of [...prompts.keys()]) removePrompt(id);
  };

  return { message, ask, cancel, drop, answer, permissions, timedOut, clear };
}

export type Relay = ReturnType<typeof createRelay>;
