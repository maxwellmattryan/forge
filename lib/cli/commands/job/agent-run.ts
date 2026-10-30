// `forge job agent run`: one spawn `forge job step` chose, run as its own headless claude child in the job's
// worktree (lib/integrations/claude/role.ts), with Forge recording the agent's start, attach and end itself
// and its usage taken from the child's own result line. A spawn step gave a `resume` continues that session; any other
// review lens or rework build forks its round's context session (lib/engine/workspace/context-session.ts), or runs cold.
// docs/architecture/daemon-runtime.md "Role runs".
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
import { rolePrefix } from '#engine/guard/prompt-prefix.ts';
import { contextBrief, needsBrowser, withContextLine, withPrefixLine } from '#engine/pipeline/brief.ts';
import { agentTools } from '#engine/pipeline/roster.ts';
import {
  CONTEXT_TIMEOUT_MS,
  cacheMiss,
  contextFailed,
  contextKey,
  contextKind,
  forkBase,
  inputsChanged,
  resolveContext,
  touchContext,
  type ColdText,
  type ContextInput,
  type ContextLaunch,
  type ContextResolution,
} from '#engine/workspace/context-session.ts';
import { browserMcpConfig } from '#integrations/claude/browser.ts';
import { claudeAdapter } from '#integrations/claude/child.ts';
import { commandPermissionMode, parseTemplate, roleArgv, sessionEnv } from '#integrations/claude/argv.ts';
import { runRoleChild, type RoleFailure, type RoleOutcome, type RoleRun } from '#integrations/claude/role.ts';
import { briefLine } from '#integrations/claude/stream.ts';
import { TRUST_ENV, daemonProblems, loadConfig, trackerSymlinks, trustDigest } from '#core/config/load.ts';
import { assertEpoch, attachAgent, importCursor, leaseStatus, loadJob } from '#core/job/store.ts';
import { UUID, ensureRoleRunDir, openAppend, readInfo, roleRunFiles } from '#core/job/session-files.ts';
import { SCOPE_ENV, daemonScope } from '#core/job/requests.ts';
import { writeJsonAtomic } from '#core/os/fs.ts';
import { PLUGIN_ROOT, jobDir, paths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { now } from '#core/utils.ts';
import type { AgentUsage, Config, ContextMark, ContextSession, LoadedJob } from '#core/types.ts';
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
/** The outcome of a launch that never started a child. */
const notRun = (cls: RoleFailure['class'], reason: string): RoleOutcome => ({ ok: false, started: false, init: false, sessionId: null, summary: null, text: null, firstRequest: null, tools: [], dropped: 0, cost: null, context: null, failure: { class: cls, reason, resetsAt: null }, denied: 0, exit: null, wallMs: 0 });
const CHANGED = 'a file Forge trusts or protects in the main checkout changed during the run; a human reviews it';

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
  const input = loadStepInput(root, ctx.config, jobId);
  const sp = pickSpawn(step(input), index);
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
  // 8. The trusted prefix: the main checkout's instruction files, learnings and role notes as one system-prompt
  // file every lens, round and job with the same sources shares, so the prompt cache serves it. Its sources are
  // under the digest just taken, so step 15 catches one changed during the run. Any refusal runs as before.
  const pre = rolePrefix(root, config, sp.role, [confined.roots.jobs, ...confined.roots.worktrees]);
  let prefix = pre.file;
  let prefixRefused = pre.refused;
  let brief = sp.brief;
  if (prefix !== null) {
    const prefixed = withPrefixLine(sp.brief);
    if (prefixed === null) [prefix, prefixRefused] = [null, 'the brief has no Effort line'];
    else if (briefLine(prefixed) === null) [prefix, prefixRefused] = [null, 'the brief with the prefix line is over the brief cap'];
    else brief = prefixed;
  }
  // 9. The env. Outside a daemon session whoever runs the CLI is the trust anchor, as a human starting the pool is.
  // FORGE_ROOT is pinned, as the pool pins it for every session: an inherited one must not steer the child's `forge` calls elsewhere.
  const trusted = env.FORGE_DAEMON === '1' ? (env[TRUST_ENV] as string) : digest;
  const childEnv = { ...sessionEnv(env, config.daemon.auth), ...confined.env, FORGE_ROOT: root, [TRUST_ENV]: trusted, [SCOPE_ENV]: jobId };
  // 10. The command line, the prefix on every launch; a resume only of a session id, never of an in-process subagent's.
  // The agent's own tool list, built-ins only: MCP tools reach a child only through a server Forge declares.
  const role = sp.agent.startsWith('forge:') ? sp.agent.slice('forge:'.length) : sp.agent;
  const tools = agentTools(role);
  if (!tools?.length) throw new ForgeError(`cannot start a role child: agents/${role}.md has no tools: list`);
  const builtins = tools.filter((t) => !t.startsWith('mcp__'));
  // Forge's browser, only for a UI role of a spec with a UI AC and a job with a dev-server port: from an integer, Forge paths and
  // the child's own PATH. Null (no `npx` on its absolute PATH entries) runs the role without a browser.
  const mcpConfig =
    needsBrowser(sp, input.spec.uiAcs) && typeof job.port === 'number'
      ? browserMcpConfig({ root, port: job.port, outputDir: path.join(jobDir(root, jobId), 'screenshots'), env: childEnv })
      : null;
  const resumeId = typeof sp.resume === 'string' && UUID.test(sp.resume) ? sp.resume : null;
  // A context child and its forks take this same command line, so they are confined exactly as a cold run.
  const argvFor = (sessionId: string, resume: boolean, fork = false) =>
    roleArgv({
      executable: parseTemplate(config.daemon.command)[0],
      pluginRoot: PLUGIN_ROOT,
      agent: sp.agent,
      tools: builtins,
      model: sp.model,
      effort: sp.effort,
      permissionMode: commandPermissionMode(config.daemon.command),
      allowedTools: config.daemon.allowedTools,
      writeRoots: [confined.roots.jobs, ...confined.roots.worktrees],
      deny,
      session: { id: sessionId, resume },
      appendSystemPromptFile: prefix,
      mcpConfig,
      fork,
    });
  let sessionId = resumeId ?? crypto.randomUUID();
  let argv = argvFor(sessionId, resumeId !== null);
  const baseline = resumeId ? sidecarCum(roleRunFiles(root, jobId, resumeId).cum) : ZERO;

  // 11. The start, fenced: step must still hold this spawn under the job lock, so of two racing callers one starts.
  const check = (j: LoadedJob) => {
    const again = step(loadStepInput(root, ctx.config, jobId));
    const list = again.action === 'spawn' ? [again, ...(again.spawns ?? [])] : [];
    if (j.round !== sp.round || !list.some((s) => s.role === sp.role && s.round === sp.round)) throw staleStep(`${described(again)}, no longer the spawn of ${sp.role} in round ${sp.round}`);
  };
  startAgent(root, config, jobId, {
    role: sp.role,
    model: sp.model,
    output: sp.output,
    retry: sp.retry === true,
    resume: resumeId ?? undefined,
    resumeSkipped: sp.resumeSkipped,
    fence: { epoch: epoch ?? job.lease.epoch, session, check },
  });

  // 12. The run, with the runner's own interrupts passed to the child first, and to a wait on a context's lock.
  const known = knownValues(root, jobId, config);
  const timeoutMs = typeof config.daemon.turnTimeoutMinutes === 'number' && config.daemon.turnTimeoutMinutes > 0 ? config.daemon.turnTimeoutMinutes * 60_000 : null;
  let interrupted: NodeJS.Signals | null = null;
  let current: RoleRun | null = null;
  const abort = new AbortController();
  const onSignal = (sig: NodeJS.Signals) => {
    interrupted ??= sig;
    abort.abort();
    current?.stop(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  let log = '';
  let reported: string | null = null;
  let outcome: RoleOutcome;
  let resumeFailed = false;
  /** One child: the role's own (`attach`: its log is the run's, its init attaches the agent) or a context child's. */
  const launch = async (args: string[], logId: string, text: string, o: { attach: boolean; timeoutMs: number | null }): Promise<RoleOutcome> => {
    const files = roleRunFiles(root, jobId, logId);
    if (o.attach) log = files.log;
    let fd: number;
    try {
      ensureRoleRunDir(root, files);
      fd = openAppend(files.log);
    } catch (e) {
      return notRun('spawn', `the run log can't be opened: ${(e as Error).message}`);
    }
    try {
      if (interrupted) return notRun('interrupted', `the runner got ${interrupted}`);
      current = runRoleChild(claudeAdapter(), {
        argv: args,
        // The path that was checked, not job.worktree again: a link swapped since would move the cwd.
        cwd: wt,
        env: childEnv,
        brief: text,
        maxLineBytes: MAX_LINE_BYTES,
        timeoutMs: o.timeoutMs,
        onLine: (line) => {
          // A log write that fails (a full disk) must not take the runner down before the end is recorded.
          try {
            fs.writeSync(fd, redactKnown(line, known) + '\n');
          } catch {}
        },
        onSessionId: (sid) => {
          if (!o.attach || !UUID.test(sid)) return;
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
  /**
   * A child's usage from its result's own cumulative less `base` (the sidecar keeps the new cumulative). A child that ran
   * but sent no cost (a timeout, a kill, an exit before the result), or a resume with no baseline (`base` null), still spent
   * tokens: its session transcript is the measure, and `unmeasured` when there is none. The sidecar also names the session's
   * role (`context` for a context child) and its last context: what binds a session to its role for a later rework resume,
   * since the sidecar sits outside every write root and job.json's agentId does not.
   */
  const measure = (sid: string, sidecarRole: string, out: RoleOutcome, base: MeterCum | null, ms: number) => {
    let usage: (AgentUsage & { through?: string | null }) | null = null;
    let unmeasured = false;
    if (out.cost) {
      try {
        const rec = { v: SIDECAR_VERSION, cum: meterDelta(ZERO, out.cost).cum, at: now(), role: sidecarRole, ...(out.context !== null ? { context: out.context } : {}) };
        writeJsonAtomic(roleRunFiles(root, jobId, sid).cum, rec, { root: paths(root).dir });
      } catch {}
      if (base) usage = deltaUsage(base, out.cost, sp.model, ms);
    }
    if (out.started && (!out.cost || !base)) {
      const j = loadJob(root, jobId);
      const imported = importClaudeCodeTranscript(sid, { since: importCursor(j, sid), root, job: j, promptChars: rolePromptChars(sp.role) });
      usage = imported ? { ...imported, durationMs: imported.durationMs || ms } : null;
      unmeasured = !imported;
    }
    return { usage, unmeasured };
  };
  /** Whether a trusted or protected file moved since the start: the child changed it, whatever it was told. */
  const trustMoved = () => trustDigest(root) !== digest || confineDigest(root, config) !== confineBefore;
  /** Set when the context child moved one: the role then starts nothing and fails `untrusted`. */
  let contextUntrusted = false;
  /**
   * A context child: the spawn's own argv with a fresh session id, the fixed context brief, its own timeout, never attached.
   * It is ready only on a bare `READY` after nothing but Reads: its own turns stay in every fork of it, so a child that
   * called another tool (an input steered it to write or run something), had a call denied, sent a stream line Forge could
   * not read (one could have held a tool call), or moved a trusted or protected file is failed, however it then replied,
   * and its record is never forked.
   */
  let ctxLog = '';
  const launchContext = async (inputs: ContextInput[]): Promise<ContextLaunch> => {
    const id = crypto.randomUUID();
    ctxLog = roleRunFiles(root, jobId, id).log;
    const [startedAt, c0] = [now(), Date.now()];
    const out = await launch(argvFor(id, false), id, contextBrief(job, wt, sp.agent, inputs.map((i) => i.path)), { attach: false, timeoutMs: CONTEXT_TIMEOUT_MS });
    contextUntrusted = trustMoved();
    const readOnly = out.denied === 0 && out.dropped === 0 && out.tools.every((t) => t === 'Read');
    const ready = out.ok && !contextUntrusted && readOnly && out.text?.trim() === 'READY';
    const m = measure(id, 'context', out, ZERO, Date.now() - c0);
    const fr = out.firstRequest;
    const reason = ready ? null : out.failure ? out.failure.class : contextUntrusted ? 'untrusted' : 'not ready';
    return { id, status: ready ? 'ready' : 'failed', reason, startPrefix: fr ? fr.input + fr.cacheRead + fr.cacheWrite : null, usage: m.usage, unmeasured: m.unmeasured, startedAt, endedAt: now() };
  };
  const cold = (reason: ColdText, ctxId: string | null = null): ContextMark => ({ mode: 'cold', session: ctxId, reason, firstRead: null });
  const coldBrief = brief;
  let mark: ContextMark | null = null;
  /** The context the final launch forked, null for a cold one. */
  let fork: ContextSession | null = null;
  let t0 = Date.now();
  try {
    // 13. A review lens or rework build forks its round's context session, found or started under the key's lock; a resume never does (contextKind).
    if (contextKind(root, job, sp)) {
      let res: ContextResolution | null = null;
      if (flags.cold === true) mark = cold('cold flag');
      else {
        try {
          res = await resolveContext(root, config, jobId, contextKey(sp, prefix), { launch: launchContext, fence: { epoch: epoch ?? job.lease.epoch }, signal: abort.signal });
        } catch (e) {
          if (e instanceof ForgeError && e.code === 'stale_epoch') throw new ForgeError(`${e.message}; the context session was not recorded, and its run log is kept at ${ctxLog}`, 'stale_epoch');
          // Interrupted while waiting: the launch below fails `interrupted` with nothing started. Any other failure of the
          // find-or-start (a lock dir that can't be made, a record that can't be written) must not strand the role `running`
          // with no agent-end: a context session only saves cost, so the role runs cold.
          if (!interrupted) mark = cold(contextFailed(null));
        }
      }
      if (res?.mode === 'cold') mark = cold(res.reason, res.session);
      else if (res?.mode === 'fork') {
        const f = res.rec;
        const forked = withContextLine(brief, f.id, f.inputs.map((i) => i.path), inputsChanged(jobDir(root, jobId), f.inputs));
        if (forked === null || briefLine(forked) === null) mark = cold('brief over the cap', f.id);
        else {
          [fork, brief, mark] = [f, forked, { mode: 'fork', session: f.id, reason: null, firstRead: null }];
          // The fork's own id is known only at its init: the log takes a fresh one.
          sessionId = crypto.randomUUID();
          argv = argvFor(f.id, true, true);
          touchContext(root, jobId, f.id, now());
        }
      }
    }
    t0 = Date.now();
    // A context child that moved a trusted or protected file: the role does not start on top of it.
    outcome = contextUntrusted ? notRun('untrusted', CHANGED) : await launch(argv, sessionId, brief, { attach: true, timeoutMs });
    const preInit = () => !outcome.init && !interrupted && outcome.failure !== null && ['error', 'exit'].includes(outcome.failure.class);
    // 14. A resume that never reached claude's init found no conversation, nor did a fork: once more, as a fresh session.
    if ((resumeId !== null || fork) && preInit()) {
      if (fork) [mark, fork, brief] = [cold('fork failed', fork.id), null, coldBrief];
      else resumeFailed = true;
      sessionId = crypto.randomUUID();
      argv = argvFor(sessionId, false);
      reported = null;
      outcome = await launch(argv, sessionId, brief, { attach: true, timeoutMs });
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const wallMs = Date.now() - t0;
  const agentId: string = reported ?? sessionId;
  if (mark) {
    const firstRead = outcome.firstRequest?.cacheRead ?? null;
    // A fork whose first request read no more than the context's own first request missed the cache: logged cold, not repeated.
    mark = fork && cacheMiss(firstRead, fork.startPrefix) === true ? { ...cold('cache miss', fork.id), firstRead } : { ...mark, firstRead };
  }
  // 15. Whatever the child did, a trusted or protected file it changed fails the run, as it stops a session's turn.
  let failure: RoleFailure | null = outcome.failure;
  if (trustMoved()) failure = { class: 'untrusted', reason: CHANGED, resetsAt: null };

  // 16. Usage less the baseline its session had: a resume's sidecar, or for a fork the context's cumulative its result carried over.
  const resumed = resumeId !== null && !resumeFailed;
  const base = resumed ? baseline : fork && outcome.cost ? forkBase(sidecarCum(roleRunFiles(root, jobId, fork.id).cum), outcome.cost) : ZERO;
  const { usage, unmeasured } = measure(agentId, sp.role, outcome, base, wallMs);

  // 17. The end, fenced by epoch: a session that took the job over meanwhile keeps it, and the run log stays.
  const reason = failure ? redactKnown(failure.reason, known).replace(/\s+/g, ' ').trim() : '';
  // The reply's first line is model output, the likeliest place for a known secret to appear: redacted before Forge stores it.
  const summary = failure ? `${failure.class}: ${reason}` : outcome.summary ? redactKnown(outcome.summary, known) : undefined;
  let ended: ReturnType<typeof endAgent>;
  try {
    ended = endAgent(root, config, jobId, { role: sp.role, model: usage?.model ?? undefined, status: failure ? 'failed' : 'done', summary, agentId, usage, unmeasured, context: mark ?? undefined, resumeFailed, env, fence: { epoch: epoch ?? job.lease.epoch } });
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
    ...(sp.resumeSkipped ? { resumeSkipped: sp.resumeSkipped } : {}),
    status: failure ? ('failed' as const) : ('done' as const),
    summary: summary ?? null,
    failure: failure ? { class: failure.class, reason, resetsAt: failure.resetsAt === null ? null : new Date(failure.resetsAt).toISOString() } : null,
    denied: outcome.denied,
    wallMs,
    log,
    prefix,
    ...(prefixRefused ? { prefixRefused } : {}),
    context: mark,
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
