// The session pools: /api/daemon, /api/daemon/mode, /api/daemon/permission, /api/daemons/log and the /api/events SSE frames,
// plus the machine dashboard's own GET and POST /api/projects, /api/projects/events and /api/projects/stats, the machine cap every pool reports,
// and the owner's chats with the Foreman (/api/p/<project>/chats…).
import type { Effort, GateClass, GateRunOutcome, JobState, Stage } from './enums.ts';

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
  /** `launchPermissionMode`: `forge dash --permission-mode`, the run's launch mode for every project; null without one. */
  machine: { maxConcurrent: number; source: 'settings' | 'auto'; live: number; launchPermissionMode: DaemonPermissionMode | null };
  /** Sorted by name. */
  projects: MachineProjectSummary[];
}

/** POST /api/projects body: postProject in lib/server/routes/machine.ts registers the repo at `path`, as `forge project add`. */
export interface PostProjectBody {
  /** An absolute path, or `~` / `~/…`; a worktree or subdirectory registers its main checkout. */
  path: string;
  /** Omitted or empty: the directory's default name. */
  name?: string;
}

/** POST /api/projects reply on success: `added` is false when the path was already registered (the index untouched). */
export interface PostProjectResponse {
  added: boolean;
  /** Its GET /api/projects entry after the re-read. */
  project: MachineProjectSummary;
}

/** POST /api/session body: the login link's fragment key, which postSession in lib/server/routes/machine.ts checks against the server's token. */
export interface PostSessionBody {
  k: string;
}

/** POST /api/session reply on a right key, beside the `forge-<port>` cookie it sets. */
export interface PostSessionResponse {
  ok: true;
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
  /**
   * The running child's latest turn context: its last main-loop API call's input + cache-read + cache-creation
   * tokens. null while no child runs or before its first reading.
   */
  contextTokens: number | null;
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

/** One gate run of forge dash's gate runner (lib/office/foreman/run.ts): running, or one of the 50 last kept. */
export interface GateRunState {
  /** The gate request's id. */
  request: string;
  gate: GateClass;
  /** The job the gate is on, or null for a milestone draft's (then `mandate` is set). */
  job: string | null;
  mandate: string | null;
  status: 'running' | 'done';
  /** Null while it runs. */
  outcome: GateRunOutcome | null;
  /** The verdict's reason, a hand-off's or refusal's text, or why it failed: model or policy text, at most 200 characters, rendered as text. */
  reason: string | null;
  startedAt: string;
  endedAt: string | null;
  /** Assistant turns: 1, or 2 after a malformed verdict was asked again; up to 4 with a senior pass, whose turns add to the first's. */
  attempts: number;
  /** Metered spend of the run's turns. */
  usd: number;
  tokens: number;
}

/** DaemonPoolState.gates: the gate runner's cap, its hold, and its runs, newest first. */
export interface GateRunsState {
  /** foreman.enabled and foreman.assistants.enabled: the runner takes gate requests. */
  enabled: boolean;
  /** foreman.assistants.parallel: runs at once. */
  parallel: number;
  /** Runs live now. */
  live: number;
  /** Why no new run starts now: the office's daily cap, a failure's backoff or a usage limit; null when none holds. */
  held: { reason: 'daily-cap' | 'retry' | 'limit'; until: string | null; message: string } | null;
  runs: GateRunState[];
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
  /** forge dash's gate runner: its cap, hold and runs (lib/office/foreman/run.ts). Gate runs count against neither maxConcurrent nor the machine cap. */
  gates: GateRunsState;
  /** Job sessions worth showing: running, stopping, waiting, held, failed or stopped by a human. */
  jobs: Record<string, DaemonSessionState>;
  /** The permission mode daemon.command starts sessions in (`manual` reads as `default`). */
  permissionMode: string;
  /** Sessions a human put in another mode, by scope, and the default for job sessions without an entry (null: daemon.command's). Held in memory only, so they end with `forge dash`. */
  permissionModes: Record<string, DaemonPermissionMode>;
  /** The job sessions' default: starts at the launch mode and moves only by the popover's choice (null: daemon.command's). */
  jobPermissionMode: DaemonPermissionMode | null;
  /** `forge dash --permission-mode`, the run's launch mode: the job, inbox and office sessions start in it; null without one. */
  launchPermissionMode: DaemonPermissionMode | null;
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

/** Whether a chat still takes messages. Archived is final: nothing unarchives a chat. */
export type ChatState = 'active' | 'archived';

/** A chat with the Foreman: `.forge/runtime/chats/<id>/chat.json` (lib/office/chat/store.ts), at CHAT_SCHEMA_VERSION. */
export interface Chat {
  schemaVersion: number;
  /** 12 lowercase hex characters; its session's scope is `_chat-<id>`. */
  id: string;
  /** One line, at most 120 characters; null until the owner names it. */
  title: string | null;
  state: ChatState;
  createdAt: string;
  /** Bumped by each message, rename and archive: GET /chats sorts by it, newest first. */
  updatedAt: string;
  /** The chat session's Claude session id, which its next spawn resumes; null before its first spawn. */
  sessionId: string | null;
}

/**
 * One line of a chat's log.jsonl, after CHAT_LOG_STEPS: a message the owner sent, the reason it could not reach
 * the session, or one line the chat's session logged (claude's stream-json or a `forge-daemon` event), already
 * redacted, as `daemons/_chat-<id>.log` has it; a line over 256 KiB is a ForgeTruncatedLine.
 */
export type ChatLogEntry = { v: number; at: string } & ({ kind: 'owner'; text: string } | { kind: 'undelivered'; reason: string } | { kind: 'session'; line: string });

/** GET /api/p/<project>/chats/<id>/log: the entries with index `n > after`, oldest first; `more` when later ones exist. */
export interface ChatLogPage {
  id: string;
  entries: (ChatLogEntry & { n: number })[];
  more: boolean;
}

/** GET /api/p/<project>/chats/<id>: the chat and its session's state (the off state from its record when the pool has none). */
export interface ChatDetail {
  chat: Chat;
  session: DaemonSessionState;
}

/** GET /api/p/<project>/chats: every chat, newest updatedAt first. */
export interface ChatList {
  chats: Chat[];
}
