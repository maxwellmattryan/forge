// /api/jobs and /api/jobs/:id/*: the job detail, transcript and files, the job POSTs, the Shelved list's
// POST /api/shelf, and the environment routes with GET /api/environments.
import type { BudgetKey, Effort, ShelfAction } from './enums.ts';
import type { AgentRun, BudgetLimits, BudgetUsed, Job, JobBudget, JobEvent, OwnerStatus, Progress } from './job.ts';
import type { ForgeRequest } from './state.ts';

/** One agent of the job's current round (or still running) in the job detail: jobDetail() in lib/server/routes/jobs.ts. */
export interface AgentRow {
  role: string;
  status: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** endedAt − startedAt; null while running or when either is unknown. */
  durationMs: number | null;
  /** The sum of `runs[].usage.totalTokens`; null when no run has usage: runsTokens in lib/engine/metrics/runs.ts. */
  tokens: number | null;
  /** Its transcript was found. */
  transcript: boolean;
  /** Every ended run of the role across rounds, oldest first: agentRuns in lib/engine/metrics/runs.ts. */
  runs: AgentRun[];
}

/** GET /api/jobs/:id/transcript: a page of an agent's or the interactive owner's transcript, read backwards. */
export interface TranscriptPage {
  job: string;
  source: 'agent' | 'owner';
  /** The agent's role; null for the owner. */
  role: string | null;
  lines: { offset: number; line: string }[];
  start: number;
  end: number;
  more: boolean;
}

/** GET /api/jobs/:id: jobDetail in lib/server/routes/jobs.ts. */
export interface JobDetail {
  job: Job & { progress: Progress; ownerStatus: OwnerStatus };
  events: JobEvent[];
  files: string[];
  screenshots: string[];
  /** This job's requests in every status, oldest first, at most the last 50. */
  requests: ForgeRequest[];
  /** request.md without its `# title` line, trimmed, the Thread's opening message: cut at 2,000 characters, with `requestTruncated` set (the whole file is GET /api/jobs/:id/file). */
  request: string | null;
  requestTruncated: boolean;
  /** The job's `created` event has a ref (from-ref), so `request` is the issue's text. A later `job link` doesn't count. */
  requestFromTracker: boolean;
  /** The current round's agent records plus any still running, newest start first. */
  agents: AgentRow[];
  /** The owner is an interactive (non-daemon) session whose transcript exists; null otherwise. */
  ownerTranscript: { session: string } | null;
}

/** GET /api/jobs/:id/file for a text file: the text/plain body (send in lib/server/http.ts); images come back as raw bytes and /raw as sandboxed HTML, neither through api(). */
export type JobFileText = string;

/** POST /api/jobs body: a new job from free text; `title` overrides the one derived from `text`. */
export interface PostJobBody {
  text: string;
  title?: string | null;
}

/** POST /api/jobs reply: the new job and the `resume` request queued for its session. */
export interface PostJobResponse {
  id: string;
  title: string;
  branch: string | null;
  request: ForgeRequest;
  daemon: boolean;
}

/** POST /api/jobs/:id/effort body: the handler in lib/server/routes/jobs.ts. null inherits runtime.effort. */
export interface PostJobEffortBody {
  effort: Effort | null;
}

/** POST /api/jobs/:id/effort reply, and `forge job effort`'s output: setJobEffort in lib/core/job/store.ts. */
export interface PostJobEffortResponse {
  id: string;
  effort: Effort | null;
  previous: Effort | null;
  changed: boolean;
}

/** POST /api/jobs/:id/repos body: the handler in lib/server/routes/jobs.ts. `repos` are the names the drawer listed, which must be the whole pending set. */
export interface PostJobReposBody {
  decision: 'approve' | 'reject';
  repos: string[];
  note?: string | null;
}

/** POST /api/jobs/:id/repos reply: decideRepoProposals in lib/engine/project/repo-proposals.ts, and whether the job was set running and resumed. */
export interface PostJobReposResponse {
  id: string;
  decision: 'approve' | 'reject';
  repos: string[];
  added: string[];
  pending: string[];
  resumed: boolean;
}

/** POST /api/jobs/:id/run body: `dev` is the only command the dashboard may start. */
export interface PostRunBody {
  command: 'dev';
}

/** POST /api/jobs/:id/run reply: startBackground in lib/engine/workspace/dev-server.ts, without the pid and log path. */
export interface PostRunResponse {
  reused: boolean;
  listening: boolean | null;
  port: number | null;
}

/** POST /api/jobs/:id/editor reply: the editor command that was started. */
export interface PostEditorResponse {
  ok: true;
  editor: string;
}

/** A job's dev server: `down` is a recorded pid that is dead (it crashed or was killed outside Forge). */
export type DevState = 'running' | 'starting' | 'down' | 'stopped';

/** GET /api/jobs/:id/environment's dev row: `pid` only while alive, `tail` (oldest first) only when `down`. */
export interface EnvironmentDev {
  state: DevState;
  pid: number | null;
  port: number | null;
  listening: boolean | null;
  startedAt: string | null;
  tail: string[];
}

/** A container's healthcheck status; null without a healthcheck or while not running. */
export type BackingHealth = 'healthy' | 'unhealthy' | 'starting' | null;

/** One `backing:` entry as the Environment card shows it (from `forge backing status <id>`). */
export interface EnvironmentService {
  name: string;
  isolation: string;
  managed: boolean;
  container: string | null;
  state: 'running' | 'stopped' | 'missing' | 'unknown' | 'external';
  health: BackingHealth;
  ports: Record<string, number>;
}

/** GET /api/jobs/:id/environment reply. `backingError` is the redacted reason the backing status failed. */
export interface JobEnvironmentResponse {
  job: string;
  active: boolean;
  worktree: boolean;
  dev: EnvironmentDev | null;
  backing: EnvironmentService[];
  backingError: string | null;
  /** Docker's state, asked only when a managed service reads `unknown`; null otherwise. */
  docker: 'ok' | 'missing' | 'stopped' | null;
  at: string;
}

export type EnvironmentTarget = 'dev' | 'backing';
export type EnvironmentAction = 'start' | 'stop' | 'restart';

/** POST /api/jobs/:id/environment body. */
export interface PostEnvironmentBody {
  target: EnvironmentTarget;
  action: EnvironmentAction;
}

/** POST /api/jobs/:id/environment reply, with the environment read after the action. */
export interface PostEnvironmentResponse {
  target: EnvironmentTarget;
  action: EnvironmentAction;
  ok: boolean;
  detail: string | null;
  environment: JobEnvironmentResponse;
}

/** CPU % and memory of a process group or a container; null where they can't be measured. */
export interface EnvironmentUsage {
  cpu: number | null;
  memBytes: number | null;
}

/** One row of GET /api/environments: a job (or, with `job: null`, the shared services) with what runs for it. */
export interface EnvironmentRow {
  job: string | null;
  title: string;
  state: string | null;
  focused: boolean;
  dev: ({ pid: number; port: number | null } & EnvironmentUsage) | null;
  containers: ({ name: string; backing: string } & EnvironmentUsage)[];
}

/** GET /api/environments reply: every running environment in this checkout. */
export interface EnvironmentsResponse {
  docker: 'ok' | 'missing' | 'stopped' | 'error';
  rows: EnvironmentRow[];
  at: string;
}

/** POST /api/jobs/:id/delete body: the job id typed back. */
export interface PostDeleteJobBody {
  confirm: string;
}

/** `forge job delete` output and the POST /api/jobs/:id/delete reply: what went with the job. `branch` is null when Forge did not name it. */
export interface DeleteJobResult {
  deleted: string;
  title: string;
  worktree: string | null;
  branch: string | null;
  repos?: string[];
  /** Open requests for the job, now rejected. */
  requests: number;
}

/** POST /api/jobs/:id/merge body: a person's merge-now, with the job id typed back. */
export interface PostJobMergeBody {
  now: true;
  confirm: string;
}

/** POST /api/jobs/:id/budget body: `set` entries are `key=value` in `forge job budget --set` syntax; set is applied before ack. */
export interface PostJobBudgetBody {
  ack?: boolean;
  set?: string[];
}

/** POST /api/jobs/:id/budget reply, and `forge job budget`'s output: budgetCmd in lib/engine/metrics/budget.ts. */
export interface PostJobBudgetResponse {
  id: string;
  limits: BudgetLimits;
  used: BudgetUsed;
  exceeded: BudgetKey[];
  ack: JobBudget['ack'];
  acked: BudgetKey[];
  stillExceeded: BudgetKey[];
}

/**
 * POST /api/shelf body: the Shelved list's batch action on the rows a person selected, each pinned to
 * the `shelved.at` the list showed (1 to 50 entries); `note` (at most 2000 characters) is required for rework.
 */
export interface PostShelfBody {
  action: ShelfAction;
  jobs: { id: string; shelvedAt: string }[];
  note?: string | null;
}

/** What POST /api/shelf did to one job: shelfAction in lib/engine/pipeline/moves/shelve.ts; `reason` only when skipped. */
export interface ShelfResult {
  id: string;
  outcome: 'approved' | 'reworked' | 'unshelved' | 'closed' | 'skipped';
  reason?: string;
}

/** POST /api/shelf reply: one result per entry, in the body's order. */
export interface PostShelfResponse {
  results: ShelfResult[];
}

/** POST /api/jobs/:id/merge reply: mergePr's result in lib/engine/pr/merge.ts, whatever its action. */
export interface PostJobMergeResponse {
  merged: boolean;
  action: 'already-merged' | 'deferred' | 'refused' | 'failed' | 'auto' | 'merged';
  error?: string;
}
