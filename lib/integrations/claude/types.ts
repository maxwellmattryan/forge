// The shapes of a headless Claude Code child as the office sees it: the domain events its stream-json
// output means (ClaudeEvent), the handle that is the only way to write to it (ClaudeChild), and the
// adapter that starts one (ClaudeAdapter); and the friction counted from a run's transcript (RunCounts).
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
  /** A stdout line that is not a JSON object was logged as `forge-raw` and read no further. */
  | { kind: 'unreadable-line' }
  /** claude started a turn (its system/init). */
  | { kind: 'turn-started' }
  /** The session id an init reported: a non-empty string, not yet checked to be a uuid. */
  | { kind: 'session-id'; id: string }
  /** The permission mode claude reported, capped at 40 characters. */
  | { kind: 'permission-mode'; mode: string }
  /**
   * The stream's first main-loop API call (never a subagent's): its input, cache-read and cache-creation tokens, each
   * finite and >= 0 or else 0. Sent once per stream; a role run's context session (lib/engine/workspace/context-session.ts)
   * reads it to tell a fork that hit the prompt cache from one that missed it.
   */
  | { kind: 'first-request'; input: number; cacheRead: number; cacheWrite: number }
  /**
   * The tool calls of one main-loop assistant line (never a subagent's): the distinct tool names, each capped at 100
   * characters, at most 20 per line (a line with more distinct names holds many that are not `Read`). A context session's
   * child may only Read (lib/engine/workspace/context-session.ts), so the runner reads the names to refuse a context that
   * did anything else.
   */
  | { kind: 'tool-use'; names: string[] }
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
  /**
   * A working turn; `cost` is claude's own cumulative cost report on the result line (resultCost), null when it sent none;
   * `summary` the first non-empty line of its result text (at most 280 characters), null without one.
   * `text` is the result's last 4000 characters, null when it carried none: a gate run reads its verdict there.
   * `context` (on a failed turn too) is the turn's last main-loop API call's input + cache-read + cache-creation
   * tokens, absent when the turn had none: subagent calls never count.
   */
  | { kind: 'turn-ended'; ok: true; summary?: string | null; cost?: SessionCost | null; text?: string | null; context?: number }
  /**
   * A failed turn: `limit` when it was a quota refusal, `resetsAt` (ms) when claude said when the window resets,
   * `budget` when the child reached its --max-budget-usd cap (never a limit: retrying can't lift it), `auth` when
   * it is neither and its text reads like an expired or missing login (stream.ts AUTH_TEXT).
   */
  | { kind: 'turn-ended'; ok: false; reason: string; limit: boolean; auth?: boolean; resetsAt: number | null; budget: boolean; cost?: SessionCost | null; context?: number }
  /** A line that broke the protocol and was answered with nothing. */
  | { kind: 'protocol-error'; message: string }
  /** The process failed; `started` is false when it never ran (ENOENT, EACCES). */
  | { kind: 'process-error'; message: string; started: boolean }
  /** Writing to its stdin failed (EPIPE from a child that died mid-write). */
  | { kind: 'stdin-error'; message: string }
  /** The process closed. Sent once, last. */
  | { kind: 'exit'; code: number | null; signal: string | null };

/** One running claude child. Every line it writes to claude is built from fixed text or a fixed list, except a chat's owner message (writeMessage) and a role child's or gate run's brief (writeBrief). */
export interface ClaudeChild {
  readonly pid: number | null;
  /** Whether its stdout is paused (backpressure from a full log). */
  readonly paused: boolean;
  /** Resolves once the process has closed. */
  readonly closed: Promise<void>;
  /** Writes the one fixed turn, `/forge requests`. */
  writeTurn(): void;
  /** Writes one owner message as a user line (stream.ts chatMessageLine); false, writing nothing, for a text it refuses. Only a chat session calls it. */
  writeMessage(text: string): boolean;
  /** Writes a role child's or gate run's brief as its first user line (stream.ts briefLine); false, writing nothing, for a text it refuses. Only role.ts runRoleChild and a gate run call it. */
  writeBrief(text: string): boolean;
  /** Writes the fixed verdict retry (stream.ts VERDICT_RETRY_LINE). Only a gate run calls it. */
  writeVerdictRetry(): void;
  /**
   * Answers a request claude asked; false, writing nothing, when it is not waiting (answered, cancelled or unknown).
   * A deny with `why` `unattended` carries UNATTENDED_DENIED rather than PERMISSION_DENIED.
   */
  answerPermission(requestId: string, decision: PermissionDecision, why?: 'unattended'): boolean;
  /** Asks claude to switch mode; returns the request id, or null for a mode outside PERMISSION_MODES. */
  setPermissionMode(mode: DaemonPermissionMode): string | null;
  /** Ends its stdin. */
  endInput(): void;
  /** Signals the child's process group, synchronously. */
  signal(sig: NodeJS.Signals): void;
  pause(): void;
  resume(): void;
}

/**
 * One agent run's friction, counted from its transcript (lib/integrations/claude/friction.ts runFriction).
 * Only counts, hashes and charset-limited keys: never transcript text. Each list holds at most 10 entries,
 * highest count first.
 */
export interface RunCounts {
  /** Distinct assistant messages. */
  turns: number;
  /** Distinct tool_use blocks. */
  toolCalls: number;
  /** Errored tool results, by tool name (`other` when unnamed or unusual) and by error key. */
  toolErrors: { total: number; byTool: Record<string, number>; byPrefix: Record<string, number> };
  /** Errored Bash calls that failed 2 or more times with the same command hash, with their first and last turn. */
  repeatedFailures: { key: string; hash: string; count: number; turns: [number, number] }[];
  permissionDenials: { total: number; byTool: Record<string, number> };
  /** Files whose same range was read 3 or more times; `reads` is the highest count. */
  rereads: { file: string; reads: number }[];
  /** Non-zero exits of `forge` commands, by command key and exit code. */
  forgeExits: { key: string; code: number; count: number }[];
  /** The byte cap stopped the read before the end of the file. */
  truncated: boolean;
}

/** Starts claude children: the real one (lib/integrations/claude/child.ts claudeAdapter) or a test's fake. */
export interface ClaudeAdapter {
  /** Throws when the process can't be created. Events start after it returns. */
  start(argv: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; maxLineBytes: number }, onEvent: (e: ClaudeEvent) => void): ClaudeChild;
}
