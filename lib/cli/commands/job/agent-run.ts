// `forge job agent run`: one spawn `forge job step` chose, run as its own headless claude child in the job's
// worktree (lib/integrations/claude/role.ts), with Forge recording the agent's start, attach and end itself
// and its usage taken from the child's own result line. docs/architecture/daemon-runtime.md "Role runs".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { refuseInboxDrive } from '#office/owner.ts';
import { absoluteDenyRules, confineDigest, spawnConfinement } from '#office/session/confine.ts';
import { loadStepInput, step } from '#engine/pipeline/step.ts';
import { jobWorktreeProblem } from '#engine/workspace/regenerate.ts';
import { meterDelta, type MeterCum } from '#engine/metrics/meter.ts';
import { importClaudeCodeTranscript } from '#engine/metrics/usage.ts';
import { rolePromptChars } from '#engine/evals/provenance.ts';
import { knownValues, redactKnown } from '#engine/guard/known-secrets.ts';
import { claudeAdapter } from '#integrations/claude/child.ts';
import { commandPermissionMode, parseTemplate, roleArgv, sessionEnv } from '#integrations/claude/argv.ts';
import { runRoleChild, type RoleFailure, type RoleOutcome, type RoleRun } from '#integrations/claude/role.ts';
import { briefLine } from '#integrations/claude/stream.ts';
import { TRUST_ENV, daemonProblems, loadConfig, trackerSymlinks, trustDigest } from '#core/config/load.ts';
import { assertEpoch, attachAgent, importCursor, leaseStatus, loadJob } from '#core/job/store.ts';
import { UUID, ensureRoleRunDir, openAppend, readInfo, roleRunFiles } from '#core/job/session-files.ts';
import { SCOPE_ENV, daemonScope } from '#core/job/requests.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { PLUGIN_ROOT, paths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import type { AgentUsage, Config, LoadedJob } from '#core/types.ts';
import type { StepAction, StepSpawn } from '#engine/pipeline/types.ts';
import { num, req, str } from '../args.ts';
import { endAgent, startAgent } from './agent.ts';
import type { CliContext, Dispatched } from '../../types.ts';

/** A role child's stdout line cap: the session default. */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const SIDECAR_VERSION = 1;
const ZERO: MeterCum = { usd: 0, models: {} };
const COST_FIELDS = ['usd', 'input', 'output', 'cacheRead', 'cacheWrite'] as const;
/** The exit each failure class gives: claude that never started or never finished is an external failure. */
const EXTERNAL = new Set(['exit', 'spawn']);

const staleStep = (msg: string) => new ForgeError(`${msg}; nothing was started: read forge job step again`, 'stale_step');
const described = (a: StepAction) => `forge job step returns ${a.action} (${a.rule})${a.action === 'spawn' ? ` for ${a.role}` : ''}`;
const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** A sidecar's cumulative cost, or null for anything the runner did not write (a missing, planted or malformed file). */
function sidecarCum(file: string): MeterCum | null {
  const raw = readInfo(file);
  const cum = raw?.v === SIDECAR_VERSION ? raw.cum : null;
  if (!cum || typeof cum !== 'object' || !fin(cum.usd) || !cum.models || typeof cum.models !== 'object' || Array.isArray(cum.models)) return null;
  const entries = Object.entries(cum.models as Record<string, any>);
  if (entries.length > 20 || entries.some(([name, m]) => !name || name.length > 100 || name === '__proto__' || !m || !COST_FIELDS.every((f) => fin(m[f])))) return null;
  return { usd: cum.usd, models: Object.fromEntries(entries.map(([name, m]) => [name, Object.fromEntries(COST_FIELDS.map((f) => [f, m[f]]))])) } as MeterCum;
}

/** `child` lies under `parent` (both real paths), and is not `parent` itself. */
function under(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** A delta's four token counts summed into one AgentUsage, under the model that used the most of them. */
function deltaUsage(base: MeterCum, cost: NonNullable<RoleOutcome['cost']>, fallbackModel: string, wallMs: number): AgentUsage {
  const d = meterDelta(base, cost);
  const u = { model: fallbackModel, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: d.tokens, durationMs: wallMs, exact: true };
  let most = 0;
  for (const [name, m] of Object.entries(d.models)) {
    u.input += m.input;
    u.output += m.output;
    u.cacheRead += m.cacheRead;
    u.cacheWrite += m.cacheWrite;
    const t = m.input + m.output + m.cacheRead + m.cacheWrite;
    if (t > most) [most, u.model] = [t, name];
  }
  return u;
}

/** The spawn this call runs, or stale_step: step must still return a spawn, and `index` must be in its list. */
function pickSpawn(a: StepAction, index: number): StepSpawn {
  if (a.action !== 'spawn') throw staleStep(`${described(a)}, not a spawn`);
  const list = [a, ...(a.spawns ?? [])];
  if (index >= list.length) throw staleStep(`${described(a)} with ${list.length} spawn${list.length === 1 ? '' : 's'}; --spawn-index ${index} is past them`);
  return list[index];
}

export async function agentRunCmd(ctx: CliContext, rest: string[], flags: Record<string, any>, env: NodeJS.ProcessEnv = process.env): Promise<Dispatched> {
  const { root } = ctx;
  // 1. Every flag, before anything is read.
  const session = req(str(flags.session, '--session'), '--session');
  const index = num(flags['spawn-index'], '--spawn-index', { integer: true }) ?? 0;
  const epoch = num(flags.epoch, '--epoch', { integer: true });
  const id = req(rest[0], 'job id');
  // 2. The job, and who may drive it.
  const job = loadJob(root, id);
  const jobId = job.id;
  refuseInboxDrive(jobId, env);
  // The child gets this job's own scope (and so its own-job rights: merge, repo proposals), so only that job's session or a human may mint it.
  const scope = daemonScope(env);
  if ('problem' in scope) throw new ForgeError(scope.problem, 1);
  if (scope.daemon && scope.scope !== jobId) throw new ForgeError(`forge job agent run runs only in job ${jobId}'s own session or a human's terminal, not the ${scope.scope} session`, 1);
  // 3. The hold check, as `forge job advance` words it.
  if (epoch !== undefined) assertEpoch(job, epoch, session);
  if (job.lease.driver !== session) {
    const driver = job.lease.driver;
    if (driver && leaseStatus(job).status === 'live') throw new ForgeError(`job ${jobId} is being driven by session ${driver}; agent run only starts a role for a job its session holds`, 3);
    throw new ForgeError(`job ${jobId} is not claimed by session ${session}; run: forge job claim ${jobId} --session ${session}`, 3);
  }
  // 4. The spawn step chose.
  const sp = pickSpawn(step(loadStepInput(root, ctx.config, jobId)), index);
  // 5. The config, read once: its digest and its parse come from the same bytes.
  let bytes: Buffer | null = null;
  try {
    bytes = fs.readFileSync(paths(root).config);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ForgeError(`.forge/config.yml is unreadable (${(e as NodeJS.ErrnoException).code})`);
  }
  const digest = trustDigest(root, bytes);
  const links = trackerSymlinks(root);
  if (links.length) throw new ForgeError(`.forge/trackers/ contains symlinks (${links.join(', ')}), whose targets a role run can't pin; a human replaces them with files`);
  if (env.FORGE_DAEMON === '1' && env[TRUST_ENV] !== digest)
    throw new ForgeError(`${TRUST_ENV} is not the digest of the trusted files as they are now: a file Forge trusts changed since a human started the daemon, so no role child starts from it`);
  const config: Config = loadConfig(root, { text: bytes === null ? null : bytes.toString('utf8') }).config;
  const problem = daemonProblems(config, root)[0];
  if (problem) throw new ForgeError(`cannot start a role child: ${problem}`);
  // 6. The worktree: a real one of this job, under a worktrees root a role child may write.
  const wtProblem = jobWorktreeProblem(root, job);
  if (wtProblem) throw new ForgeError(`cannot start a role child: ${wtProblem}`);
  // 7. Confinement, as a job session's subagent gets it, with only the absolute deny rules.
  const confined = spawnConfinement(root, config);
  const wt = fs.realpathSync(job.worktree!);
  if (!confined.roots.worktrees.some((w) => under(w, wt)))
    throw new ForgeError(`cannot start a role child: job ${jobId}'s worktree ${wt} lies under none of the worktrees roots (${confined.roots.worktrees.join(', ')})`);
  const deny = absoluteDenyRules(root, config, confined.roots);
  if (briefLine(sp.brief) === null) throw new ForgeError(`cannot start a role child: step's brief for ${sp.role} is empty or over the brief cap`);
  // What a session's turns are held to as well as trustDigest: git status and content over the protected set, every nested CLAUDE.md, an in-checkout hooks dir.
  const confineBefore = confineDigest(root, config);
  // 8. The env. Outside a daemon session whoever runs the CLI is the trust anchor, as a human starting the pool is.
  // FORGE_ROOT is pinned, as the pool pins it for every session: an inherited one must not steer the child's `forge` calls elsewhere.
  const trusted = env.FORGE_DAEMON === '1' ? (env[TRUST_ENV] as string) : digest;
  const childEnv = { ...sessionEnv(env, config.daemon.auth), ...confined.env, FORGE_ROOT: root, [TRUST_ENV]: trusted, [SCOPE_ENV]: jobId };
  // 9. The command line; a resume only of a session id, never of an in-process subagent's.
  const resumeId = typeof sp.resume === 'string' && UUID.test(sp.resume) ? sp.resume : null;
  const argvFor = (sessionId: string, resume: boolean) =>
    roleArgv({
      executable: parseTemplate(config.daemon.command)[0],
      pluginRoot: PLUGIN_ROOT,
      agent: sp.agent,
      model: sp.model,
      effort: sp.effort,
      permissionMode: commandPermissionMode(config.daemon.command),
      allowedTools: config.daemon.allowedTools,
      writeRoots: [confined.roots.jobs, ...confined.roots.worktrees],
      deny,
      session: { id: sessionId, resume },
    });
  let sessionId = resumeId ?? crypto.randomUUID();
  let argv = argvFor(sessionId, resumeId !== null);
  const baseline = resumeId ? sidecarCum(roleRunFiles(root, jobId, resumeId).cum) : ZERO;

  // 10. The start, fenced: step must still hold this spawn under the job lock, so of two racing callers one starts.
  const check = (j: LoadedJob) => {
    const again = step(loadStepInput(root, ctx.config, jobId));
    const list = again.action === 'spawn' ? [again, ...(again.spawns ?? [])] : [];
    if (j.round !== sp.round || !list.some((s) => s.role === sp.role && s.round === sp.round)) throw staleStep(`${described(again)}, no longer the spawn of ${sp.role} in round ${sp.round}`);
  };
  startAgent(root, config, jobId, { role: sp.role, model: sp.model, output: sp.output, retry: sp.retry === true, fence: { epoch: epoch ?? job.lease.epoch, session, check } });

  // 11. The run, with the runner's own interrupts passed to the child first.
  const t0 = Date.now();
  const known = knownValues(root, jobId, config);
  const timeoutMs = typeof config.daemon.turnTimeoutMinutes === 'number' && config.daemon.turnTimeoutMinutes > 0 ? config.daemon.turnTimeoutMinutes * 60_000 : null;
  let interrupted: NodeJS.Signals | null = null;
  let current: RoleRun | null = null;
  const onSignal = (sig: NodeJS.Signals) => {
    interrupted ??= sig;
    current?.stop(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let log = '';
  let reported: string | null = null;
  let outcome: RoleOutcome;
  let resumeFailed = false;
  const launch = async (): Promise<RoleOutcome> => {
    const files = roleRunFiles(root, jobId, sessionId);
    log = files.log;
    let fd: number;
    try {
      ensureRoleRunDir(root, files);
      fd = openAppend(files.log);
    } catch (e) {
      return { ok: false, started: false, init: false, sessionId: null, summary: null, cost: null, failure: { class: 'spawn', reason: `the run log can't be opened: ${(e as Error).message}`, resetsAt: null }, denied: 0, exit: null, wallMs: 0 };
    }
    try {
      if (interrupted) return { ok: false, started: false, init: false, sessionId: null, summary: null, cost: null, failure: { class: 'interrupted', reason: `the runner got ${interrupted}`, resetsAt: null }, denied: 0, exit: null, wallMs: 0 };
      current = runRoleChild(claudeAdapter(), {
        argv,
        // The path that was checked, not job.worktree again: a link swapped since would move the cwd.
        cwd: wt,
        env: childEnv,
        brief: sp.brief,
        maxLineBytes: MAX_LINE_BYTES,
        timeoutMs,
        onLine: (line) => {
          // A log write that fails (a full disk) must not take the runner down before the end is recorded.
          try {
            fs.writeSync(fd, redactKnown(line, known) + '\n');
          } catch {}
        },
        onSessionId: (sid) => {
          if (!UUID.test(sid)) return;
          reported = sid;
          try {
            attachAgent(root, jobId, sp.role, sid);
          } catch {}
        },
      });
      return await current.done;
    } finally {
      current = null;
      fs.closeSync(fd);
    }
  };
  try {
    outcome = await launch();
    // 12. A resume that never reached claude's init found no conversation: once more, as a fresh session.
    if (resumeId !== null && !outcome.init && !interrupted && outcome.failure && ['error', 'exit'].includes(outcome.failure.class)) {
      resumeFailed = true;
      sessionId = crypto.randomUUID();
      argv = argvFor(sessionId, false);
      reported = null;
      outcome = await launch();
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const wallMs = Date.now() - t0;
  const agentId: string = reported ?? sessionId;
  // 13. Whatever the child did, a trusted or protected file it changed fails the run, as it stops a session's turn.
  let failure: RoleFailure | null = outcome.failure;
  if (trustDigest(root) !== digest || confineDigest(root, config) !== confineBefore)
    failure = { class: 'untrusted', reason: 'a file Forge trusts or protects in the main checkout changed during the run; a human reviews it', resetsAt: null };

  // 14. Usage from the result's own cumulative, less the baseline its session had; the sidecar keeps the new one.
  const resumed = resumeId !== null && !resumeFailed;
  let usage: (AgentUsage & { through?: string | null }) | null = null;
  let unmeasured = false;
  if (outcome.cost) {
    try {
      writeJsonAtomic(roleRunFiles(root, jobId, agentId).cum, { v: SIDECAR_VERSION, cum: meterDelta(ZERO, outcome.cost).cum, at: now() }, { root: paths(root).dir });
    } catch {}
    const base = resumed ? baseline : ZERO;
    if (base) usage = deltaUsage(base, outcome.cost, sp.model, wallMs);
  }
  // A child that ran but sent no cost (a timeout, a kill, an exit before the result), or a resume with no baseline,
  // still spent tokens: its session transcript is the measure, and `unmeasured` when there is none.
  if (outcome.started && (!outcome.cost || (resumed && !baseline))) {
    const imported = importClaudeCodeTranscript(agentId, { since: importCursor(loadJob(root, jobId), agentId), root, job: loadJob(root, jobId), promptChars: rolePromptChars(sp.role) });
    usage = imported ? { ...imported, durationMs: imported.durationMs || wallMs } : null;
    unmeasured = !imported;
  }

  // 15. The end, fenced by epoch: a session that took the job over meanwhile keeps it, and the run log stays.
  const reason = failure ? redactKnown(failure.reason, known).replace(/\s+/g, ' ').trim() : '';
  // The reply's first line is model output, the likeliest place for a known secret to appear: redacted before Forge stores it.
  const summary = failure ? `${failure.class}: ${reason}` : outcome.summary ? redactKnown(outcome.summary, known) : undefined;
  let ended: ReturnType<typeof endAgent>;
  try {
    ended = endAgent(root, config, jobId, { role: sp.role, model: usage?.model ?? undefined, status: failure ? 'failed' : 'done', summary, agentId, usage, unmeasured, env, fence: { epoch: epoch ?? job.lease.epoch } });
  } catch (e) {
    if (e instanceof ForgeError && e.code === 'stale_epoch') throw new ForgeError(`${e.message}; the role's end was not recorded, and its run log is kept at ${log}`, 'stale_epoch');
    throw e;
  }
  const data = {
    id: jobId,
    role: sp.role,
    rule: sp.rule,
    agentId,
    resumed,
    ...(resumeFailed ? { resumeFailed: true } : {}),
    status: failure ? ('failed' as const) : ('done' as const),
    summary: summary ?? null,
    failure: failure ? { class: failure.class, reason, resetsAt: failure.resetsAt === null ? null : new Date(failure.resetsAt).toISOString() } : null,
    denied: outcome.denied,
    wallMs,
    log,
    usage: ended.usage ? { tokens: ended.usage.tokens, exact: ended.usage.exact } : null,
    ...(ended.unmeasured ? { unmeasured: true } : {}),
    jobTokens: ended.jobTokens,
    jobCostUsd: ended.jobCostUsd,
    ...(ended.outputMissing !== undefined ? { outputMissing: ended.outputMissing } : {}),
    ...(ended.secrets ? { secrets: ended.secrets } : {}),
    ...(ended.budget ? { budget: ended.budget } : {}),
  };
  return { data, exitCode: failure ? (EXTERNAL.has(failure.class) ? 5 : 1) : 0 };
}
