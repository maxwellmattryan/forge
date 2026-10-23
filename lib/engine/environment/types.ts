// The environment and backing-service records and results, type-only.
import type { BackingIsolation } from '#core/config/types.ts';

/** `.forge/jobs/<job>/backing.json` and `.forge/runtime/backing.json`: host port per container port, per entry name. */
export interface BackingRecord {
  v: 1;
  ports: Record<string, Record<string, number>>;
}

/** `.forge/jobs/<job>/backing-db.json` (mode 0600): per entry name, the template the job database came from and the job role's password. */
export interface BackingDbRecord {
  v: 1;
  databases: Record<string, { template: string; password: string }>;
}

/** One command that built a template database; `tail` has every generated password redacted. */
export interface BackingBuildStep {
  cmd: string;
  ok: boolean;
  tail: string;
}

/** One service in `forge worktree create` and `forge backing up`. */
export interface BackingUpEntry {
  name: string;
  isolation: BackingIsolation;
  /** What Forge did, or on a failure what it attempted: `none` when it failed before running or starting a container. */
  action: 'created' | 'started' | 'running' | 'external' | 'none';
  ok: boolean;
  error?: string;
  /** Entries with `database`: the job database, its template and what Forge did with each. Never a password or a url. */
  database?: { name: string; template: string | null; action: 'created' | 'kept' | 'none'; template_action: 'built' | 'reused' | 'none' };
  /** Only when Forge built the template: its migrate and seed runs. */
  build?: BackingBuildStep[];
}

/** `forge backing down <job>` and the `backing` key of `forge worktree remove`. */
export interface BackingDownResult {
  removed: string[];
  volumes: string[];
  /** The job databases dropped; only when the config has an entry with `database` or a record was left. */
  databases?: string[];
  ok: boolean;
  error?: string;
}

/** What Forge last did to a job's environment: lib/engine/environment/record.ts. */
export type EnvironmentState = 'running' | 'stopped';

export interface EnvironmentEntry {
  state: EnvironmentState;
  usedAt: string;
}

/** `.forge/runtime/environments.json`, written only by the CLI under `.forge/locks/environments`. */
export interface EnvironmentRecord {
  v: 1;
  jobs: Record<string, EnvironmentEntry>;
}

/** Which path started, stopped or tore down an environment; the trigger of its event. */
export type EnvironmentUpTrigger = 'verify' | 'run' | 'focus' | 'worktree' | 'step' | 'cli';
export type EnvironmentStopTrigger = 'park' | 'evict' | 'cli' | 'done' | 'cancelled';
export type EnvironmentDownTrigger = 'done' | 'cancelled' | 'archive' | 'cli';

/** Ensure up: lib/engine/environment/lifecycle.ts ensureEnvironment. `backing` lists each service as `forge backing up` does. */
export interface EnvironmentUpResult {
  ok: boolean;
  backing: BackingUpEntry[];
  evicted: string[];
  error?: string;
}

/** Stop: the background commands signalled and the per-job containers stopped. */
export interface EnvironmentStopResult {
  ok: boolean;
  processes: string[];
  stopped: string[];
  error?: string;
}

/** A job finished from the inbox or office session: only a stop, and archive or `forge environment down` tears it down. */
export interface EnvironmentFinishStopResult extends EnvironmentStopResult {
  teardown: 'deferred';
}

/** Teardown: the background commands stopped, then what `forge backing down` removed. */
export interface EnvironmentDownResult {
  ok: boolean;
  processes: string[];
  removed: string[];
  volumes: string[];
  databases?: string[];
  error?: string;
}
