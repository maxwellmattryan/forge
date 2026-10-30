// One model child of an office run: a headless `claude -p --agent forge:<drafter|surveyor|director>` with its
// brief as the only stdin message (runRoleChild), started after the same launch checks as a session's, under
// `--permission-mode dontAsk` with Bash denied, its own tools and write roots, scope `_office` and
// `--max-budget-usd` set to what is left of the office's daily cap. Its costed result is metered once to
// `_office`, and after it ends the confine digest is compared with the pool's baseline: a protected path that
// changed stops the pool and the child ends `stopped`. docs/architecture/foreman.md › Office runs.
import crypto from 'node:crypto';
import { OFFICE_SCOPE } from '#api/constants.ts';
import { TRUST_ENV } from '#core/config/load.ts';
import { SCOPE_ENV } from '#core/job/requests.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { appendMeter, METER_VERSION, meterDelta } from '#engine/metrics/meter.ts';
import type { MeterCum } from '#engine/metrics/meter.ts';
import { buildArgv, sessionEnv, type ChildAgent } from '#integrations/claude/argv.ts';
import { runRoleChild, type RoleOutcome, type RoleRun } from '#integrations/claude/role.ts';
import type { ClaudeAdapter } from '#integrations/claude/types.ts';
import { checkLaunch } from '../../session/launch.ts';
import { WRITE_ROOTS_ENV, confineDigest, spawnConfinement } from '../../session/confine.ts';
import { officeCapLeft } from '../../session/meter.ts';
import type { SessionContext, SessionOptions } from '../../session/contract.ts';
import type { Config, Effort } from '#core/types.ts';

/** The agents an office run starts, and the built-in tools each gets (Write becomes an Edit rule per write root). */
export const OFFICE_AGENTS = Object.freeze({
  drafter: { agent: 'forge:drafter', tools: Object.freeze(['Read', 'Grep', 'Glob', 'Write']) },
  surveyor: { agent: 'forge:surveyor', tools: Object.freeze(['Read']) },
  director: { agent: 'forge:director', tools: Object.freeze(['Read']) },
} as const);

/** Why a child ended without a result the run may use. `failed` counts against the request; the rest give the claim back. */
export type OfficeChildFailure = 'stopped' | 'limit' | 'capped' | 'failed' | 'spawn-refused';

export type OfficeChildResult =
  | { ok: true; text: string; sessionId: string; usd: number; tokens: number }
  | { ok: false; failure: OfficeChildFailure; resetsAt: number | null; message: string; sessionId: string; usd: number; tokens: number };

export interface OfficeChild {
  readonly done: Promise<OfficeChildResult>;
  readonly pid: number | null;
  /** Interrupts the child (stdin closed, SIGTERM, then SIGKILL); it ends `stopped` unless its result was already in. */
  stop(): Promise<void>;
  killSync(): void;
}

export interface OfficeChildInput {
  agent: ChildAgent;
  brief: string;
  model: string | null;
  effort: Effort | null;
  tools: readonly string[];
  writeRoots: string[];
  /** One line to the office log (never claude's text). */
  log(event: string, extra: Record<string, unknown>): void;
}

const ZERO: MeterCum = { usd: 0, models: {} };

/** The role failure classes as an office run counts them. */
function failureOf(cls: string): OfficeChildFailure {
  if (cls === 'interrupted') return 'stopped';
  if (cls === 'limit') return 'limit';
  if (cls === 'budget') return 'capped';
  return 'failed';
}

/** Starts one model child. Never throws: a refused launch ends `spawn-refused` (checkLaunch already stopped the pool through ctx). */
export function startOfficeChild(root: string, ctx: SessionContext, o: SessionOptions, input: OfficeChildInput): OfficeChild {
  const sessionId = crypto.randomUUID();
  const spawnId = crypto.randomUUID();
  const fail = (failure: OfficeChildFailure, message: string, extra: { resetsAt?: number | null; usd?: number; tokens?: number } = {}): OfficeChildResult => ({
    ok: false,
    failure,
    resetsAt: extra.resetsAt ?? null,
    message,
    sessionId,
    usd: extra.usd ?? 0,
    tokens: extra.tokens ?? 0,
  });
  let run: RoleRun | null = null;
  let pid: number | null = null;
  let done: Promise<OfficeChildResult>;

  /** Meters the result's cost once to `_office`; a write that fails is logged, never thrown. */
  function meter(outcome: RoleOutcome): { usd: number; tokens: number } {
    if (!outcome.cost) return { usd: 0, tokens: 0 };
    const delta = meterDelta(ZERO, outcome.cost);
    try {
      appendMeter(root, { v: METER_VERSION, ts: new Date().toISOString(), scope: OFFICE_SCOPE, sessionId, spawnId, turn: 1, ...delta });
    } catch (e) {
      input.log('error', { message: `meter: ${(e as Error).message}` });
    }
    return { usd: delta.usd, tokens: delta.tokens };
  }

  async function settle(c: Config, outcome: RoleOutcome): Promise<OfficeChildResult> {
    const spent = meter(outcome);
    // The post-exit check, as after a session's turn: a protected path that changed stops the pool, and nothing is recorded.
    if (outcome.failure?.class !== 'interrupted') {
      let same = false;
      try {
        same = confineDigest(root, c) === ctx.confined();
      } catch {}
      if (!same) {
        ctx.untrusted();
        return fail('stopped', 'a protected path changed during the office run', spent);
      }
    }
    if (outcome.ok) return { ok: true, text: outcome.text ?? '', sessionId, ...spent };
    const f = outcome.failure ?? { class: 'exit', reason: 'no result', resetsAt: null };
    return fail(failureOf(f.class), `${input.agent} ${f.class}: ${f.reason}`, { resetsAt: f.resetsAt, ...spent });
  }

  const launch = checkLaunch(root, ctx, o);
  if (!launch) done = Promise.resolve(fail('spawn-refused', 'the launch checks refused the office run'));
  else {
    const c = launch.config;
    try {
      const confined = spawnConfinement(root, c);
      const argv = buildArgv(c.daemon.command, {
        pluginRoot: PLUGIN_ROOT,
        session: { id: sessionId, resume: false },
        allowedTools: [...input.tools],
        permissionMode: 'dontAsk',
        effort: input.effort,
        model: input.model,
        writeRoots: input.writeRoots,
        // Bash too, whatever daemon.command allows: no office run's child runs a command.
        deny: [...confined.deny, 'Bash'],
        maxBudgetUsd: officeCapLeft(root, c, Date.now()),
        agent: input.agent,
      });
      // The scope reaches the child only through its environment: `_office` keeps the CLI's office refusals. The write
      // guard (hooks/write-guard.ts) gets this child's own roots in place of every worktrees root, as its rules do.
      const guard = { [WRITE_ROOTS_ENV]: JSON.stringify({ jobs: confined.roots.jobs, worktrees: input.writeRoots }) };
      const env = { ...sessionEnv(o.env, c.daemon.auth), ...confined.env, ...guard, [TRUST_ENV]: launch.trusted, [SCOPE_ENV]: OFFICE_SCOPE };
      let timeoutMs = o.turnTimeoutMs;
      if (timeoutMs === null) {
        const minutes = c.daemon?.turnTimeoutMinutes;
        timeoutMs = typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : null;
      }
      // The adapter, seen through: runRoleChild keeps the child to itself, and the office log wants its pid.
      const adapter: ClaudeAdapter = {
        start(a, opts, onEvent) {
          const child = o.claude.start(a, opts, onEvent);
          pid = child.pid;
          return child;
        },
      };
      run = runRoleChild(adapter, { argv, cwd: root, env, brief: input.brief, maxLineBytes: o.maxLineBytes, timeoutMs, graceMs: o.graceMs, onLine: () => {} });
      done = run.done.then((outcome) => settle(c, outcome));
    } catch (e) {
      done = Promise.resolve(fail('failed', `cannot start ${input.agent}: ${(e as Error).message}`));
    }
  }
  return {
    done,
    get pid() {
      return pid;
    },
    async stop() {
      run?.stop('SIGTERM');
      await done;
    },
    killSync() {
      run?.stop('SIGTERM');
    },
  };
}
