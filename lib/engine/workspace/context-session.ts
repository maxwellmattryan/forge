// Context sessions: one headless child per round and key reads the round's shared inputs once, so each review lens and
// rework build of that round forks it with them already in context. Which spawns use one, the key, the inputs, the
// records and the fork's usage baseline; the child itself is launched by the caller (`forge job agent run`).
// docs/architecture/daemon-runtime.md "Context sessions".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { addUsage, jobDir, loadJob, logEvent, updateJob } from '#core/job/store.ts';
import { readRegular } from '#core/os/fs.ts';
import { withLockAsync } from '#core/os/lock.ts';
import { paths } from '#core/paths.ts';
import { ForgeError } from '#core/errors.ts';
import { UUID } from '#core/job/session-files.ts';
import type { AgentUsage, Config, ContextSession, Fence, Job } from '#core/types.ts';
import type { SessionCost } from '#integrations/claude/types.ts';
import type { MeterCum } from '../metrics/meter.ts';
import type { StepSpawn } from '../pipeline/types.ts';

/** A context last read longer ago than this is past the prompt cache's hour, less a margin: a new one starts. */
export const CONTEXT_WARM_MS = 50 * 60_000;
/** A context child still without a result after this long fails as `timeout`. */
export const CONTEXT_TIMEOUT_MS = 10 * 60_000;
/** How long a run waits for its key's lock: one context child's timeout and a margin. */
export const CONTEXT_LOCK_MS = 11 * 60_000;
export const CONTEXT_INPUT_MAX_BYTES = 256 * 1024;
export const CONTEXT_INPUTS_MAX_BYTES = 384 * 1024;
export const CONTEXTS_KEPT = 20;
/**
 * The fixed cold reasons; a failed context adds `context failed: <failure class | not ready>` (contextFailed). `not ready`
 * is any reply but `READY`, a tool call other than Read and a denied call; the class `untrusted` is a moved trusted file.
 */
export const COLD_REASONS = ['cold flag', 'no inputs', 'context busy', 'brief over the cap', 'fork failed', 'cache miss'] as const;
export type ColdReason = (typeof COLD_REASONS)[number];
export const contextFailed = (reason: string | null): string => `context failed: ${reason ?? 'error'}`;

const ZERO: MeterCum = { usd: 0, models: {} };
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** What a context's key binds: a fork keeps the context's system prompt and thinking, so all of these must match. */
export interface ContextKey {
  round: number;
  agent: string;
  model: string;
  effort: string | null;
  prefix: string | null;
}

/** One kept input: its path as the brief names it, and the sha256 of what was read. */
export interface ContextInput {
  path: string;
  sha256: string;
}

const isRegular = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Whether a spawn uses a context session: a review (`reviewer:<lens>` on an `RV*` rule, never the integration
 * reviews), or a rework build (`builder` once the job's `build.md` is a regular file); never a resume of a session id.
 */
export function contextKind(root: string, job: Pick<Job, 'id'>, sp: Pick<StepSpawn, 'role' | 'rule' | 'resume'>): 'review' | 'rework' | null {
  if (typeof sp.resume === 'string' && UUID.test(sp.resume)) return null;
  if (sp.role.startsWith('reviewer:') && sp.rule.startsWith('RV')) return 'review';
  if (sp.role === 'builder' && isRegular(path.join(jobDir(root, job.id), 'build.md'))) return 'rework';
  return null;
}

export function contextKey(sp: Pick<StepSpawn, 'round' | 'agent' | 'model' | 'effort'>, prefix: string | null): ContextKey {
  return { round: sp.round, agent: sp.agent, model: sp.model || 'inherit', effort: sp.effort ?? null, prefix: prefix ?? null };
}

const sameKey = (c: ContextSession, k: ContextKey): boolean => c.round === k.round && c.agent === k.agent && c.model === k.model && c.effort === k.effort && c.prefix === k.prefix;

/** The input list, in order: the first existing path of each group, relative to the job dir. */
function candidates(round: number): string[][] {
  const r = [round, round - 1];
  return [['spec.md'], ['design.md'], ['build.md'], r.map((n) => `verify/round-${n}.md`), r.map((n) => `verify/round-${n}-verifiers.md`), ['scope.md'], r.map((n) => `review/round-${n}/diff.patch`)];
}

const exists = (p: string): boolean => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * One input's bytes, or null when it is unusable: its parent's realpath must be its own path under the job dir's
 * realpath (no linked directory on the way), and readRegular must read it (no link, no FIFO, never blocking).
 */
function readInput(realDir: string, dir: string, rel: string): Buffer | null {
  const abs = path.join(dir, rel);
  try {
    if (fs.realpathSync.native(path.dirname(abs)) !== path.join(realDir, path.dirname(rel))) return null;
  } catch {
    return null;
  }
  const b = readRegular(abs, CONTEXT_INPUT_MAX_BYTES);
  return typeof b === 'string' ? null : b;
}

const sha256 = (b: Buffer | string): string => crypto.createHash('sha256').update(b).digest('hex');

/** The round's shared inputs a context reads, each usable one with its sha256, within CONTEXT_INPUTS_MAX_BYTES in total. */
export function contextInputs(root: string, job: Pick<Job, 'id' | 'round'>): ContextInput[] {
  const dir = jobDir(root, job.id);
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(dir);
  } catch {
    return [];
  }
  const out: ContextInput[] = [];
  let total = 0;
  for (const group of candidates(job.round)) {
    const rel = group.find((p) => exists(path.join(dir, p)));
    if (!rel) continue;
    const b = readInput(realDir, dir, rel);
    if (!b || total + b.length > CONTEXT_INPUTS_MAX_BYTES) continue;
    total += b.length;
    out.push({ path: path.join(dir, rel), sha256: sha256(b) });
  }
  return out;
}

/** The recorded inputs whose sha256 moved since the context read them, or which are now missing or unusable. */
export function inputsChanged(dir: string, inputs: readonly ContextInput[]): string[] {
  let realDir: string;
  try {
    realDir = fs.realpathSync.native(dir);
  } catch {
    return inputs.map((i) => i.path);
  }
  return inputs
    .filter((i) => {
      const rel = path.relative(dir, i.path);
      if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return true;
      const b = readInput(realDir, dir, rel);
      return !b || sha256(b) !== i.sha256;
    })
    .map((i) => i.path);
}

/** The newest record with `key` last read within CONTEXT_WARM_MS of `nowMs`, ready or failed; null when there is none. */
export function matchingContext(job: Pick<Job, 'contexts'>, key: ContextKey, nowMs: number): ContextSession | null {
  const list = Array.isArray(job.contexts) ? job.contexts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    const at = Date.parse(c.lastReadAt);
    if (sameKey(c, key) && Number.isFinite(at) && nowMs - at <= CONTEXT_WARM_MS) return c;
  }
  return null;
}

/**
 * The baseline a fork's usage is measured against: the context's cumulative when the fork's result carries it (at or
 * above it on usd and on every token field of every model it holds), else zero, so the whole fork counts.
 */
export function forkBase(ctx: MeterCum | null, fork: SessionCost): MeterCum {
  if (!ctx) return ZERO;
  const usd = round6(fork.usd ?? Object.values(fork.models).reduce((n, m) => n + m.usd, 0));
  if (usd < ctx.usd) return ZERO;
  for (const [name, m] of Object.entries(ctx.models)) {
    const f = Object.hasOwn(fork.models, name) ? fork.models[name] : null;
    if (!f || TOKEN_FIELDS.some((k) => f[k] < m[k])) return ZERO;
  }
  return ctx;
}

/** Whether a fork missed the cache: its first request read no more than the context's own first request held; null without both. */
export function cacheMiss(firstRead: number | null, startPrefix: number | null): boolean | null {
  if (firstRead === null || startPrefix === null) return null;
  return firstRead <= startPrefix;
}

/** Records a context (the same id replaced, else appended, the newest CONTEXTS_KEPT kept), its usage under role `context`, and its event. */
export function recordContext(root: string, config: Config, jobId: string, rec: ContextSession, usage: AgentUsage | null, fence?: Fence): void {
  const model = usage?.model ?? rec.model;
  updateJob(
    root,
    jobId,
    (j) => {
      const list = Array.isArray(j.contexts) ? [...j.contexts] : [];
      const at = list.findIndex((c) => c.id === rec.id);
      if (at >= 0) list[at] = rec;
      else list.push(rec);
      j.contexts = list.slice(-CONTEXTS_KEPT);
      if (usage) addUsage(j, 'context', model, usage, config);
    },
    fence,
  );
  logEvent(root, jobId, 'context-session', { role: 'context', session: rec.id, round: rec.round, agent: rec.agent, model, status: rec.status, reason: rec.reason, usage, ...(rec.unmeasured ? { unmeasured: true } : {}) });
}

/** A fork's launch: the context's lastReadAt moves to `at`, nothing else, and no event. */
export function touchContext(root: string, jobId: string, id: string, at: string): void {
  updateJob(root, jobId, (j) => {
    const c = (j.contexts ?? []).find((x) => x.id === id);
    if (c) c.lastReadAt = at;
  });
}

/** The lock one key's find-or-start runs under: `.forge/locks/context/<jobId>-<first 16 hex of sha256(key)>`. */
export function contextLockDir(root: string, jobId: string, key: ContextKey): string {
  const digest = sha256(JSON.stringify([key.round, key.agent, key.model, key.effort, key.prefix])).slice(0, 16);
  return path.join(paths(root).locks, 'context', `${jobId}-${digest}`);
}

/**
 * `fn` under the key's lock. `busy` when the lock wasn't had within `timeoutMs`; an aborted `signal` stops the
 * wait and throws, holding nothing. An error from `fn` itself propagates.
 */
export async function withContextLock<T>(root: string, jobId: string, key: ContextKey, fn: () => Promise<T>, signal?: AbortSignal, timeoutMs = CONTEXT_LOCK_MS): Promise<{ value: T } | { busy: true }> {
  let entered = false;
  try {
    const value = await withLockAsync(
      contextLockDir(root, jobId, key),
      () => {
        entered = true;
        return fn();
      },
      { timeoutMs, signal },
    );
    return { value };
  } catch (e) {
    if (!entered && !signal?.aborted && e instanceof ForgeError) return { busy: true };
    throw e;
  }
}

/** What the caller's launch of one context child gives back. */
export interface ContextLaunch {
  id: string;
  status: 'ready' | 'failed';
  reason: string | null;
  startPrefix: number | null;
  usage: AgentUsage | null;
  unmeasured: boolean;
  startedAt: string;
  endedAt: string;
}

/** A role run's context: fork `rec`, or run cold for `reason` (with the context's id when one was involved). */
export type ContextResolution = { mode: 'fork'; rec: ContextSession } | { mode: 'cold'; reason: string; session: string | null };

/**
 * Find or start the context for `key`, under its lock: a warm ready record is forked; a warm failed one sends the run
 * cold with its reason, so a failing context costs one start per key and round; otherwise a new context child starts
 * through `launch` (unless no input is usable) and is recorded before the lock is released, so concurrent runs with
 * the key start exactly one. Throws when `signal` aborts the wait, or when recording hits a stale epoch.
 */
export async function resolveContext(
  root: string,
  config: Config,
  jobId: string,
  key: ContextKey,
  o: { launch: (inputs: ContextInput[]) => Promise<ContextLaunch>; fence?: Fence; signal?: AbortSignal; lockTimeoutMs?: number },
): Promise<ContextResolution> {
  const got = await withContextLock(
    root,
    jobId,
    key,
    async (): Promise<ContextResolution> => {
      const job = loadJob(root, jobId);
      const found = matchingContext(job, key, Date.now());
      if (found?.status === 'ready') return { mode: 'fork', rec: found };
      if (found) return { mode: 'cold', reason: contextFailed(found.reason), session: found.id };
      const inputs = contextInputs(root, job);
      if (!inputs.length) return { mode: 'cold', reason: 'no inputs', session: null };
      const r = await o.launch(inputs);
      const rec: ContextSession = {
        id: r.id,
        round: key.round,
        agent: key.agent,
        model: key.model,
        effort: key.effort,
        prefix: key.prefix,
        status: r.status,
        reason: r.status === 'ready' ? null : r.reason,
        inputs,
        startedAt: r.startedAt,
        endedAt: r.endedAt,
        lastReadAt: r.endedAt,
        startPrefix: r.startPrefix,
        usage: r.usage ? { tokens: r.usage.totalTokens ?? 0, input: r.usage.input ?? 0, output: r.usage.output ?? 0, cacheRead: r.usage.cacheRead ?? 0, cacheWrite: r.usage.cacheWrite ?? 0 } : null,
        ...(r.unmeasured ? { unmeasured: true as const } : {}),
      };
      recordContext(root, config, jobId, rec, r.usage, o.fence);
      return rec.status === 'ready' ? { mode: 'fork', rec } : { mode: 'cold', reason: contextFailed(rec.reason), session: rec.id };
    },
    o.signal,
    o.lockTimeoutMs,
  );
  return 'busy' in got ? { mode: 'cold', reason: 'context busy', session: null } : got.value;
}
