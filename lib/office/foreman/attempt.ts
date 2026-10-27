// One gate run's model call: a headless `claude -p --agent forge:assistant` child that gets the assist
// brief as its first stdin line and answers with one verdict line, asked once more on the same child when
// that line is malformed. The spawn passes the same checks as a session's (checkLaunch, the write roots and
// deny rules), runs under `--permission-mode dontAsk` with no Bash, and in the `_gates` scope, which refuses
// every forge command. Each costed turn is metered to `_gates`, a turn past daemon.turnTimeoutMinutes is
// killed, and after the child exits the confine digest is compared with the pool's baseline, as after a
// session's turn. It never reads claude's stream lines beyond the events lib/integrations/claude/ reports.
// docs/architecture/foreman.md › Gate runs.
import crypto from 'node:crypto';
import { TRUST_ENV } from '#core/config/load.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { GATES_SCOPE, SCOPE_ENV } from '#core/job/requests.ts';
import { appendMeter, METER_VERSION, meterDelta } from '#engine/metrics/meter.ts';
import type { MeterCum } from '#engine/metrics/meter.ts';
import { buildArgv, sessionEnv } from '#integrations/claude/argv.ts';
import type { ClaudeChild, ClaudeEvent } from '#integrations/claude/types.ts';
import { checkLaunch } from '../session/launch.ts';
import { confineDigest, spawnConfinement } from '../session/confine.ts';
import { officeCapLeft } from '../session/meter.ts';
import type { SessionContext, SessionOptions } from '../session/contract.ts';
import { parseVerdict, type Verdict } from './verdict.ts';
import type { Config, Effort } from '#core/types.ts';

/** The assistant's tools: it reads the files its brief names and writes feedback.md; Write becomes the write-root Edit rules. */
export const GATE_RUN_TOOLS: readonly string[] = Object.freeze(['Read', 'Grep', 'Glob', 'Write']);

/** Why a run ended without a verdict. Only `no-result`, `failed-turn` (not a limit) and `timed-out` count against the request. */
export type AttemptFailure = 'no-result' | 'failed-turn' | 'timed-out' | 'spawn-refused' | 'stopped';

export type AttemptResult =
  | { verdict: Verdict; reason: string; malformed: boolean; attempts: number; usd: number; tokens: number }
  | { failure: AttemptFailure; limit?: { resetsAt: number | null }; attempts: number; usd: number; tokens: number; message: string };

/** A started attempt: its outcome, and the stops the runner calls on a pool stop, close or exit. */
export interface Attempt {
  readonly done: Promise<AttemptResult>;
  readonly pid: number | null;
  /** Kills the child (SIGTERM, then SIGKILL after the grace period); the attempt ends `stopped`. */
  stop(): Promise<void>;
  killSync(): void;
}

export interface AttemptInput {
  brief: string;
  model: string | null;
  effort: Effort | null;
  /** Logs one line to the gate log (never claude's text). */
  log(event: string, extra: Record<string, unknown>): void;
}

const ZERO: MeterCum = { usd: 0, models: {} };

/**
 * Starts one attempt. Never throws: a refused launch ends `spawn-refused` (checkLaunch has already stopped the
 * pool through ctx), anything else that keeps the child from answering ends as a failure.
 */
export function startAttempt(root: string, ctx: SessionContext, o: SessionOptions, input: AttemptInput): Attempt {
  let usd = 0;
  let tokens = 0;
  let attempts = 0;
  let settled = false;
  let resolve!: (r: AttemptResult) => void;
  const done = new Promise<AttemptResult>((r) => (resolve = r));
  let claude: ClaudeChild | null = null;
  let turnTimer: NodeJS.Timeout | null = null;
  let exited = false;
  const sessionId = crypto.randomUUID();
  const spawnId = crypto.randomUUID();
  let base: MeterCum = ZERO;
  let config: Config | null = null;

  const fail = (failure: AttemptFailure, message: string, limit?: { resetsAt: number | null }): AttemptResult => ({ failure, message, attempts, usd, tokens, ...(limit ? { limit } : {}) });
  const clearTurn = () => {
    if (turnTimer) clearTimeout(turnTimer);
    turnTimer = null;
  };

  /** Waits for the child's close, at most `ms`. */
  const closedWithin = (ms: number): Promise<boolean> => {
    if (!claude || exited) return Promise.resolve(true);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)));
    return Promise.race([claude.closed.then(() => true), timeout]).finally(() => clearTimeout(timer));
  };

  /** Ends stdin, then SIGTERM and SIGKILL as a session's kill does, each after the grace period. */
  async function kill(term: boolean): Promise<void> {
    if (!claude || exited) return;
    claude.endInput();
    if (!term && (await closedWithin(o.graceMs))) return;
    claude.signal('SIGTERM');
    if (await closedWithin(o.graceMs)) return;
    claude.signal('SIGKILL');
    await closedWithin(o.graceMs);
  }

  /** Settles once: stops the child (gently after a verdict), checks the confine digest, then resolves. */
  async function finish(r: AttemptResult, term: boolean): Promise<void> {
    if (settled) return;
    settled = true;
    clearTurn();
    await kill(term);
    // The post-exit check, as after a session's turn: a protected path that changed stops the pool, and nothing is recorded.
    if (claude && config && !('failure' in r && r.failure === 'stopped')) {
      let same = false;
      try {
        same = confineDigest(root, config) === ctx.confined();
      } catch {}
      if (!same) {
        ctx.untrusted();
        return resolve(fail('stopped', 'a protected path changed during the gate run'));
      }
    }
    resolve(r);
  }

  function armTurn(c: Config): void {
    clearTurn();
    let ms = o.turnTimeoutMs;
    if (ms === null) {
      const minutes = c.daemon?.turnTimeoutMinutes;
      if (typeof minutes !== 'number' || !(minutes > 0)) return;
      ms = minutes * 60_000;
    }
    if (!(ms > 0) || ms > 2 ** 31 - 1) return;
    turnTimer = setTimeout(() => {
      turnTimer = null;
      void finish(fail('timed-out', 'the gate run passed daemon.turnTimeoutMinutes'), true);
    }, ms);
    turnTimer.unref?.();
  }

  function meter(e: Extract<ClaudeEvent, { kind: 'turn-ended' }>): void {
    if (!e.cost) return;
    try {
      const delta = meterDelta(base, e.cost);
      appendMeter(root, { v: METER_VERSION, ts: new Date().toISOString(), scope: GATES_SCOPE, sessionId, spawnId, turn: attempts, ...delta });
      base = delta.cum;
      usd += delta.usd;
      tokens += delta.tokens;
    } catch (err) {
      input.log('error', { message: `meter: ${(err as Error).message}` });
    }
  }

  function onEvent(e: ClaudeEvent): void {
    if (e.kind === 'exit') {
      exited = true;
      if (!settled) void finish(fail('no-result', `the assistant exited without a verdict (code ${e.code}, signal ${e.signal})`), false);
      return;
    }
    if (e.kind === 'process-error' && !e.started) {
      exited = true;
      return void finish(fail('no-result', `cannot start the assistant: ${e.message}`), false);
    }
    if (e.kind === 'permission-asked') {
      // dontAsk makes this impossible; if claude asks anyway no one can answer, so deny it rather than hold a slot until the turn timeout.
      input.log('error', { message: 'the assistant asked for a permission: denied' });
      claude?.answerPermission(e.requestId, 'deny');
      return;
    }
    if (e.kind !== 'turn-ended' || settled) return;
    attempts++;
    meter(e);
    if (e.ok === false) {
      // A usage limit is no fault of the request: the runner gives the claim back and waits it out.
      if (e.limit) return void finish(fail('failed-turn', `usage limit: ${e.reason}`, { resetsAt: e.resetsAt }), true);
      return void finish(fail('failed-turn', `the assistant's turn failed: ${e.reason}`), true);
    }
    const parsed = parseVerdict(e.text);
    if (parsed) return void finish({ ...parsed, malformed: false, attempts, usd, tokens }, false);
    // Asked once more on the same child, which keeps its reading; a second malformed line is an escalate.
    if (attempts >= 2) return void finish({ verdict: 'escalate', reason: 'malformed verdict', malformed: true, attempts, usd, tokens }, false);
    claude!.writeVerdictRetry();
    if (config) armTurn(config);
  }

  const launch = checkLaunch(root, ctx, o);
  if (!launch) {
    settled = true;
    resolve(fail('spawn-refused', 'the launch checks refused the gate run'));
  } else {
    config = launch.config;
    const c = launch.config;
    try {
      const confined = spawnConfinement(root, c);
      const left = officeCapLeft(root, c, Date.now());
      const argv = buildArgv(c.daemon.command, {
        pluginRoot: PLUGIN_ROOT,
        session: { id: sessionId, resume: false },
        allowedTools: [...GATE_RUN_TOOLS],
        permissionMode: 'dontAsk',
        effort: input.effort,
        model: input.model,
        writeRoots: [confined.roots.jobs, ...confined.roots.worktrees],
        // Bash too, whatever daemon.command allows: the assistant runs no command.
        deny: [...confined.deny, 'Bash'],
        maxBudgetUsd: left,
        agent: 'forge:assistant',
      });
      // The scope reaches the child only through its environment: `_gates` refuses every forge command.
      const env = { ...sessionEnv(o.env, c.daemon.auth), ...confined.env, [TRUST_ENV]: launch.trusted, [SCOPE_ENV]: GATES_SCOPE };
      claude = o.claude.start(argv, { cwd: root, env, maxLineBytes: o.maxLineBytes }, onEvent);
      if (!claude.writeBrief(input.brief)) void finish(fail('no-result', 'the brief could not be written'), true);
      else armTurn(c);
    } catch (e) {
      settled = true;
      resolve(fail('no-result', `cannot start the assistant: ${(e as Error).message}`));
    }
  }

  return {
    done,
    get pid() {
      return claude?.pid ?? null;
    },
    async stop() {
      if (!settled) await finish(fail('stopped', 'the pool stopped'), true);
      await done;
    },
    killSync() {
      if (claude && !exited) claude.signal('SIGTERM');
    },
  };
}
