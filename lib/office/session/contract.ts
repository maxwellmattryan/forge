// The session's contract with its pool: the events it reports, the context and options it is built
// with (sessionOptions fills in the real defaults), the child it supervises and the Session it returns.
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { loadConfig as defaultLoadConfig } from '#core/config/load.ts';
import { openAppend } from '#core/job/session-files.ts';
import type { SessionFacts } from '../reconcile.ts';
import { scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { queueNotify } from '../notify.ts';
import type { QueueNotify } from '../notify.ts';
import type { Config, RepoBudgetStatus, DaemonPermissionMode, DaemonSessionState, DaemonStatus, Effort, EffortSource, EventActor, ForgeRequest, PermissionDecision } from '#core/types.ts';

/** What a session reports to its pool: a log line as it is written, or its new state after a change. */
export type SessionEvent = { kind: 'line'; scope: string; offset: number; line: string } | { kind: 'state'; scope: string; state: DaemonSessionState };

/** Where a session log goes: an fs.WriteStream, or a test's stand-in. */
export interface LogSink {
  write(line: string): boolean;
  on?(event: 'error', fn: (e: Error) => void): unknown;
  once?(event: 'drain', fn: () => void): unknown;
  end?(cb?: () => void): unknown;
}

/** Injection points for tests; every one defaults to the real thing. */
export interface DaemonOptions {
  spawn?: typeof nodeSpawn;
  killTree?: (child: DaemonChild, signal: NodeJS.Signals) => void;
  pollMs?: number;
  graceMs?: number;
  maxLineBytes?: number;
  rotateBytes?: number;
  env?: NodeJS.ProcessEnv;
  openLog?: (file: string) => LogSink;
  loadConfig?: (root: string, opts?: { text?: string | null }) => { config: Config };
  /** Backoff after a failed turn: first wait, and the cap it doubles up to. */
  retryMinMs?: number;
  retryMaxMs?: number;
  /** How long claude has to confirm a mode switch before the supervisor stops treating it as pending. */
  modeConfirmMs?: number;
  /** A turn's limit in ms, over daemon.turnTimeoutMinutes (tests). */
  turnTimeoutMs?: number;
  /** How often a wanted pool reconciles (lib/office/reconcile.ts); 0 never does on a timer. */
  reconcileMs?: number;
  /** The host platform; the pool refuses to start on native Windows (lib/core/os/platform.ts). */
  platform?: NodeJS.Platform;
  /** Where a daemon stop is announced (lib/office/notify.ts queueNotify). */
  notify?: QueueNotify;
  /** The known values a scope's log lines are redacted with (lib/engine/guard/known-secrets.ts scopeKnownValues). */
  redactor?: Redactor;
  /** How often the pool runs `forge sync` while it is wanted; 0 never does. */
  syncMs?: number;
  /** Runs one `forge sync`; resolves with null on success or the failure's message. */
  runSync?: (root: string) => Promise<string | null>;
}

/** The known values to redact from one scope's session log. */
export type Redactor = (root: string, scope: string, config: Config) => readonly string[];

/** DaemonOptions with every default filled in. */
export interface SessionOptions {
  spawn: typeof nodeSpawn;
  killTree: (child: DaemonChild, signal: NodeJS.Signals) => void;
  graceMs: number;
  maxLineBytes: number;
  rotateBytes: number;
  retryMinMs: number;
  retryMaxMs: number;
  modeConfirmMs: number;
  /** null: daemon.turnTimeoutMinutes decides. */
  turnTimeoutMs: number | null;
  env: NodeJS.ProcessEnv;
  openLog: (file: string) => LogSink;
  readConfig: (root: string, opts?: { text?: string | null }) => { config: Config };
  notify: QueueNotify;
  redactor: Redactor;
}

export function sessionOptions(opts: DaemonOptions = {}): SessionOptions {
  return {
    spawn: opts.spawn ?? nodeSpawn,
    killTree: opts.killTree ?? defaultKillTree,
    graceMs: opts.graceMs ?? 5000,
    maxLineBytes: opts.maxLineBytes ?? 8 * 1024 * 1024,
    rotateBytes: opts.rotateBytes ?? 20 * 1024 * 1024,
    retryMinMs: opts.retryMinMs ?? 60_000,
    retryMaxMs: opts.retryMaxMs ?? 60 * 60_000,
    modeConfirmMs: opts.modeConfirmMs ?? 15_000,
    turnTimeoutMs: opts.turnTimeoutMs ?? null,
    env: opts.env ?? process.env,
    // fd-based, so a symlink planted as <scope>.log is refused rather than followed.
    openLog: opts.openLog ?? ((file: string) => fs.createWriteStream(file, { fd: openAppend(file) })),
    readConfig: opts.loadConfig ?? defaultLoadConfig,
    notify: opts.notify ?? queueNotify,
    redactor: opts.redactor ?? scopeKnownValues,
  };
}

/** What a session needs from its pool, which owns the trust snapshot and every repo-wide decision. */
export interface SessionContext {
  /** The trustDigest a human's pool start took. */
  trusted(): string | null;
  poolWanted(): boolean;
  config(): Config;
  /** .forge/config.yml, .forge/trackers/ or .forge/verifiers/ changed: the pool stops every session. */
  untrusted(): void;
  /** A repo-wide refusal (config, daemon.enabled, tracker symlinks): the pool stops every session. */
  fatal(message: string): void;
  emit(e: SessionEvent): void;
  /** A turn's result arrived. */
  onResult(scope: string): void;
  /** The child exited, after its agents, lease and claimed requests were let go: reconcile its job. */
  onExit(scope: string): void;
  /** Something freed a slot or may have left work unserved: tick. */
  poke(): void;
  /** The mode a human chose for this scope, or the job sessions' default; null keeps daemon.command's. */
  permissionMode(scope: string): DaemonPermissionMode | null;
  /** claude refused a switch to `mode`; `live` is the mode it still reports. */
  permissionModeRefused(scope: string, mode: DaemonPermissionMode, live: string | null): void;
  /** The --effort a spawn of `scope` gets under config `c` (resolveEffort); null level passes none. */
  effort(scope: string, c: Config): { level: Effort | null; source: EffortSource };
}

/** What the supervisor records about each child it spawned. */
export interface ChildMeta {
  resume: boolean;
  stdout: boolean;
  /** a system/init was seen (claude emits one as each turn starts) */
  init: boolean;
  result: boolean;
  asked: boolean;
  /** ids its results covered */
  committed: string[];
  /** Background tasks claude listed in its latest background_tasks_changed; null until it sends one. */
  background: number | null;
  /** Why the supervisor stopped it, for the lease-expired event; null for an exit nobody asked for. */
  reason: string | null;
}

/** A spawned session, with the supervisor's bookkeeping attached. */
export type DaemonChild = ChildProcess & { _forge: ChildMeta };

/** One scope's supervisor. The pool decides when it spawns and gets a turn; the session does the rest. */
export interface Session {
  readonly scope: string;
  readonly wanted: boolean;
  readonly running: boolean;
  readonly status: DaemonStatus;
  readonly waiting: boolean;
  readonly held: 'budget' | 'repo-budget' | null;
  readonly lastError: string | null;
  readonly lastResultAt: string | null;
  /** Cached: a running agent of the job it drives keeps it (refreshKept). */
  readonly kept: 'agents' | null;
  /** Recomputes kept from job.json; emits a state frame when it changed. */
  refreshKept(): void;
  /** Why it may not be evicted for a slot now: running agents of the job it drives. */
  keptBy(at?: number): 'agents' | null;
  state(): DaemonSessionState;
  /** What the reconciler needs to judge its job (lib/office/reconcile.ts judge). */
  facts(): SessionFacts;
  /**
   * Applies this tick's pending requests for the scope: prunes, holds, and says whether any is fresh.
   * `repo` is the repo budget status, passed for job sessions only.
   */
  route(c: Config, pending: ForgeRequest[], repo?: RepoBudgetStatus | null): { eligible: string[]; fresh: boolean };
  /** Returns whether a child is now running. */
  spawn(c: Config, reason?: string): boolean;
  writeTurn(ids: string[]): void;
  /** Answers a pending permission prompt with who answered; returns its tool, or null when there is none by that id (answered, or its child exited). */
  answerPermission(id: string, decision: PermissionDecision, actor?: EventActor): string | null;
  /** Asks the running child to switch permission mode; false when no child runs (the next spawn takes ctx.permissionMode). */
  setPermissionMode(mode: DaemonPermissionMode): boolean;
  kill(event: string, endStdin: boolean, reason?: string): Promise<void>;
  logEvent(event: string, extra?: Record<string, unknown>): void;
  setWaiting(waiting: boolean): void;
  setWanted(wanted: boolean): void;
  /** A human (re)started it: wanted again, with a clean failure count and error. */
  reset(): void;
  recent(afterOffset?: number): { offset: number; line: string }[];
  close(): Promise<void>;
  killSync(): void;
}

function defaultKillTree(child: DaemonChild, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return void child.kill(signal);
  // The child leads its own group (detached), so the group signal reaches whatever it started.
  // A child without a pid never spawned, and its error handler drops it before anything kills it.
  try {
    process.kill(-child.pid!, signal);
  } catch {
    try {
      process.kill(child.pid!, signal);
    } catch {}
  }
}
