// GET /api/state, plus /api/requests, /api/focus and /api/budget/ack, whose replies are slices of it; and the shared JSON error body.
import type { Effort, RepoBudgetKey, RepoBudgetMode, RequestType } from './enums.ts';
import type { BudgetLimits, EventActor, ForemanHandoff, GateOwner, GateReason, Job, JobEvent, OwnerStatus, Progress } from './job.ts';
import type { DaemonBilling, DaemonJobBudget, DaemonPoolState } from './daemon.ts';
import type { DraftGate } from './repo.ts';

/** Repo spend against the caps: repoBudgetStatus in lib/engine/metrics/repo-budget.ts (`forge budget`, /api/state.budget). */
export interface RepoBudgetStatus {
  /** Current UTC period ids: YYYY-MM-DD and YYYY-MM. */
  day: string;
  month: string;
  onExceeded: RepoBudgetMode;
  /** USD to 4 decimal places. */
  spent: { dayUsd: number; monthUsd: number; monthTokens: number };
  configured: Record<RepoBudgetKey, number | null>;
  acks: { day: number; month: number };
  /** Effective caps: configured x (1 + acks for the period). */
  caps: Record<RepoBudgetKey, number | null>;
  /** max(0, cap - spent); null when uncapped. */
  remaining: Record<RepoBudgetKey, number | null>;
  /** monthUsd / dayOfMonth x daysInMonth, 2dp. */
  projectedMonthUsd: number;
  exceeded: RepoBudgetKey[];
  held: boolean;
  /** `repo budget: …` when any key is exceeded, also under warn. */
  reason: string | null;
  /** Live jobs waiting on budget with a `repo budget:` reason. */
  heldJobs: string[];
}

/** A queued request: enqueue, claimRequest and ackRequest in lib/core/job/requests.ts. */
export interface ForgeRequest {
  id: string;
  type: RequestType;
  job: string | null;
  text: string | null;
  args: Record<string, unknown>;
  from: string;
  status: 'pending' | 'in-progress' | 'done' | 'rejected';
  createdAt: string;
  session?: string;
  updatedAt?: string;
  result?: string | null;
  /** How often requeueOrphans returned it to pending after its session ended; a second time rejects it. */
  requeues?: number;
}

/** config.pipeline as served: defaults().pipeline in lib/core/config/load.ts. */
export interface PipelineConfig {
  plan: 'auto' | 'always' | 'never';
  split: 'ask' | 'auto' | 'never';
  specApproval: 'always' | 'large' | 'never';
  design: 'none' | 'reference' | 'mockup';
  maxRounds: number;
  /** The total-round ceiling (B7); null means twice the job's maxRounds. */
  maxTotalRounds: number | null;
  /** A rework round's builder and each re-run lens resume their role's last session when it is safe and cheap. */
  resumeRework: boolean;
  budget: BudgetLimits;
}

/** What a transcript's agent did last: lastActivity in lib/integrations/claude/transcripts.ts. Plain text, at most 160 characters. */
export interface TranscriptActivity {
  kind: 'tool' | 'text';
  text: string;
  at: string | null;
}

/** One running agent of a job in /api/state: state() in lib/server/routes/misc.ts. `last` is null when no transcript is found. */
export interface AgentActivity {
  role: string;
  model: string | null;
  startedAt: string | null;
  last: TranscriptActivity | null;
}

/** A job row in /api/state: state() in lib/server/routes/misc.ts. */
/** The last event that carries an actor: who last acted on a job (lastHuman in lib/server/routes/misc.ts). */
export interface LastHuman {
  ts: string;
  type: string;
  action: string | null;
  actor: EventActor;
}

/**
 * `gateReasons`: while the job waits on `escalation` with a reason that lists rules, each rule with its
 * detail (parkReasons in lib/engine/pipeline/moves/escalation.ts); null otherwise.
 */
export type StateJob = Job & { progress: Progress; lastEvent: JobEvent | null; eventCount: number; ownerStatus: OwnerStatus; activity: AgentActivity[]; gateOwner: GateOwner; lastHuman: LastHuman | null; endpoints: Endpoint[]; foremanHandoff: ForemanHandoff | null; gateReasons: GateReason[] | null };

/** GET /api/state: state() in lib/server/routes/misc.ts. */
export interface ApiState {
  apiVersion: number;
  forgeVersion: string;
  repo: { name: string };
  initialized: boolean;
  config: {
    base: string;
    tracker: string;
    panel: string[];
    pipeline: PipelineConfig;
    models: Record<string, string>;
    /** `billing`: the billing variables set in `forge dash`'s environment, null when none is. */
    daemon: { enabled: boolean; jobBudget: DaemonJobBudget; billing: DaemonBilling | null };
    /** runtime.effort when it is valid, else null. */
    effort: Effort | null;
  };
  daemons: DaemonPoolState;
  jobs: StateJob[];
  /** Each active goal mandate whose milestone draft waits at the milestone-approval gate (pending) or stopped filing, by creation time. */
  drafts: DraftGate[];
  requests: ForgeRequest[];
  /** The focused job (forge focus), or null when none is focused or it is gone or finished. */
  focus: FocusFact | null;
  /** Repo spend against the day and month caps. */
  budget: RepoBudgetStatus;
  now: string;
}

/** POST /api/budget/ack: the repo budget status after the acknowledgement. */
export type PostBudgetAckResponse = RepoBudgetStatus;

/** GET /api/requests: listRequests in lib/core/job/requests.ts. */
export type RequestsResponse = ForgeRequest[];

/** POST /api/requests body: read by the handler in lib/server/routes/jobs.ts and passed to enqueue. */
export interface PostRequestBody {
  type: RequestType;
  job?: string | null;
  text?: string | null;
  args?: Record<string, unknown>;
}

/** POST /api/requests reply: the handler in lib/server/routes/jobs.ts. */
export type PostRequestResponse = ForgeRequest & { daemon: boolean };

/** A focused job, as `forge focus` and /api/state report it: resolveFocus in lib/core/job/focus.ts. */
export interface FocusFact {
  id: string;
  title: string;
  since: string;
}

/**
 * One row of a job's Environment card: endpointsFor in lib/server/routes/misc.ts. A `component` row has a
 * `http://localhost:<port>/` url; a `backing` row has none. `live` is a boolean only on the component
 * row the dev command serves (the one whose port is `job.port`), null everywhere else.
 */
export interface Endpoint {
  kind: 'component' | 'backing';
  name: string;
  url: string | null;
  port: number;
  live: boolean | null;
}

/** POST /api/focus body: a job id to focus, or null to clear. */
export interface PostFocusBody {
  job: string | null;
}

/** One checkout step applied or undone on a focus change: lib/engine/workspace/checkout.ts. `log` is relative to the job dir. */
export interface CheckoutStepResult {
  step: number;
  kind: 'link' | 'run';
  ok: boolean;
  to?: string;
  command?: string;
  log?: string;
  error?: string;
}

/** `forge focus <id>|--clear` and POST /api/focus reply: focusJob in lib/engine/workspace/focus-actions.ts. */
export interface FocusResponse {
  focus: FocusFact | null;
  previous: string | null;
  /** Present only when a checkout step was undone or applied; `job` is the job whose steps were undone. */
  checkout?: { undone: CheckoutStepResult[]; applied: CheckoutStepResult[]; job?: string };
}

/**
 * JSON error body: jsonStatus (lib/server/http.ts) for /api/daemon's and /api/config's 4xx and the catch-all 500 in lib/server/start.ts's dispatch.
 * The POST guard failures (403/415/421) are text/plain, not this.
 */
export interface ApiError {
  error: string;
}
