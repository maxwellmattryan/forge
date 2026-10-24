// The shapes of a headless Claude Code child as the office sees it: the domain events its stream-json
// output means (ClaudeEvent), the handle that is the only way to write to it (ClaudeChild), and the
// adapter that starts one (ClaudeAdapter).
import type { DaemonPermissionMode, PermissionDecision } from '#core/types.ts';

/** One model's share of a result line's `modelUsage`: dollars and the four token counts, each finite and >= 0. */
export interface ModelCost {
  usd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * What a result line says the conversation has cost so far. Both figures are cumulative per conversation,
 * carry over a --resume and include background subagents. `usd` is null when `total_cost_usd` was unusable.
 */
export interface SessionCost {
  usd: number | null;
  models: Record<string, ModelCost>;
}

/** What one line (or the process) of a claude child means. Every field is claude's text, so untrusted. */
export type ClaudeEvent =
  /** Ready for the session log: claude's own JSON line (stamped), a `forge-raw` or a `forge-stderr` line. */
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  /** A stdout line over maxLineBytes was dropped unread. */
  | { kind: 'line-too-long'; bytes: number }
  /** claude started a turn (its system/init). */
  | { kind: 'turn-started' }
  /** The session id an init reported: a non-empty string, not yet checked to be a uuid. */
  | { kind: 'session-id'; id: string }
  /** The permission mode claude reported, capped at 40 characters. */
  | { kind: 'permission-mode'; mode: string }
  /** How many background tasks claude says are running. */
  | { kind: 'background'; count: number }
  /** A tool call waiting on a human. `input` is the call's JSON, or null when it can't be serialised; `tool` is null when unusable. */
  | {
      kind: 'permission-asked';
      requestId: string;
      tool: string | null;
      input: string | null;
      description: string | null;
      agentId: string | null;
      blockedPath: string | null;
      /** The rules an answer of `session` grants, as claude's settings write them. */
      rules: string[];
      /** The extra directories an answer of `session` grants. */
      dirs: string[];
    }
  /** claude withdrew a request it asked (its turn was interrupted). */
  | { kind: 'permission-cancelled'; requestId: string }
  /** claude's answer to a mode switch this child's handle sent. */
  | { kind: 'mode-answer'; requestId: string; ok: boolean; error: string | null }
  /** A working turn; `cost` is claude's own cumulative cost report on the result line (resultCost), null when it sent none. */
  | { kind: 'turn-ended'; ok: true; cost?: SessionCost | null }
  /**
   * A failed turn: `limit` when it was a quota refusal, `resetsAt` (ms) when claude said when the window resets,
   * `budget` when the child reached its --max-budget-usd cap (never a limit: retrying can't lift it).
   */
  | { kind: 'turn-ended'; ok: false; reason: string; limit: boolean; resetsAt: number | null; budget: boolean; cost?: SessionCost | null }
  /** A line that broke the protocol and was answered with nothing. */
  | { kind: 'protocol-error'; message: string }
  /** The process failed; `started` is false when it never ran (ENOENT, EACCES). */
  | { kind: 'process-error'; message: string; started: boolean }
  /** Writing to its stdin failed (EPIPE from a child that died mid-write). */
  | { kind: 'stdin-error'; message: string }
  /** The process closed. Sent once, last. */
  | { kind: 'exit'; code: number | null; signal: string | null };

/** One running claude child. Every line it writes to claude is built from fixed text or a fixed list. */
export interface ClaudeChild {
  readonly pid: number | null;
  /** Whether its stdout is paused (backpressure from a full log). */
  readonly paused: boolean;
  /** Resolves once the process has closed. */
  readonly closed: Promise<void>;
  /** Writes the one fixed turn, `/forge requests`. */
  writeTurn(): void;
  /** Answers a request claude asked; false, writing nothing, when it is not waiting (answered, cancelled or unknown). */
  answerPermission(requestId: string, decision: PermissionDecision): boolean;
  /** Asks claude to switch mode; returns the request id, or null for a mode outside PERMISSION_MODES. */
  setPermissionMode(mode: DaemonPermissionMode): string | null;
  /** Ends its stdin. */
  endInput(): void;
  /** Signals the child's process group, synchronously. */
  signal(sig: NodeJS.Signals): void;
  pause(): void;
  resume(): void;
}

/** Starts claude children: the real one (lib/integrations/claude/child.ts claudeAdapter) or a test's fake. */
export interface ClaudeAdapter {
  /** Throws when the process can't be created. Events start after it returns. */
  start(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; maxLineBytes: number }, onEvent: (e: ClaudeEvent) => void): ClaudeChild;
}
