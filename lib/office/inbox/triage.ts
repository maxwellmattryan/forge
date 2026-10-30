// Readiness triage inside a `next` request: `forge tracker triage --limit=10`, then one headless
// `claude -p --agent forge:triage` child that reads the batch's fenced items and writes its verdicts, then
// `forge tracker triage --apply=<batch>`. The child gets the batch brief as its only message, the tools Read and
// Write, `dontAsk`, no session persistence and no setting source; its one writable path is the batch dir (the
// single Edit allow rule, the write guard's roots and the deny list). Its cost is metered to `_inbox` under the
// inbox's daily cap, and after it exits the confine digest is compared with the pool's baseline. A failure is a
// `triage` log line, never a stop of `next`; only tracker text the agent read could be in its reply, so the log
// keeps only one capped `TRIAGE:` line of it. docs/architecture/daemon.md › Intake runner.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TRUST_ENV } from '#core/config/load.ts';
import { INBOX_SCOPE, SCOPE_ENV } from '#core/job/requests.ts';
import { PLUGIN_ROOT, landing, paths } from '#core/paths.ts';
import { oneLineTitle } from '#core/text.ts';
import { appendMeter, METER_VERSION, meterDelta } from '#engine/metrics/meter.ts';
import type { MeterCum } from '#engine/metrics/meter.ts';
import { parseTemplate, roleArgv, sessionEnv } from '#integrations/claude/argv.ts';
import { runRoleChild, type RoleOutcome, type RoleRun } from '#integrations/claude/role.ts';
import { WRITE_ROOTS_ENV, absoluteDenyRules, confineDigest, writeRoots } from '../session/confine.ts';
import { inboxCapRefusal } from '../session/meter.ts';
import type { SessionContext, SessionOptions } from '../session/contract.ts';
import type { Call } from './handlers.ts';
import type { Config, Effort } from '#core/types.ts';

/** prepareTriage's batch id (YYYYMMDDTHHMMSSZ-xxxx): checked before a path or a flag is built from it. */
const BATCH = /^\d{8}T\d{6}Z-[a-z0-9]+$/;
const REPLY_MAX = 200;
const ZERO: MeterCum = { usd: 0, models: {} };
/**
 * DENY_TOOLS' `Edit(.forge/runtime/**)` twin would deny the one file the agent writes (deny beats allow). Every
 * other protected path stays denied; the batch dir stays the only writable place through the single allow rule
 * under dontAsk and the write guard's roots.
 */
const RUNTIME_RULE_END = '/.forge/runtime/**)';

export interface TriageDeps {
  ctx: SessionContext;
  o: SessionOptions;
  /** The config checkLaunch read for this request, and the digest it was trusted under. */
  config: Config;
  trusted: string;
  call: Call;
  /** One line to the inbox log (never claude's text beyond the TRIAGE: reply). */
  log(event: string, extra: Record<string, unknown>): void;
  /** Hands the runner the triage child's stop, so a pool stop ends it. */
  started(run: RoleRun): void;
  /** The runner's request was stopped: nothing more starts. */
  stopped(): boolean;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0);

/** The agent's summary, kept only as one `TRIAGE:` line of at most REPLY_MAX characters. */
function replyOf(outcome: RoleOutcome): string | null {
  const line = oneLineTitle(outcome.summary ?? '');
  return line.startsWith('TRIAGE:') ? line.slice(0, REPLY_MAX) : null;
}

/** Why the child gave no result, in Forge's words: claude's own failure text is not logged. */
function failureOf(outcome: RoleOutcome): string {
  const f = outcome.failure;
  if (!f) return 'the triage child gave no result';
  const own = f.class === 'exit' || f.class === 'timeout' || f.class === 'spawn' || f.class === 'interrupted';
  return `the triage child failed (${f.class})${own ? `: ${oneLineTitle(f.reason).slice(0, REPLY_MAX)}` : ''}`;
}

/**
 * Triage once, before a `next` claims anything. Never throws: every failure is a `triage` line with `error`.
 * Resolves false when the request must stop (a protected path changed, so the pool stopped, or the runner stopped it).
 */
export async function runTriage(root: string, deps: TriageDeps): Promise<boolean> {
  const { ctx, o, config: c, call, log } = deps;
  const fail = (error: string, extra: Record<string, unknown> = {}): boolean => {
    log('triage', { ...extra, error });
    return !deps.stopped();
  };
  try {
    const prep = await call(['tracker', 'triage', '--limit=10']);
    if (deps.stopped()) return false;
    if (prep.code !== 0) return fail(`tracker triage failed: ${prep.error ?? `exit ${prep.code ?? prep.signal}`}`);
    const out = obj(prep.json);
    const pending = count(out.pending);
    if (out.batch === null || pending === 0) {
      log('triage', { batch: null, pending: 0 });
      return true;
    }
    if (typeof out.batch !== 'string' || !BATCH.test(out.batch)) return fail('tracker triage returned a malformed batch id');
    const batch = out.batch;
    let refusal: string | null;
    try {
      refusal = inboxCapRefusal(root, c, Date.now())?.message ?? null;
    } catch (e) {
      refusal = `the inbox's daily cap can't be checked: ${(e as Error).message}`;
    }
    if (refusal) return fail(refusal, { batch, pending });

    const roots = writeRoots(root, c);
    // The triage dir is where runtime state lives, under the real checkout: a link there that leads elsewhere is refused.
    const triageDir = landing(path.join(paths(root).runtime, 'triage'));
    if (triageDir !== path.join(fs.realpathSync(root), '.forge', 'runtime', 'triage')) return fail('the triage dir is not under the checkout', { batch, pending });
    const dir = landing(path.join(triageDir, batch));
    const deny = absoluteDenyRules(root, c, roots).filter((r) => !r.endsWith(RUNTIME_RULE_END));
    const sessionId = crypto.randomUUID();
    const argv = roleArgv({
      executable: parseTemplate(c.daemon.command)[0],
      pluginRoot: PLUGIN_ROOT,
      agent: 'forge:triage',
      tools: ['Read', 'Write'],
      model: typeof out.model === 'string' ? out.model : null,
      effort: (typeof out.effort === 'string' ? out.effort : null) as Effort | null,
      permissionMode: 'dontAsk',
      allowedTools: ['Read', 'Write'],
      writeRoots: [dir],
      deny,
      session: { id: sessionId, resume: false },
      persist: false,
    });
    // The write guard's `jobs` root is a folder of per-id folders: it allows <triage>/<batch>/<file> and nothing else.
    const env = {
      ...sessionEnv(o.env, c.daemon.auth),
      FORGE_ROOT: root,
      [WRITE_ROOTS_ENV]: JSON.stringify({ jobs: triageDir, worktrees: [] }),
      [TRUST_ENV]: deps.trusted,
      [SCOPE_ENV]: INBOX_SCOPE,
    };
    const minutes = c.daemon?.turnTimeoutMinutes;
    const timeoutMs = o.turnTimeoutMs ?? (typeof minutes === 'number' && minutes > 0 ? minutes * 60_000 : null);
    if (deps.stopped()) return false;
    // No onPermission: under dontAsk nothing should ask, and anything that does is denied as unattended.
    const run = runRoleChild(o.claude, { argv, cwd: root, env, brief: typeof out.brief === 'string' ? out.brief : '', maxLineBytes: o.maxLineBytes, timeoutMs, graceMs: o.graceMs, onLine: () => {} });
    deps.started(run);
    const outcome = await run.done;
    let usd = 0;
    let tokens = 0;
    if (outcome.cost) {
      try {
        const delta = meterDelta(ZERO, outcome.cost);
        appendMeter(root, { v: METER_VERSION, ts: new Date().toISOString(), scope: INBOX_SCOPE, sessionId, spawnId: crypto.randomUUID(), turn: 1, ...delta });
        [usd, tokens] = [delta.usd, delta.tokens];
      } catch (e) {
        log('error', { message: `meter: ${(e as Error).message}` });
      }
    }
    const facts = { batch, pending, ok: outcome.ok, reply: replyOf(outcome), usd, tokens };
    // The post-exit check, as after a gate run: a protected path that changed stops the pool, and --apply never runs.
    if (outcome.started) {
      let same = false;
      try {
        same = confineDigest(root, c) === ctx.confined();
      } catch {}
      if (!same) {
        ctx.untrusted();
        log('triage', { ...facts, error: 'a protected path changed during triage' });
        return false;
      }
    }
    if (deps.stopped()) return false;
    if (!outcome.ok) return fail(failureOf(outcome), facts);
    const applied = await call(['tracker', 'triage', `--apply=${batch}`]);
    if (deps.stopped()) return false;
    if (applied.code !== 0) return fail(`tracker triage --apply failed: ${applied.error ?? `exit ${applied.code ?? applied.signal}`}`, facts);
    const a = obj(applied.json);
    log('triage', { ...facts, ready: count(a.ready), needsInfo: count(a.needsInfo) });
    return true;
  } catch (e) {
    return fail(`triage: ${oneLineTitle((e as Error)?.message ?? String(e)).slice(0, REPLY_MAX)}`);
  }
}
