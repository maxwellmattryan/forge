// The job shapes the store, the archive and the findings summary share, type-only: re-exported by lib/core/types.ts.
import type { SEVERITIES } from './schema.ts';
import type { AgentUsage, ContextComposition, EventActor, Job, JobEvent } from '#api/types.ts';

/** What recordAgent knows about an agent end when it records the run: recordRun in lib/core/job/schema.ts. */
export interface AgentRunEnd {
  wasRunning: boolean;
  at: string | null;
  round: number;
  status: string;
  model: string | null;
  usage?: AgentUsage;
  composition?: ContextComposition | null;
}

/** What recordAgent in lib/core/job/store.ts records for one agent start or end. */
export interface AgentRecordChange {
  role: string;
  phase: 'start' | 'end';
  model?: string;
  agentId?: string;
  status?: string;
  summary?: string;
  usage?: AgentUsage;
  importedThrough?: string | null;
  /** end: the imported transcript's context composition, recorded on the run only (recordRun in ./schema.ts), never in the event. */
  composition?: ContextComposition | null;
  /** start: the job-dir-relative output (resolveAgentOutput). */
  output?: string | null;
  /** start: this run is the one retry. */
  retry?: boolean;
  /** end: the output check's result, when an output is known. */
  outputMissing?: boolean;
  /** end: `metered` when the job's own daemon session's meter holds this run's cost, `unmeasured` when its transcript wasn't found. */
  flags?: { metered?: true; unmeasured?: true };
}

/**
 * A person's go-ahead for a human-only operation, from a channel a session's children can't reach:
 * a confirmed terminal (lib/cli/commands/human.ts) or a dashboard route. isHumanGrant in
 * lib/core/job/schema.ts checks one at runtime.
 */
export interface HumanGrant {
  channel: 'terminal' | 'dashboard';
  actor: EventActor;
}

/** A review finding's severity: SEVERITIES in lib/core/job/schema.ts. */
export type Severity = (typeof SEVERITIES)[number];

/** A job as loadJob and normalizeJob return it: normalizeJob marks one written by a newer Forge. */
export type LoadedJob = Job & { _unsupported?: true };

/** What setJob in lib/core/job/store.ts applies; stage, state and waitingOn are checked against their lists before the write. */
export interface JobChange {
  stage?: string;
  state?: string;
  waitingOn?: string | null;
  reason?: string | null;
  fields?: Record<string, any>;
  /** Locked fields that only their owning module writes (lib/core/job/fields.ts); never from the CLI. */
  owned?: Record<string, unknown>;
  note?: string;
}

export interface FindingCounts {
  raised: number;
  fixed: number;
  disputed: number;
}

/** CLI output of `forge job findings`, without the id. */
export interface JobFindings {
  rounds: (FindingCounts & { round: number })[];
  /**
   * `severity`: the lens's raised findings by severity, present once it raised one. Archive records
   * written before it carry none, and stats leaves those out of its severity counts.
   */
  byLens: Record<string, FindingCounts & { recurring: number; severity?: Record<Severity, number> }>;
  totals: FindingCounts & { recurring: number };
  recurring: { lens: string; path: string; rounds: number[] }[];
  disputed: { round: number; lens: string; severity: Severity; path: string | null }[];
}

/** What archived a job: `forge job archive`, `forge job prune`, or the retention policy (lib/engine/ops/retention.ts). */
export type RetentionTrigger = 'cli' | 'prune' | 'policy';

/** The facts an archive record keeps beside the raw job and events, so readers need no job dir. */
export interface ArchiveSummary {
  title: string;
  kind: string;
  state: string;
  createdAt: string | null;
  finishedAt: string | null;
  rounds: number;
  pr: { number: number | null; state: string | null; url: string | null } | null;
  verdicts: Job['verdicts'];
  usage: { totalTokens: number; estCostUsd: number };
  /** jobFindings, read before the job dir (its review files and build.md) was deleted. */
  findings: JobFindings;
  bytesFreed: number;
}

/** `.forge/archive/<id>.json` as written. */
export interface ArchiveRecord {
  archiveVersion: number;
  id: string;
  archivedAt: string;
  trigger: RetentionTrigger;
  job: Job;
  events: JobEvent[];
  summary: ArchiveSummary;
}

/** An archive record as readers see it: the job normalised, events in the current shape. */
export interface ArchivedJob {
  id: string;
  archivedAt: string;
  trigger: RetentionTrigger;
  job: LoadedJob;
  events: JobEvent[];
  summary: ArchiveSummary;
}
