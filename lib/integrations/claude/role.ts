// One pipeline role as its own headless claude child: the launch, the brief as its only user message, the
// answers to its permission prompts, its end once the result is in (stdin closed, then SIGTERM, then SIGKILL
// to its process group), and the class of a failure. It knows nothing of jobs, so `forge job agent run`
// (lib/cli/commands/job/agent-run.ts) and later one-shot runs can share it, and it reads only ClaudeEvents.
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import { briefLine } from './stream.ts';
import type { ClaudeAdapter, ClaudeChild, ClaudeEvent, SessionCost } from './types.ts';
import type { PermissionDecision } from '#core/types.ts';

/** Why a role run failed. `untrusted` is the caller's own post-run check; runRoleChild never returns it. */
export const ROLE_FAILURE_CLASSES = ['limit', 'auth', 'budget', 'error', 'timeout', 'untrusted', 'interrupted', 'exit', 'spawn'] as const;
export type RoleFailureClass = (typeof ROLE_FAILURE_CLASSES)[number];

/** A failed run: its class, claude's capped reason (or the runner's), and when a quota window resets (ms), else null. */
export interface RoleFailure {
  class: RoleFailureClass;
  reason: string;
  resetsAt: number | null;
}

/** What one role child did. */
export interface RoleOutcome {
  ok: boolean;
  /** claude's process was created. */
  started: boolean;
  /** claude's init arrived: a resume that fails before it never found its conversation. */
  init: boolean;
  /** The session id claude's init reported, unchecked: the caller validates it before use. */
  sessionId: string | null;
  /** An ok result's first non-empty line (at most 280 characters). */
  summary: string | null;
  /** An ok result's text (its last 4000 characters), null otherwise: a context session's reply must be exactly READY. */
  text: string | null;
  /** The stream's first main-loop request's tokens (the `first-request` event), null when none carried a usage. */
  firstRequest: { input: number; cacheRead: number; cacheWrite: number } | null;
  /** The distinct tools its main loop called, in first-use order (at most MAX_TOOLS_KEPT): a context session's child may only Read. */
  tools: string[];
  /**
   * How many stdout lines Forge could not read or act on: over the line cap, not JSON, or a protocol error. One could have
   * held a tool call, so a context session's child must have none.
   */
  dropped: number;
  /** The result line's cumulative cost, null without a result or a cost on it. */
  cost: SessionCost | null;
  /** The input, cache-read and cache-write tokens of the turn's last main-loop request (the result's `context`), null without one. */
  context: number | null;
  failure: RoleFailure | null;
  /** How many permission prompts were answered deny. */
  denied: number;
  /** How the process closed; null when it never started or never closed after SIGKILL. */
  exit: { code: number | null; signal: string | null } | null;
  wallMs: number;
}

/** A tool call claude asks about. */
export type RolePermissionAsk = Extract<ClaudeEvent, { kind: 'permission-asked' }>;

export interface RoleRunOptions {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The one user message (stream.ts briefLine); a text it refuses throws before anything starts. */
  brief: string;
  maxLineBytes: number;
  /** A run still without a result after this long fails as `timeout`; null: no limit. */
  timeoutMs: number | null;
  /** How long to wait for the exit after closing stdin (default 10 s); after SIGTERM and SIGKILL it waits this or 5 s, the shorter. */
  graceMs?: number;
  /** Every log line: claude's own (stamped), forge-raw and forge-stderr, and the runner's forge-* lines. Unredacted. */
  onLine: (line: string) => void;
  /** The session id claude's init reported, once. */
  onSessionId?: (id: string) => void;
  /**
   * Decides a permission prompt. Without it no one is there: every prompt is denied with
   * UNATTENDED_DENIED and counted. A callback that throws or rejects is a deny too.
   */
  onPermission?: (ask: RolePermissionAsk) => PermissionDecision | Promise<PermissionDecision>;
}

/** A running role child: `done` settles once it closed (or was given up on after SIGKILL); `stop` interrupts it. */
export interface RoleRun {
  done: Promise<RoleOutcome>;
  /** The runner was interrupted: the child's group gets SIGTERM, then SIGKILL, and unless the result is already in, the run fails `interrupted`. */
  stop(signal: NodeJS.Signals): void;
}

/** More distinct tool names than this are not kept: a run that used so many used more than Read. */
const MAX_TOOLS_KEPT = 20;
const DEFAULT_GRACE_MS = 10_000;
const KILL_GRACE_MS = 5_000;
/** setTimeout's own ceiling (about 24.8 days); a longer limit is no limit. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const forgeLine = (type: string, fields: Record<string, unknown>): string => JSON.stringify({ type, at: now(), ...fields });

/**
 * Starts one role child: `argv` with `env` in `cwd`, then the brief on its stdin, which stays open so
 * permission answers can be written. Throws (starting nothing) for a brief briefLine refuses.
 */
export function runRoleChild(adapter: ClaudeAdapter, o: RoleRunOptions): RoleRun {
  if (briefLine(o.brief) === null) throw new ForgeError('a role brief must be a non-empty string within BRIEF_MAX_CHARS', 'usage');
  const grace = typeof o.graceMs === 'number' && o.graceMs >= 0 ? o.graceMs : DEFAULT_GRACE_MS;
  // SIGKILL follows SIGTERM after 5 s, as a session stop does, or sooner with a shorter grace.
  const killGrace = Math.min(grace, KILL_GRACE_MS);
  const t0 = Date.now();
  let settle!: (r: RoleOutcome) => void;
  const done = new Promise<RoleOutcome>((resolve) => (settle = resolve));
  let finished = false;
  let started = false;
  let init = false;
  let sessionId: string | null = null;
  let firstRequest: RoleOutcome['firstRequest'] = null;
  const tools = new Set<string>();
  let dropped = 0;
  let result: Extract<ClaudeEvent, { kind: 'turn-ended' }> | null = null;
  /** Set by a timeout or an interrupt that came before the result. */
  let forced: RoleFailure | null = null;
  let spawnError: string | null = null;
  let denied = 0;
  let phase: 'running' | 'ending' | 'term' | 'kill' = 'running';
  let windTimer: NodeJS.Timeout | null = null;
  let turnTimer: NodeJS.Timeout | null = null;
  let child: ClaudeChild | null = null;

  const clearTimers = () => {
    if (windTimer) clearTimeout(windTimer);
    if (turnTimer) clearTimeout(turnTimer);
    windTimer = turnTimer = null;
  };
  const arm = (fn: () => void, ms = grace) => {
    if (windTimer) clearTimeout(windTimer);
    windTimer = setTimeout(fn, ms);
  };

  function finish(exit: RoleOutcome['exit']): void {
    if (finished) return;
    finished = true;
    clearTimers();
    const r = result as Extract<ClaudeEvent, { kind: 'turn-ended' }> | null;
    let failure: RoleFailure | null = forced;
    if (!failure && spawnError !== null) failure = { class: 'spawn', reason: spawnError, resetsAt: null };
    if (!failure && r && r.ok === false) {
      const cls: RoleFailureClass = r.budget ? 'budget' : r.limit ? 'limit' : r.auth ? 'auth' : 'error';
      failure = { class: cls, reason: r.reason, resetsAt: cls === 'limit' ? r.resetsAt : null };
    }
    if (!failure && !r) failure = { class: 'exit', reason: exit ? `claude closed (${exit.signal ? `signal ${exit.signal}` : `code ${exit.code}`}) without a result` : 'claude never closed after SIGKILL', resetsAt: null };
    settle({
      ok: failure === null,
      started,
      init,
      sessionId,
      summary: r?.ok ? (r.summary ?? null) : null,
      text: r?.ok ? (r.text ?? null) : null,
      firstRequest,
      tools: [...tools],
      dropped,
      cost: r?.cost ?? null,
      context: r?.context ?? null,
      failure,
      denied,
      exit,
      wallMs: Date.now() - t0,
    });
  }

  /** SIGTERM to the child's group now, SIGKILL after the grace, then give up after one more. */
  function term(): void {
    if (finished || !child || phase === 'term' || phase === 'kill') return;
    phase = 'term';
    child.endInput();
    child.signal('SIGTERM');
    arm(kill, killGrace);
  }
  function kill(): void {
    if (finished || !child) return;
    phase = 'kill';
    child.signal('SIGKILL');
    arm(() => finish(null), killGrace);
  }

  function answer(ask: RolePermissionAsk, decision: PermissionDecision, why?: 'unattended'): void {
    if (finished || !child) return;
    if (!child.answerPermission(ask.requestId, decision, why)) return;
    if (decision === 'deny') denied++;
    o.onLine(forgeLine('forge-permission', { requestId: ask.requestId, tool: ask.tool, decision, ...(why ? { why } : {}) }));
  }

  function onEvent(e: ClaudeEvent): void {
    if (finished) return;
    switch (e.kind) {
      case 'log':
        return o.onLine(e.line);
      case 'line-too-long':
        dropped++;
        return o.onLine(forgeLine('forge-line-too-long', { bytes: e.bytes }));
      case 'unreadable-line':
        dropped++;
        return;
      case 'protocol-error':
        dropped++;
        return o.onLine(forgeLine('forge-protocol-error', { message: e.message }));
      case 'stdin-error':
        return o.onLine(forgeLine('forge-stdin-error', { message: e.message }));
      case 'turn-started':
        init = true;
        return;
      case 'first-request':
        firstRequest ??= { input: e.input, cacheRead: e.cacheRead, cacheWrite: e.cacheWrite };
        return;
      case 'tool-use':
        for (const name of e.names) if (tools.size < MAX_TOOLS_KEPT) tools.add(name);
        return;
      case 'session-id':
        if (sessionId !== null) return;
        sessionId = e.id;
        return o.onSessionId?.(e.id);
      case 'permission-asked': {
        const decide = o.onPermission;
        if (!decide) return answer(e, 'deny', 'unattended');
        Promise.resolve()
          .then(() => decide(e))
          .then(
            (d) => answer(e, d),
            () => answer(e, 'deny', 'unattended'),
          );
        return;
      }
      case 'turn-ended':
        if (result) return;
        result = e;
        if (turnTimer) clearTimeout(turnTimer);
        turnTimer = null;
        if (phase !== 'running') return;
        phase = 'ending';
        child?.endInput();
        // A child that keeps running after its result (a background task, a hung exit) is stopped.
        arm(term);
        return;
      case 'process-error':
        if (e.started) return o.onLine(forgeLine('forge-process-error', { message: e.message }));
        started = false;
        spawnError = e.message;
        return finish(null);
      case 'exit':
        return finish({ code: e.code, signal: e.signal });
      default:
        return;
    }
  }

  try {
    child = adapter.start(o.argv, { cwd: o.cwd, env: o.env, maxLineBytes: o.maxLineBytes }, onEvent);
  } catch (e) {
    spawnError = (e as Error)?.message ?? String(e);
    finish(null);
    return { done, stop() {} };
  }
  started = child.pid !== null;
  if (!finished) {
    child.writeBrief(o.brief);
    if (typeof o.timeoutMs === 'number' && o.timeoutMs > 0 && o.timeoutMs <= MAX_TIMER_MS) {
      turnTimer = setTimeout(() => {
        turnTimer = null;
        if (finished || result) return;
        forced = { class: 'timeout', reason: `still running after ${Math.round(o.timeoutMs! / 1000)} s`, resetsAt: null };
        term();
      }, o.timeoutMs);
    }
  }
  return {
    done,
    stop(signal) {
      if (finished) return;
      // After the result the role's work is in: the run keeps its outcome and only its exit is hurried.
      if (!result) forced ??= { class: 'interrupted', reason: `the runner got ${signal}`, resetsAt: null };
      term();
    },
  };
}
