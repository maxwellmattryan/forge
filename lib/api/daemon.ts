// The session pool: /api/daemon, /api/daemon/mode, /api/daemon/permission, /api/daemons/log and the /api/events SSE frames.
import type { Effort } from './enums.ts';

/** daemon.jobBudget: the spend limits an unattended job with none of its own gets (lib/engine/metrics/budget.ts effectiveLimits). */
export type DaemonJobBudget = { tokens?: number | null; usd?: number | null; minutes?: number | null } | null;

/**
 * The billing variables (API keys, provider switches, ANTHROPIC_BASE_URL) set in `forge dash`'s environment, which
 * sessions inherit, and whether they are passed (only under daemon.auth: api-key): billingOf in lib/integrations/claude/argv.ts.
 */
export interface DaemonBilling {
  vars: string[];
  passed: boolean;
  /** A provider switch or ANTHROPIC_BASE_URL is among them: `forge doctor`'s `daemon billing` warns then, and so does the Daemon popover. */
  warn: boolean;
}

/** Session supervisor status: state() in lib/office/session/lifecycle.ts. */
export type DaemonStatus = 'off' | 'idle' | 'busy' | 'stopping';

/** One supervised session (the inbox or a job's): state() in lib/office/session/lifecycle.ts, or offState in lib/office/pool.ts. */
export interface DaemonSessionState {
  /** `_inbox`, `_office`, a job id, or `_jobs` for the job sessions' default. */
  scope: string;
  wanted: boolean;
  running: boolean;
  status: DaemonStatus;
  sessionId: string | null;
  pid: number | null;
  lastTurnAt: string | null;
  lastResultAt: string | null;
  turns: number;
  failures: number;
  held: 'budget' | 'repo-budget' | null;
  /** Has fresh work but no free slot under daemon.maxConcurrent. */
  waiting: boolean;
  lastError: string | null;
  /** Tool calls outside the allowlist the session is waiting on a human for, oldest first. */
  permissions: DaemonPermissionPrompt[];
  /** The permission mode claude last reported for the running child (at init or after a switch); null while none runs. */
  permissionMode: string | null;
  /** A running agent of the job this session drives keeps it from slot eviction and idle stop; null otherwise and while none runs. */
  kept: 'agents' | null;
  /** The --effort Forge passed the running child; null while none runs or when it passed none. */
  effort: Effort | null;
}

/**
 * The permission modes a human may put a daemon session in from the dashboard (lib/integrations/claude/argv.ts PERMISSION_MODES): `default` asks in the dashboard, `auto` lets Claude Code's classifier approve routine calls, `dontAsk` refuses.
 */
export type DaemonPermissionMode = 'default' | 'auto' | 'dontAsk';

/** How a human answers a permission prompt: allow this call, allow it and its suggested rules for the rest of the session, or deny it. */
export type PermissionDecision = 'allow' | 'session' | 'deny';

/**
 * A tool call a daemon session's permission check sent to the supervisor instead of refusing, read by
 * lib/integrations/claude/stream.ts and shown or denied by lib/office/session/control.ts. Untrusted text but id and at.
 */
export interface DaemonPermissionPrompt {
  /** The supervisor's id for the prompt, not claude's request id. */
  id: string;
  tool: string;
  /** The tool's input as JSON, capped. */
  input: string;
  /** The agent's own words for the call. */
  description: string | null;
  /** Set when a subagent made the call. */
  agentId: string | null;
  /** The path outside the session's working directories that triggered the prompt. */
  blockedPath: string | null;
  /** What "allow for this session" adds on top of this call: permission rules and directories. Both empty when it adds nothing. */
  sessionRules: string[];
  sessionDirs: string[];
  /** When the supervisor received it. */
  at: string;
}

/** The session pool as the dashboard sees it: state() in lib/office/pool.ts plus `clients` from createContext in lib/server/start.ts. */
export interface DaemonPoolState {
  enabled: boolean;
  wanted: boolean;
  maxConcurrent: number;
  /** Running job sessions (the inbox is not counted against maxConcurrent). */
  live: number;
  lastError: string | null;
  inbox: DaemonSessionState;
  /** The foreman's office session (scope `_office`), never counted against maxConcurrent. */
  office: DaemonSessionState;
  /** foreman.enabled, from the latest read of config.yml: the dashboard shows the office only then. */
  foreman: boolean;
  /** Job sessions worth showing: running, stopping, waiting, held, failed or stopped by a human. */
  jobs: Record<string, DaemonSessionState>;
  /** The permission mode daemon.command starts sessions in (`manual` reads as `default`). */
  permissionMode: string;
  /** Sessions a human put in another mode, by scope, and the default for job sessions without an entry (null: daemon.command's). Held in memory only, so they end with `forge dash`. */
  permissionModes: Record<string, DaemonPermissionMode>;
  jobPermissionMode: DaemonPermissionMode | null;
  /** Open /api/events streams across all sessions. */
  clients: number;
}

/** GET /api/daemons/log: readLogPage in lib/core/job/session-files.ts. Offsets are the SSE ids of the same lines. */
export interface DaemonLogPage {
  scope: string;
  lines: { offset: number; line: string }[];
  /** Where this page starts: pass it as `before` for the next older page. */
  start: number;
  end: number;
  /** Older lines exist in the current `<scope>.log`. */
  more: boolean;
}

/** One /api/events?session= frame: stateFrame and lineFrame in lib/server/sse.ts; `id` is the line's offset in the session log, `data` the raw log line. */
export type SseFrame = { event: 'state'; data: DaemonSessionState } | { event: 'line'; id: number; data: string };

/** The line a frame carries instead of an oversized one: lineFrame in lib/server/sse.ts. */
export interface ForgeTruncatedLine {
  type: 'forge-truncated';
  originalType: string | null;
  bytes: number;
}

/** POST /api/daemon body: the handler in lib/server/routes/office.ts. */
export interface PostDaemonBody {
  action: 'start' | 'stop';
  /** `_inbox` or a job id: start or stop that one session instead of the pool. */
  scope?: string;
}

/** POST /api/daemon reply on success: poolState from createContext in lib/server/start.ts. */
export type PostDaemonResponse = DaemonPoolState;

/** POST /api/daemon/mode body: the handler in lib/server/routes/office.ts. */
export interface PostDaemonModeBody {
  /** `_inbox` or a job id. */
  scope: string;
  mode: DaemonPermissionMode;
}

/** POST /api/daemon/mode reply on success: poolState from createContext in lib/server/start.ts. */
export type PostDaemonModeResponse = DaemonPoolState;
