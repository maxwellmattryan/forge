// Job state and its event log: load, update and list jobs, and the job lease (claim, renew, expire,
// the epoch fence). The CLI writes state only through here.
import fs from 'node:fs';
import path from 'node:path';
import { paths, exists, jobDir } from '../paths.ts';
import { currentActor } from '#integrations/github/actor.ts';
import { clearFocusIf } from './focus.ts';
import { knownRecordValues, redactDeep } from '#engine/guard/known-secrets.ts';
import { EFFORTS, STAGES, STATES, WAITING_ON, SEVERITIES, EVENT_SCHEMA_VERSION, cleanIssues, endFinishedJobAgents, finishedJobRoles, noLease, normalizeEvent, normalizeJob, serializeJob } from './schema.ts';
import { idPrefix } from './issue-ref.ts';
import { localRepoSlug } from '#integrations/git/repo-slug.ts';
import type { AgentUsage, Config, Effort, EventActor, ForgeRequest, Job, JobAgent, JobIssue, JobChange, JobLease, JobEvent, JobState, LoadedJob, OwnerStatus, PostJobEffortResponse, Progress, Stage, TransitionSide, UsageBucket, Verdict, WaitingOn } from '../types.ts';
import { estimateCost } from '#integrations/claude/pricing.ts';
import { reviewFileName } from './lens.ts';
import { requeueOrphans } from './requests.ts';
import { runTransitionHooks } from './transitions.ts';
import { configForJob } from '#engine/evals/overlay.ts';
import { configHash, pluginHash, promptHash } from '#engine/evals/provenance.ts';
import { checkJobFields, checkOwnedFields } from './fields.ts';
import { setPath } from '../shape.ts';
import { ForgeError } from '../errors.ts';
import { readJson, readText, writeJsonAtomic } from '../os/fs.ts';
import { withLock } from '../os/lock.ts';
import { assertSafeRef, slugify } from '../text.ts';
import { now, shortId } from '../utils.ts';

/** How long a claim or the driver's own activity keeps a lease live. */
export const LEASE_MS = 30 * 60 * 1000;
/**
 * How long `forge job agent start` keeps it live: a long builder makes no CLI writes of its own
 * driver's, and this is the ceiling, so a crashed session can't hold a job forever.
 */
export const AGENT_LEASE_MS = 2 * 60 * 60 * 1000;

/** A fenced write: refused (stale_epoch) unless the lease is still at `epoch` and, with `session`, still that driver's. */
export interface Fence {
  epoch: number;
  session?: string;
}

// jobDir lives in paths.ts, a leaf, so low modules can use it without loading this one; most of lib/
// still imports it from here, which loads nothing extra.
export { jobDir } from '../paths.ts';

/** request.md without the `# title` line createJob writes, trimmed and uncapped; callers cap it. */
export function requestBody(root: string, id: string): string {
  return readText(path.join(jobDir(root, id), 'request.md')).replace(/^\s*# [^\n]*\n?/, '').trim();
}

export function loadJob(root: string, id: string): LoadedJob {
  const file = path.join(jobDir(root, id), 'job.json');
  if (!exists(file)) throw new ForgeError(`no job "${id}" (looked in ${path.dirname(file)})`, 'not_found');
  const job = normalizeJob(readJson(file));
  if (job._unsupported) throw new ForgeError(`job ${id} was written by a newer Forge; update the plugin`);
  return job;
}

/**
 * All job.json writes go through here: locked, atomic, timestamped. It never renews the lease (see
 * renewLease): a write by sync, another session or the dashboard says nothing about whether the
 * driver is still alive. With `fence`, the epoch check runs inside the same lock, before `mutate`,
 * so a stale driver's write never lands.
 */
export function updateJob(root: string, id: string, mutate: (job: LoadedJob) => void, fence?: Fence): LoadedJob {
  const dir = jobDir(root, id);
  return withLock(path.join(dir, '.lock'), () => {
    const job = loadJob(root, id);
    if (fence) assertEpoch(job, fence.epoch, fence.session);
    mutate(job);
    job.updatedAt = now();
    writeJsonAtomic(path.join(dir, 'job.json'), serializeJob(job));
    return job;
  });
}

/**
 * Refuses a write on behalf of a driver that was taken over: the lease moved past `epoch`, or (with
 * `session`) another session drives it now. Exit 3, code stale_epoch.
 */
export function assertEpoch(job: Pick<Job, 'id' | 'lease'>, epoch: number, session?: string): void {
  const l = job.lease;
  if (l.epoch === epoch && (session === undefined || l.driver === session)) return;
  throw new ForgeError(`job ${job.id} was taken over (lease epoch ${l.epoch}, you hold ${epoch}); stop driving it`, 'stale_epoch');
}

/** assertEpoch under the job lock, for a fenced command whose first write is not job.json's. */
export function checkFence(root: string, id: string, fence: Fence): void {
  withLock(path.join(jobDir(root, id), '.lock'), () => assertEpoch(loadJob(root, id), fence.epoch, fence.session));
}

/** The later of an ISO time and a ms time, as ISO; an unreadable ISO loses. */
const later = (iso: string | null, ms: number): string => {
  const t = iso ? Date.parse(iso) : NaN;
  return new Date(Number.isFinite(t) && t > ms ? t : ms).toISOString();
};

/**
 * The driver's own activity extends its lease to at least `ttl` from now. With `session`, only
 * while that session is the driver, even past expiry (nobody took over); without it (the worktree
 * commands and agent records, which carry no session), only a live lease, so an orphan agent can't
 * revive a dead driver's. Anything else writes nothing. Returns whether it renewed.
 */
export function renewLease(root: string, id: string, opts: { session?: string; ttl?: number; fence?: Fence } = {}): boolean {
  const skip = new Error('not renewed');
  try {
    updateJob(
      root,
      id,
      (j) => {
        const l = j.lease;
        // Thrown rather than returned, so a foreign renewal leaves job.json byte-identical.
        if (!l.driver) throw skip;
        if (opts.session !== undefined ? l.driver !== opts.session : leaseStatus(j).status !== 'live') throw skip;
        const t = Date.now();
        l.renewedAt = new Date(t).toISOString();
        l.expiresAt = later(l.expiresAt, t + (opts.ttl ?? LEASE_MS));
      },
      opts.fence,
    );
  } catch (e) {
    if (e === skip) return false;
    throw e;
  }
  return true;
}

/**
 * Ends the lease of a driver whose process is gone (a pool session's child exited): expiresAt
 * becomes now, the driver and epoch stay, so the driver itself may still renew if it comes back and
 * anyone else may claim. Only when the driver is one of `ids`. Returns the driver it expired, or null.
 */
export function expireLease(root: string, id: string, ids: readonly string[], reason: string): string | null {
  const skip = new Error('not expired');
  let session: string | null = null;
  try {
    updateJob(root, id, (j) => {
      const l = j.lease;
      if (!l.driver || !ids.includes(l.driver) || leaseStatus(j).status !== 'live') throw skip;
      session = l.driver;
      l.expiresAt = now();
    });
  } catch (e) {
    if (e === skip) return null;
    throw e;
  }
  logEvent(root, id, 'lease-expired', { session, reason });
  return session;
}

/** requeueOrphans with leases read from job.json and its notes logged on each request's job. */
export function requeueOrphanedRequests(
  root: string,
  opts: { at?: number; exited?: readonly string[]; busy?: readonly string[]; byAge?: boolean } = {},
): { requeued: ForgeRequest[]; rejected: ForgeRequest[] } {
  return requeueOrphans(root, {
    ...opts,
    leaseOf: (id) => {
      try {
        return loadJob(root, id).lease;
      } catch {
        return null;
      }
    },
    note: (id, text) => {
      try {
        logEvent(root, id, 'note', { text });
      } catch {
        // The job went away since the request was written; the request file still says what happened.
      }
    },
  });
}

/**
 * Whether a job's lease still holds, by its own expiry alone: `live` with a driver whose expiresAt
 * is ahead of `at`, `expired` with one whose is not, `none` without. claimJob refuses only `live`.
 */
export function leaseStatus(job: Pick<Job, 'lease'>, at = Date.now()): OwnerStatus {
  const l = job.lease ?? noLease();
  const base = { since: l.since, renewedAt: l.renewedAt, expiresAt: l.expiresAt, epoch: l.epoch, jobSession: false };
  if (!l.driver) return { status: 'none', session: null, ...base };
  const exp = l.expiresAt ? Date.parse(l.expiresAt) : NaN;
  return { status: Number.isFinite(exp) && exp > at ? 'live' : 'expired', session: l.driver, ...base };
}

export function logEvent(root: string, id: string, type: string, data: Record<string, any> = {}): void {
  // The job's recorded secret values never land in events.jsonl, which the dashboard and bundles read.
  const clean = redactDeep(data, knownRecordValues(root, id));
  const line = JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: now(), type, ...clean });
  fs.appendFileSync(path.join(jobDir(root, id), 'events.jsonl'), line + '\n');
}

/** The repo-level audit log: human actions with no job, such as `forge config set`. Gitignored with runtime/. */
export const repoAuditFile = (root: string): string => path.join(paths(root).runtime, 'audit.jsonl');

/** Appends one event-shaped line to the repo-level audit log. */
export function logRepoEvent(root: string, type: string, data: Record<string, any> = {}): void {
  const file = repoAuditFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: now(), type, ...data }) + '\n');
}

/**
 * A human action's event: logEvent plus who did it. The actor defaults to this process's
 * (lib/integrations/github/actor.ts), resolved only now, so paths that write no human event never call gh or git.
 */
export function logHumanEvent(root: string, id: string, type: string, data: Record<string, any> = {}, actor: EventActor = currentActor(root)): void {
  logEvent(root, id, type, { ...data, actor });
}

/** Parses JSONL event lines into the current event shape, dropping lines that are not events. */
export function parseEventLines(text: string): JobEvent[] {
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return normalizeEvent(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter((e): e is JobEvent => e !== null);
}

export function readEvents(root: string, id: string): JobEvent[] {
  return parseEventLines(readText(path.join(jobDir(root, id), 'events.jsonl')));
}

/**
 * Whether an event was the foreman's. Accepts the raw legacy string too, so an unmigrated event
 * passed in memory can never count as a person's decision (protected paths, stats, retro).
 */
export const isForemanActor = (e: { actor?: unknown } | null | undefined): boolean => {
  const a = e?.actor as { source?: unknown } | string | undefined;
  return a === 'foreman' || (typeof a === 'object' && a !== null && a.source === 'foreman');
};

const isEffort = (v: unknown): v is Effort => (EFFORTS as readonly unknown[]).includes(v);
const effortError = (v: unknown) => `unknown effort ${JSON.stringify(v)} (${EFFORTS.join(', ')})`;

export function createJob(
  root: string,
  config: Config,
  opts: { title: string; issues?: JobIssue[]; body?: string; parent?: string; branch?: string; kind?: string; slug?: string; services?: string[]; origin?: string; splitMode?: 'never' | null; effort?: Effort | null },
): LoadedJob {
  if (!opts.title) throw new ForgeError('a job needs a title');
  if (opts.effort != null && !isEffort(opts.effort)) throw new ForgeError(effortError(opts.effort));
  // A PR's headRefName arrives here as --branch, and the branch later fills shell templates.
  if (opts.branch !== undefined) assertSafeRef(opts.branch, '--branch');
  const p = paths(root);
  fs.mkdirSync(p.jobs, { recursive: true });
  const slug = opts.slug ? slugify(opts.slug) : slugify(opts.title, 5);
  const issues = cleanIssues(opts.issues ?? []);
  // A foreign `owner/repo#12` must not take the `12-<slug>` id this repo's issue 12 would get.
  const primary = issues.find((i) => i.ref) ?? null;
  const baseId = idPrefix(primary, config.tracker.kind, primary ? localRepoSlug(root, config) : null, slug, slugify) ?? `${slug}-${shortId()}`;
  let id = baseId;
  for (let n = 2; ; n++) {
    try {
      fs.mkdirSync(p.job(id));
      break;
    } catch (e) {
      if ((e as any).code !== 'EEXIST') throw e;
      id = `${baseId}-${n}`;
    }
  }
  const job = normalizeJob({
    id,
    title: opts.title,
    kind: opts.kind ?? 'feature',
    issues,
    parent: opts.parent ?? null,
    services: opts.services ?? [],
    branch: opts.branch ?? `${config.git.branchPrefix}${id}`,
    base: config.git.base,
    maxRounds: config.pipeline.maxRounds,
    splitMode: opts.splitMode ?? null,
    effort: opts.effort ?? null,
    createdAt: now(),
    updatedAt: now(),
  });
  writeJsonAtomic(path.join(p.job(id), 'job.json'), serializeJob(job));
  fs.writeFileSync(path.join(p.job(id), 'request.md'), `# ${opts.title}\n\n${opts.body?.trim() ?? ''}\n`);
  logEvent(root, id, 'created', { title: opts.title, issues: job.issues, ...(opts.origin ? { origin: opts.origin } : {}), ...(job.effort ? { effort: job.effort } : {}) });
  if (opts.parent) {
    updateJob(root, opts.parent, (parent) => {
      if (!parent.children.includes(id)) parent.children.push(id);
    });
  }
  return job;
}

/**
 * Sets or (null) clears a job's reasoning effort: the one write path of `forge job effort` and
 * POST /api/jobs/:id/effort. Re-validated here because both callers pass outside text. A no-op
 * writes nothing and logs nothing. It never touches a running session: the daemon reads the new
 * level at that session's next spawn.
 */
export function setJobEffort(root: string, id: string, effort: Effort | null, from: 'cli' | 'dashboard'): PostJobEffortResponse {
  if (effort !== null && !isEffort(effort)) throw new ForgeError(effortError(effort));
  const unchanged = new Error('unchanged');
  let previous: Effort | null = null;
  let jobId = id;
  try {
    jobId = updateJob(root, id, (j) => {
      previous = j.effort;
      // Thrown rather than returned, so a no-op leaves job.json byte-identical.
      if (previous === effort) throw unchanged;
      j.effort = effort;
    }).id;
  } catch (e) {
    if (e === unchanged) return { id: jobId, effort, previous, changed: false };
    throw e;
  }
  logEvent(root, jobId, 'effort', { effort, previous, from });
  return { id: jobId, effort, previous, changed: true };
}

export function listJobs(root: string): LoadedJob[] {
  const dir = paths(root).jobs;
  if (!exists(dir)) return [];
  return (
    fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && exists(path.join(dir, d.name, 'job.json')))
      .map((d) => {
        try {
          return normalizeJob(readJson(path.join(dir, d.name, 'job.json')));
        } catch {
          return null;
        }
      })
      .filter(Boolean) as LoadedJob[]
  )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export function isActive(job: Job): boolean {
  return !['done', 'cancelled'].includes(job.state);
}

function checkChange(change: JobChange): void {
  if (change.stage && !STAGES.includes(change.stage as any))
    throw new ForgeError(`unknown stage "${change.stage}" (${STAGES.join(', ')})`, 'usage');
  if (change.state && !STATES.includes(change.state as any))
    throw new ForgeError(`unknown state "${change.state}" (${STATES.join(', ')})`, 'usage');
  if (change.waitingOn && !WAITING_ON.includes(change.waitingOn as any))
    throw new ForgeError(`unknown waiting-on "${change.waitingOn}" (${WAITING_ON.join(', ')})`, 'usage');
}

/**
 * `derive` decides part of the change from the job as stored at write time, inside the lock, so a
 * claim or edit that lands between a caller's load and its write is what the decision sees. Its
 * result is merged over the static change; null applies the static change alone.
 */
export function setJob(
  root: string,
  id: string,
  change: JobChange & { release?: boolean; derive?: (j: LoadedJob) => JobChange | null; fence?: Fence },
): LoadedJob {
  checkChange(change);
  const { derive, release, fence, ...base } = change;
  let before: TransitionSide | null = null;
  let released = false;
  let lost: string[] = [];
  // The change actually applied: the static one, or derive's result merged over it.
  let c: JobChange = base;
  const job = updateJob(root, id, (j) => {
    before = { stage: j.stage, state: j.state, waitingOn: j.waitingOn };
    const derived = derive?.(j);
    if (derived) {
      const merged = { ...base, ...derived };
      // Before any mutation, so an invalid derived value leaves job.json untouched.
      checkChange(merged);
      c = merged;
    }
    // On the change actually applied and the kind read inside the lock, before any mutation, so a
    // refused field leaves job.json and events.jsonl untouched whoever called.
    checkJobFields(c.fields ?? {}, j);
    checkOwnedFields(c.owned ?? {});
    // stage, state and waitingOn were checked against their lists.
    if (c.stage) j.stage = c.stage as Stage;
    if (c.state) j.state = c.state as JobState;
    if (c.state && c.state !== 'waiting' && c.waitingOn === undefined) j.waitingOn = null;
    if (c.waitingOn !== undefined) j.waitingOn = c.waitingOn as WaitingOn | null;
    if (c.reason !== undefined) j.reason = c.reason;
    if (j.state === 'waiting' && !j.waitingOn) throw new ForgeError('state "waiting" needs --waiting-on', 'usage');
    for (const [k, v] of Object.entries(c.owned ?? {})) setPath(j, k, v);
    for (const [k, v] of Object.entries(c.fields ?? {})) setPath(j, k, v);
    if (['done', 'cancelled'].includes(j.state) && !j.finishedAt) j.finishedAt = now();
    // In the same write as the state, so no reader sees a finished job with an agent still running.
    const ended = endFinishedJobAgents(j.agents, j.state, now(), finishedJobRoles(j));
    j.agents = ended.agents;
    lost = ended.roles;
    // In the same locked write, so no session can claim between the change and the release.
    if (release && j.lease.driver) {
      const run = j.runs[j.runs.length - 1];
      if (run && !run.endedAt) run.endedAt = now();
      dropDriver(j);
      released = true;
    }
  }, fence);
  const b = before as any;
  if (b.stage !== job.stage || b.state !== job.state || b.waitingOn !== job.waitingOn) {
    const to = { stage: job.stage, state: job.state, waitingOn: job.waitingOn };
    logEvent(root, id, 'transition', { from: b, to, reason: c.reason ?? undefined });
    // Once per state change: a repeated set with the same state and waitingOn logs no transition.
    runTransitionHooks(root, job, b, to);
  }
  for (const role of lost) {
    const a = job.agents[role];
    logEvent(root, id, 'agent-end', { role, model: a?.model ?? undefined, status: a?.status, summary: a?.summary });
  }
  const written = { ...c.owned, ...c.fields };
  if (Object.keys(written).length) logEvent(root, id, 'fields', { fields: written });
  if (c.note) logEvent(root, id, 'note', { text: c.note });
  if (released) logEvent(root, id, 'released');
  // A finished job lets go of focus. No actor: whatever finished it, this is not a human's focus action.
  if (b.state !== job.state && !isActive(job) && clearFocusIf(root, job.id)) logEvent(root, job.id, 'unfocus', { reason: 'finished' });
  return job;
}

export interface ClaimOpts {
  /** Set only for a human's `--force` takeover, which the `claimed` event then records. */
  actor?: EventActor;
  fence?: Fence;
}

/** Nobody drives the job; the epoch stays, so it only ever grows. */
function dropDriver(j: Job): void {
  j.lease = { ...j.lease, driver: null, expiresAt: null };
}

/**
 * One driver per job: a live lease held by another session refuses (exit 3) unless `force`; none,
 * an expired one or the caller's own is taken. A change of driver starts a new epoch, which fences
 * every later write of the one replaced; a re-claim keeps it.
 */
export function claimJob(root: string, id: string, session: string, force = false, opts: ClaimOpts = {}): LoadedJob {
  let took: { from: string; why: string } | null = null;
  const job = updateJob(
    root,
    id,
    (j) => {
      const l = j.lease;
      const { status } = leaseStatus(j);
      if (l.driver && l.driver !== session && status === 'live' && !force)
        throw new ForgeError(`job ${id} is being driven by session ${l.driver} (lease renewed ${l.renewedAt ?? 'never'}, expires ${l.expiresAt}); pass --force to take over`, 'owned');
      const t = Date.now();
      if (l.driver !== session) {
        if (l.driver) took = { from: l.driver, why: status === 'live' ? 'forced' : 'lease expired' };
        l.driver = session;
        l.epoch += 1;
        l.since = new Date(t).toISOString();
        j.runs.push({ session, startedAt: now() });
      }
      l.renewedAt = new Date(t).toISOString();
      l.expiresAt = later(l.expiresAt, t + LEASE_MS);
    },
    opts.fence,
  );
  logEvent(root, id, 'claimed', { session, epoch: job.lease.epoch, ...(opts.actor ? { actor: opts.actor } : {}) });
  const y = took as { from: string; why: string } | null;
  if (y) logEvent(root, id, 'note', { text: `took over from session ${y.from} (${y.why})` });
  return job;
}

/** Drops the driver; with `onlyIf`, only when it approves the lease (checked inside the lock). Returns whether it did. */
export function releaseJob(root: string, id: string, onlyIf?: (lease: JobLease) => boolean): boolean {
  const keep = new Error('lease kept');
  try {
    updateJob(root, id, (j) => {
      // Thrown rather than returned, so a kept claim leaves job.json untouched.
      if (onlyIf && !onlyIf(j.lease)) throw keep;
      const run = j.runs[j.runs.length - 1];
      if (run && !run.endedAt) run.endedAt = now();
      dropDriver(j);
    });
  } catch (e) {
    if (e === keep) return false;
    throw e;
  }
  logEvent(root, id, 'released');
  return true;
}

/**
 * What an agent start ran on: the plugin, the role's prompt as the roster hashes it, and the repo
 * layer with the job's effective config. `forge stats --by prompt` groups jobs by these.
 */
function startProvenance(root: string, config: Config, job: Job, role: string): Pick<JobEvent, 'pluginHash' | 'promptHash' | 'configHash'> {
  // Best-effort, each on its own: a hash that throws is null, and never fails the agent start.
  const tryHash = (fn: () => string | null): string | null => {
    try {
      return fn();
    } catch {
      return null;
    }
  };
  return {
    pluginHash: tryHash(() => pluginHash()),
    promptHash: tryHash(() => promptHash(root, config, role)),
    configHash: tryHash(() => configHash(root, configForJob(root, config, job))),
  };
}

export function recordAgent(
  root: string,
  id: string,
  rec: {
    role: string;
    phase: 'start' | 'end';
    model?: string;
    agentId?: string;
    status?: string;
    summary?: string;
    usage?: AgentUsage;
    importedThrough?: string | null;
    /** start: the job-dir-relative output (resolveAgentOutput). */
    output?: string | null;
    /** start: this run is the one retry. */
    retry?: boolean;
    /** end: the output check's result, when an output is known. */
    outputMissing?: boolean;
  },
  config: Config,
  fence?: Fence,
): LoadedJob {
  const job = updateJob(root, id, (j) => {
    const a = (j.agents[rec.role] ??= { runs: 0 });
    if (rec.phase === 'start') {
      a.status = 'running';
      a.model = rec.model ?? a.model ?? null;
      a.agentId = rec.agentId ?? null;
      a.startedAt = now();
      a.endedAt = null;
      a.round = j.round;
      a.runs += 1;
      a.output = rec.output ?? null;
      a.retry = Boolean(rec.retry);
      delete a.outputMissing;
    } else {
      a.endedAt = a.status === 'running' ? now() : (a.endedAt ?? null); // only a run in flight ends: a second end must not re-open the decision record
      a.status = rec.status ?? 'done';
      if (rec.agentId) a.agentId = rec.agentId;
      if (rec.model) a.model = rec.model;
      if (rec.summary) a.summary = rec.summary.slice(0, 280);
      if (rec.usage) addUsage(j, rec.role, a.model, rec.usage, config);
      if (rec.agentId && rec.importedThrough) (a.importedThrough ??= {})[rec.agentId] = rec.importedThrough;
      if (rec.outputMissing !== undefined) a.outputMissing = rec.outputMissing;
    }
  }, fence);
  logEvent(root, id, `agent-${rec.phase}`, {
    role: rec.role,
    model: rec.model ?? job.agents[rec.role]?.model,
    agentId: rec.agentId,
    status: rec.status,
    summary: rec.summary,
    usage: rec.usage,
    ...(rec.phase === 'start' ? { output: rec.output ?? undefined, retry: rec.retry || undefined, ...startProvenance(root, config, job, rec.role) } : {}),
    ...(rec.outputMissing !== undefined ? { outputMissing: rec.outputMissing } : {}),
  });
  return job;
}

/**
 * Records the runtime's agent id on a role that is running (`forge job agent <id> attach`), so its
 * transcript can be followed while it runs. Leaves runs, startedAt and status alone and logs no
 * event: the id is bookkeeping, not a pipeline step. The caller validates the id.
 */
export function attachAgent(root: string, id: string, role: string, agentId: string): LoadedJob {
  return updateJob(root, id, (j) => {
    const a = Object.hasOwn(j.agents, role) ? j.agents[role] : undefined;
    if (a?.status !== 'running') throw new ForgeError(`agent ${role} is not running on ${id}`, 1);
    a.agentId = agentId;
  });
}

/**
 * Ends each role still marked running with status `lost`, as `forge job agent <id> end --role
 * <role> --status lost` would, minus the transcript import and budget check: a lost agent carries
 * no usage. Each role is re-read first, so one another writer ended meanwhile keeps its status, and
 * with `drivers` (every id of the session that drove it), so is one whose job another session has
 * claimed since. Returns the roles it ended.
 */
export function markAgentsLost(root: string, id: string, roles: string[], summary: string, config: Config, drivers?: readonly string[]): string[] {
  const ended: string[] = [];
  for (const role of roles) {
    const job = loadJob(root, id);
    if (drivers !== undefined && !(job.lease.driver && drivers.includes(job.lease.driver))) break;
    const a = job.agents[role];
    if (a?.status !== 'running') continue;
    const outputMissing = agentOutputMissing(root, id, role, a, undefined);
    recordAgent(root, id, { role, phase: 'end', status: 'lost', summary, ...(outputMissing !== null ? { outputMissing } : {}) }, config);
    ended.push(role);
  }
  return ended;
}

/**
 * Resolves `agent start --output` against the job dir and refuses anything that lands outside
 * it, including through a symlinked parent, so the flag can neither create directories nor probe
 * files elsewhere. Returns the job-dir-relative path.
 */
export function resolveAgentOutput(root: string, id: string, value: string): string {
  const dir = jobDir(root, id);
  const abs = path.resolve(dir, value);
  const realDir = fs.realpathSync(dir);
  const refuse = () => new ForgeError(`--output must be inside the job dir ${dir}, got "${value}"`);
  // The nearest existing ancestor decides where the path really goes; the rest is created later.
  // lstat, so a dangling symlink counts as existing and is resolved (and refused), never skipped.
  const present = (p: string) => {
    try {
      fs.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };
  let existing = abs;
  while (!present(existing) && path.dirname(existing) !== existing) existing = path.dirname(existing);
  let resolved: string;
  try {
    resolved = fs.realpathSync(existing);
  } catch {
    throw refuse();
  }
  const rel = path.relative(realDir, path.join(resolved, path.relative(existing, abs)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw refuse();
  return rel;
}

/** The output a role writes when its start recorded none: the single-output roles only. */
export function defaultAgentOutput(role: string, round: number | undefined): string | null {
  if (role.startsWith('reviewer:')) return path.join('review', `round-${round ?? 0}`, reviewFileName(role.slice('reviewer:'.length)));
  if (role === 'approver') return 'decision.md';
  if (role === 'spec-writer') return 'spec.md';
  if (role === 'verifier') return path.join('verify', `round-${round ?? 0}-verifier-answers.md`);
  return null;
}

/** Roles that may answer NEEDS-INPUT with questions.md instead of their output. */
const ASKING_ROLES = ['spec-writer', 'planner', 'integrator'];

/**
 * Whether the agent ending now wrote its output: the file exists and was written after the run
 * started (with 2s of slack for coarse mtimes), so a stale file from an earlier run doesn't count.
 * Null when the role has no known output.
 */
export function agentOutputMissing(root: string, id: string, role: string, a: JobAgent | undefined, summary: string | undefined): boolean | null {
  const rel = a?.output ?? defaultAgentOutput(role, a?.round);
  if (!rel) return null;
  const dir = jobDir(root, id);
  if (ASKING_ROLES.includes(role) && summary && /\bNEEDS-INPUT\b/i.test(summary) && exists(path.join(dir, 'questions.md'))) return false;
  let mtime: number;
  try {
    mtime = fs.statSync(path.join(dir, rel)).mtimeMs;
  } catch {
    return true;
  }
  const started = a?.startedAt ? Date.parse(a.startedAt) : NaN;
  return Number.isFinite(started) ? mtime < started - 2000 : false;
}

/** Where the next `--import` of this agent's transcript starts: the latest cursor any role recorded for it. */
export function importCursor(job: Job, agentId: string): string | null {
  let latest: string | null = null;
  for (const a of Object.values(job.agents)) {
    const ts = a.importedThrough?.[agentId];
    if (ts && (!latest || Date.parse(ts) > Date.parse(latest))) latest = ts;
  }
  return latest;
}

export function addUsage(job: Job, role: string, model: string | null | undefined, u: AgentUsage, config: Config): void {
  const total = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  const cost = estimateCost({ ...u, totalTokens: total, model }, config?.usage?.pricing);
  const bump = (bucket: Record<string, UsageBucket>, key: string) => {
    const b = (bucket[key] ??= { tokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, toolUses: 0, durationMs: 0, runs: 0, estCostUsd: 0 });
    b.tokens += total;
    b.input += u.input ?? 0;
    b.output += u.output ?? 0;
    b.cacheRead += u.cacheRead ?? 0;
    b.cacheWrite += u.cacheWrite ?? 0;
    b.toolUses += u.toolUses ?? 0;
    b.durationMs += u.durationMs ?? 0;
    b.runs += 1;
    b.estCostUsd = round4(b.estCostUsd + cost.usd);
  };
  const baseRole = role.split(':')[0];
  bump(job.usage.byRole, baseRole === 'reviewer' ? role : baseRole);
  bump(job.usage.byModel, cost.model ?? model ?? 'unknown');
  job.usage.totalTokens += total;
  job.usage.estCostUsd = round4(job.usage.estCostUsd + cost.usd);
  job.usage.exact = Boolean(job.usage.exact || u.exact);
}

const round4 = (n: number): number => Math.round(n * 10000) / 10000;

export function progress(root: string, id: string): Progress {
  const text = readText(path.join(jobDir(root, id), 'tasks.md'));
  const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  const open = (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length;
  return { done, total: done + open };
}

export function parseReview(text: string): { declared: string | null; counts: Record<string, number> } {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = first.match(/^\s*VERDICT:\s*(PASS|CHANGES)\b/i);
  const counts: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of text.matchAll(/^\s*[-*]\s*\[(blocker|major|minor|nit)\]/gim)) counts[f[1].toLowerCase()]++;
  return { declared: m ? m[1].toUpperCase() : null, counts };
}

/**
 * One review-format file's verdict under `blockOn`: the counting roundVerdicts applies to a lens's
 * review, and verifiersRecord (lib/engine/pipeline/verifiers.ts) to the verifiers report, so both block alike.
 */
export function fileVerdict(
  text: string,
  blockOn: string[],
  opts: { malformedAs?: 'changes' } = {},
): { verdict: Verdict; declared: string | null; counts: Record<string, number>; blocking: number; coerced: boolean } {
  const { declared, counts } = parseReview(text);
  const blocking = blockOn.reduce((n, s) => n + (counts[s] ?? 0), 0);
  let verdict: Verdict = blocking > 0 ? 'CHANGES' : 'PASS';
  let coerced = false;
  if (!declared && blocking === 0) {
    verdict = opts.malformedAs === 'changes' ? 'CHANGES' : 'MALFORMED';
    coerced = verdict === 'CHANGES';
  } else if (declared === 'CHANGES' && blocking === 0 && Object.values(counts).every((c) => c === 0)) verdict = 'CHANGES';
  return { verdict, declared, counts, blocking, coerced };
}

/**
 * The tagged findings decide the verdict, so a reviewer that writes PASS above a blocker
 * (or CHANGES over nothing but nits) cannot silently override the repo's blockOn policy.
 * A review with no verdict line is MALFORMED unless its tagged findings already force a
 * round; `malformedAs: 'changes'` counts the rest as CHANGES so a reviewer that fails the
 * format twice cannot stall the job.
 * `round: 'integration'` reads the post-integration mini review in `review/integration/`.
 * A missing file is MISSING once that lens's reviewer has ended for this review (the agent
 * claimed success but never wrote it), and PENDING while it has not, so the orchestrator
 * re-spawns a reviewer that lost its output instead of waiting on it forever.
 */
export function roundVerdicts(
  root: string,
  id: string,
  round: number | 'integration',
  reviewers: string[],
  blockOn: string[],
  opts: { malformedAs?: 'changes' } = {},
): { round: number | 'integration'; complete: boolean; outcome: Verdict | 'PENDING' | 'MISSING'; reviewers: Record<string, any> } {
  const dir = reviewDir(root, id, round);
  const ended = reviewerEnded(root, id, round);
  const out: Record<string, any> = {};
  for (const r of reviewers) {
    const file = path.join(dir, reviewFileName(r));
    if (!exists(file)) {
      out[r] = ended(r) ? { verdict: 'MISSING', file: path.relative(jobDir(root, id), file), path: file } : { verdict: 'PENDING' };
      continue;
    }
    out[r] = { ...fileVerdict(readText(file), blockOn, opts), file: path.relative(jobDir(root, id), file) };
  }
  const values = Object.values(out).map((v) => v.verdict);
  const complete = !values.includes('PENDING') && !values.includes('MISSING');
  const outcome = values.includes('PENDING') ? 'PENDING' : values.includes('MISSING') ? 'MISSING' : values.includes('MALFORMED') ? 'MALFORMED' : values.includes('CHANGES') ? 'CHANGES' : 'PASS';
  return { round, complete, outcome, reviewers: out };
}

/** Where a round's review files go: `review/round-<n>/` or `review/integration/`. */
export function reviewDir(root: string, id: string, round: number | 'integration'): string {
  return path.join(jobDir(root, id), 'review', round === 'integration' ? 'integration' : `round-${round}`);
}

/**
 * Created up front because reviewers that write with a shell redirect fail on a missing
 * directory, and the orchestrator only learns of it from an absent file.
 */
export function ensureReviewDir(root: string, id: string, round: number | 'integration'): string {
  const dir = reviewDir(root, id, round);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Whether lens `r`'s reviewer started and ended for this review, read from `job.agents`
 * (`reviewer:<lens>`). A numbered round matches the round the agent started in; the
 * integration review has no number, so its reviewer must have started after the last
 * conflicted integration.
 */
function reviewerEnded(root: string, id: string, round: number | 'integration'): (r: string) => boolean {
  const job = loadJob(root, id);
  const since = round === 'integration' ? readEvents(root, id).findLast((e) => e.type === 'integrate-conflicts')?.ts : undefined;
  return (r) => {
    const a = job.agents[`reviewer:${r}`];
    if (!a?.endedAt || a.status === 'running' || !a.startedAt) return false;
    return round === 'integration' ? since !== undefined && a.startedAt >= since : a.round === round;
  };
}

export function parseDecision(root: string, id: string): { decision: string | null; reason: string | null; autoMerge: boolean } {
  const text = readText(path.join(jobDir(root, id), 'decision.md'));
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = first.match(/^\s*(APPROVE|ESCALATE)\b\s*[:\-–]?\s*(.*)$/i);
  return { ...(m ? { decision: m[1].toUpperCase(), reason: m[2].trim() || null } : { decision: null, reason: null }), autoMerge: /^yes\b/i.test(text.match(/^[ \t]*(?:[-*][ \t]*)?Auto-merge eligible:[ \t]*(.*)$/im)?.[1] ?? '') }; // the first such line only
}
