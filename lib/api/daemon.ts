// The session pools: /api/daemon, /api/daemon/mode, /api/daemon/permission, /api/daemons/log and the /api/events SSE frames,
// plus the machine dashboard's own GET /api/projects, /api/projects/events and /api/projects/stats, and the machine cap every pool reports.
import type { Effort, JobState, Stage } from './enums.ts';

/** The machine cap as a pool reports it: DaemonPoolState.machine. */
export interface MachineSlotsState {
  /** The machine cap: the machine index's settings.maxConcurrent, else the highest loaded project's daemon.maxConcurrent. */
  maxConcurrent: number;
  /** Running job sessions across every project. */
  live: number;
}

/** One registered project in GET /api/projects. `jobs` and `daemon` are null while it is not loaded. */
export interface MachineProjectSummary {
  name: string;
  /** The root repo's realpath. */
  path: string;
  status: 'ok' | 'missing' | 'not-initialized';
  /** The server serves it under /api/p/<name>/. */
  loaded: boolean;
  /** `active`: not done, cancelled or failed; `waiting`: waiting on anything but `external`. */
  jobs: { active: number; waiting: number } | null;
  /** The newest non-eval job by updatedAt (its own title, unaltered: job text, rendered escaped), null with none or while not loaded. */
  latest: { id: string; title: string; at: string; stage: Stage; state: JobState } | null;
  /** `office`: the `_office` session's status. */
  daemon: { enabled: boolean; wanted: boolean; foreman: boolean; office: DaemonStatus; live: number; maxConcurrent: number } | null;
}

/** One loaded project in GET /api/projects/stats; arrays are parallel to ProjectsStatsResponse.days. */
export interface ProjectStatsSeries {
  name: string;
  /** Non-eval jobs that reached `done`, per UTC day of finishedAt (else updatedAt). */
  shipped: number[];
  /** The spend ledger's estimated USD per UTC day, reported and metered. */
  costUsd: number[];
  dayUsd: number;
  monthUsd: number;
  /** Why the project's stats could not be read (its arrays are zeros then), else null. */
  error: string | null;
}

/** GET /api/projects/stats?days=7|30|90: getProjectsStats in lib/server/routes/machine.ts. */
export interface ProjectsStatsResponse {
  generatedAt: string;
  /** The window's UTC dates (`YYYY-MM-DD`), oldest first, ending today. */
  days: string[];
  /** Every loaded project, sorted by name. */
  projects: ProjectStatsSeries[];
}

/** GET /api/projects, and the body of every /api/projects/events frame. */
export interface ProjectsResponse {
  /** Why the machine index could not be read at the last refresh (the loaded projects stay), else null. */
  error: string | null;
  machine: { maxConcurrent: number; source: 'settings' | 'auto'; live: number };
  /** Sorted by name. */
  projects: MachineProjectSummary[];
}

/** One /api/projects/events frame: sent on connect and whenever the summary changes. */
export type ProjectsFrame = { event: 'projects'; data: ProjectsResponse };

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
  /** The pool is off only because no human has approved the files Forge trusts as they are now (the machine dashboard boots a project's pool only while its approval matches); Start approves them. */
  needsApproval: boolean;
  inbox: DaemonSessionState;
  /** The Foreman's office session (scope `_office`), never counted against maxConcurrent. */
  office: DaemonSessionState;
  /** foreman.enabled, from the latest read of config.yml: the dashboard shows the office only then. */
  foreman: boolean;
  /** Assistant foreman sessions by scope (`_assistant-<n>`), never counted against maxConcurrent or the machine cap; `{}` while the foreman or its assistants are off. */
  assistants: Record<string, DaemonSessionState>;
  /** Job sessions worth showing: running, stopping, waiting, held, failed or stopped by a human. */
  jobs: Record<string, DaemonSessionState>;
  /** The permission mode daemon.command starts sessions in (`manual` reads as `default`). */
  permissionMode: string;
  /** Sessions a human put in another mode, by scope, and the default for job sessions without an entry (null: daemon.command's). Held in memory only, so they end with `forge dash`. */
  permissionModes: Record<string, DaemonPermissionMode>;
  jobPermissionMode: DaemonPermissionMode | null;
  /** The machine cap across every project the machine dashboard serves; null for a pool outside one. */
  machine: MachineSlotsState | null;
  /** Open event streams on the machine dashboard. */
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
