import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, exists } from './paths.ts';
import { currentActor } from './actor.ts';
import { EFFORTS, STAGES, STATES, WAITING_ON, SEVERITIES, EVENT_SCHEMA_VERSION, normalizeEvent, normalizeJob, serializeJob } from './schema.ts';
import type { AgentUsage, Config, Effort, EventActor, Job, JobAgent, JobChange, JobOwner, JobEvent, JobState, LoadedJob, OwnerStatus, PostJobEffortResponse, Progress, Stage, TransitionSide, UsageBucket, Verdict, WaitingOn } from './types.ts';
import { estimateCost } from './usage.ts';
import { ForgeError, assertSafeRef, now, readJson, readText, setPath, slugify, shortId, withLock, writeJsonAtomic } from './util.ts';

/** A session that has not touched its job for this long is presumed dead and can be taken over. */
const OWNER_STALE_MS = 30 * 60 * 1000;
/**
 * An agent still marked running keeps its session's claim alive this long after it started,
 * so a long builder with no CLI writes is not mistaken for a dead session. The ceiling keeps a
 * crashed session from holding a job forever.
 */
export const RUNNING_AGENT_MAX_MS = 2 * 60 * 60 * 1000;

export function jobDir(root: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new ForgeError(`invalid job id "${id}"`);
  return paths(root).job(id);
}

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
 * All job.json writes go through here: locked, atomic, timestamped. It never refreshes the
 * owner's heartbeat (see touchJob): a write by sync, another session or the dashboard says
 * nothing about whether the owner is still alive.
 */
export function updateJob(root: string, id: string, mutate: (job: LoadedJob) => void): LoadedJob {
  const dir = jobDir(root, id);
  return withLock(path.join(dir, '.lock'), () => {
    const job = loadJob(root, id);
    mutate(job);
    job.updatedAt = now();
    writeJsonAtomic(path.join(dir, 'job.json'), serializeJob(job));
    return job;
  });
}

/**
 * The owner's own activity: refreshes its heartbeat. With `session`, only when that session is
 * the owner; anyone else writes nothing. Without it, refreshes whoever owns the job (the worktree
 * commands, which only the driving session's agents run). Returns whether it refreshed.
 */
export function touchJob(root: string, id: string, session?: string): boolean {
  const skip = new Error('not the owner');
  try {
    updateJob(root, id, (j) => {
      // Thrown rather than returned, so a foreign touch leaves job.json byte-identical.
      if (!j.owner || (session !== undefined && j.owner.session !== session)) throw skip;
      j.owner.heartbeat = now();
    });
  } catch (e) {
    if (e === skip) return false;
    throw e;
  }
  return true;
}

/**
 * Whether the owner still counts as driving the job, by time alone: its heartbeat is under
 * OWNER_STALE_MS old, or an agent has been marked running for under RUNNING_AGENT_MAX_MS.
 * claimJob refuses a `live` owner; lib/daemon-owner.ts adds the `dead` proofs.
 */
export function ownerStatus(job: Pick<Job, 'owner' | 'agents'>, at = Date.now()): OwnerStatus {
  const o = job.owner;
  if (!o) return { status: 'none', session: null, since: null, heartbeat: null, agentRunning: false, reason: null, jobSession: false };
  const heartbeatFresh = at - Date.parse(o.heartbeat ?? o.since) < OWNER_STALE_MS;
  const agentRunning = Object.values(job.agents ?? {}).some((a: JobAgent) => a.status === 'running' && Boolean(a.startedAt) && at - Date.parse(a.startedAt!) < RUNNING_AGENT_MAX_MS);
  return { status: heartbeatFresh || agentRunning ? 'live' : 'stale', session: o.session, since: o.since ?? null, heartbeat: o.heartbeat ?? null, agentRunning, reason: null, jobSession: false };
}

export function logEvent(root: string, id: string, type: string, data: Record<string, any> = {}): void {
  const line = JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: now(), type, ...data });
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
 * (lib/actor.ts), resolved only now, so paths that write no human event never call gh or git.
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
  opts: { title: string; ref?: string; url?: string; tracker?: string; body?: string; parent?: string; branch?: string; kind?: string; slug?: string; services?: string[]; origin?: string; splitMode?: 'never' | null; effort?: Effort | null },
): LoadedJob {
  if (!opts.title) throw new ForgeError('a job needs a title');
  if (opts.effort != null && !isEffort(opts.effort)) throw new ForgeError(effortError(opts.effort));
  // A PR's headRefName arrives here as --branch, and the branch later fills shell templates.
  if (opts.branch !== undefined) assertSafeRef(opts.branch, '--branch');
  const p = paths(root);
  fs.mkdirSync(p.jobs, { recursive: true });
  const slug = opts.slug ? slugify(opts.slug) : slugify(opts.title, 5);
  const ref = opts.ref ? String(opts.ref) : null;
  const baseId = !ref ? `${slug}-${shortId()}` : /^\d+$/.test(ref) ? `${ref}-${slug}` : slugify(ref, 8);
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
    source: opts.ref || opts.url ? { tracker: opts.tracker ?? config.tracker.kind, ref: opts.ref ?? null, url: opts.url ?? null } : null,
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
  logEvent(root, id, 'created', { title: opts.title, source: job.source, ...(opts.origin ? { origin: opts.origin } : {}), ...(job.effort ? { effort: job.effort } : {}) });
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
  change: JobChange & { release?: boolean; derive?: (j: LoadedJob) => JobChange | null },
): LoadedJob {
  checkChange(change);
  const { derive, release, ...base } = change;
  let before: TransitionSide | null = null;
  let released = false;
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
    // stage, state and waitingOn were checked against their lists.
    if (c.stage) j.stage = c.stage as Stage;
    if (c.state) j.state = c.state as JobState;
    if (c.state && c.state !== 'waiting' && c.waitingOn === undefined) j.waitingOn = null;
    if (c.waitingOn !== undefined) j.waitingOn = c.waitingOn as WaitingOn | null;
    if (c.reason !== undefined) j.reason = c.reason;
    if (j.state === 'waiting' && !j.waitingOn) throw new ForgeError('state "waiting" needs --waiting-on', 'usage');
    for (const [k, v] of Object.entries(c.fields ?? {})) setPath(j, k, v);
    if (['done', 'cancelled'].includes(j.state) && !j.finishedAt) j.finishedAt = now();
    // In the same locked write, so no session can claim between the change and the release.
    if (release && j.owner) {
      const run = j.runs[j.runs.length - 1];
      if (run && !run.endedAt) run.endedAt = now();
      j.owner = null;
      released = true;
    }
  });
  const b = before as any;
  if (b.stage !== job.stage || b.state !== job.state || b.waitingOn !== job.waitingOn)
    logEvent(root, id, 'transition', { from: b, to: { stage: job.stage, state: job.state, waitingOn: job.waitingOn }, reason: c.reason ?? undefined });
  if (c.fields && Object.keys(c.fields).length) logEvent(root, id, 'fields', { fields: c.fields });
  if (c.note) logEvent(root, id, 'note', { text: c.note });
  if (released) logEvent(root, id, 'released');
  return job;
}

/** How claimJob learns that a live-looking owner has let go (lib/daemon-owner.ts): a reason, or null. */
export interface ClaimOpts {
  yields?: (owner: JobOwner) => string | null;
  /** Set only for a human's `--force` takeover, which the `claimed` event then records. */
  actor?: EventActor;
}

/**
 * Prevents two sessions from driving the same job at once while letting a new session
 * take over a job whose previous session died, or whose owner `opts.yields` proves has let go.
 */
export function claimJob(root: string, id: string, session: string, force = false, opts: ClaimOpts = {}): LoadedJob {
  let yielded: { from: string; reason: string } | null = null;
  const job = updateJob(root, id, (j) => {
    const o = j.owner;
    const { status, agentRunning } = ownerStatus(j);
    if (o && o.session !== session && status === 'live' && !force) {
      // Asked inside the lock, so the owner it judges is the one being replaced.
      const reason = opts.yields?.(o) ?? null;
      if (!reason) throw new ForgeError(`job ${id} is being driven by session ${o.session} (${agentRunning ? 'an agent is still running' : `last active ${o.heartbeat}`}); pass --force to take over`, 3);
      yielded = { from: o.session, reason };
    }
    j.owner = { session, host: os.hostname(), since: o?.session === session ? o.since : now(), heartbeat: now() };
    if (!o || o.session !== session) j.runs.push({ session, startedAt: now() });
  });
  logEvent(root, id, 'claimed', { session, ...(opts.actor ? { actor: opts.actor } : {}) });
  const y = yielded as { from: string; reason: string } | null;
  if (y) logEvent(root, id, 'note', { text: `took over from session ${y.from}: ${y.reason}` });
  return job;
}

/** Clears the owner; with `onlyIf`, only when it approves the owner (checked inside the lock). Returns whether it did. */
export function releaseJob(root: string, id: string, onlyIf?: (owner: JobOwner | null) => boolean): boolean {
  const keep = new Error('owner kept');
  try {
    updateJob(root, id, (j) => {
      // Thrown rather than returned, so a kept claim leaves job.json untouched.
      if (onlyIf && !onlyIf(j.owner)) throw keep;
      const run = j.runs[j.runs.length - 1];
      if (run && !run.endedAt) run.endedAt = now();
      j.owner = null;
    });
  } catch (e) {
    if (e === keep) return false;
    throw e;
  }
  logEvent(root, id, 'released');
  return true;
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
      a.status = rec.status ?? 'done';
      a.endedAt = now();
      if (rec.agentId) a.agentId = rec.agentId;
      if (rec.model) a.model = rec.model;
      if (rec.summary) a.summary = rec.summary.slice(0, 280);
      if (rec.usage) addUsage(j, rec.role, a.model, rec.usage, config);
      if (rec.agentId && rec.importedThrough) (a.importedThrough ??= {})[rec.agentId] = rec.importedThrough;
      if (rec.outputMissing !== undefined) a.outputMissing = rec.outputMissing;
    }
  });
  logEvent(root, id, `agent-${rec.phase}`, {
    role: rec.role,
    model: rec.model ?? job.agents[rec.role]?.model,
    agentId: rec.agentId,
    status: rec.status,
    summary: rec.summary,
    usage: rec.usage,
    ...(rec.phase === 'start' ? { output: rec.output ?? undefined, retry: rec.retry || undefined } : {}),
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
 * with `owner`, so is one whose job another session has claimed since.
 * Returns the roles it ended.
 */
export function markAgentsLost(root: string, id: string, roles: string[], summary: string, config: Config, owner?: string): string[] {
  const ended: string[] = [];
  for (const role of roles) {
    const job = loadJob(root, id);
    if (owner !== undefined && job.owner?.session !== owner) break;
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
  if (role.startsWith('reviewer:')) return path.join('review', `round-${round ?? 0}`, `${role.slice('reviewer:'.length)}.md`);
  if (role === 'approver') return 'decision.md';
  if (role === 'spec-writer') return 'spec.md';
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
    const file = path.join(dir, `${r}.md`);
    if (!exists(file)) {
      out[r] = ended(r) ? { verdict: 'MISSING', file: path.relative(jobDir(root, id), file), path: file } : { verdict: 'PENDING' };
      continue;
    }
    const { declared, counts } = parseReview(readText(file));
    const blocking = blockOn.reduce((n, s) => n + (counts[s] ?? 0), 0);
    let verdict = blocking > 0 ? 'CHANGES' : 'PASS';
    let coerced = false;
    if (!declared && blocking === 0) {
      verdict = opts.malformedAs === 'changes' ? 'CHANGES' : 'MALFORMED';
      coerced = verdict === 'CHANGES';
    } else if (declared === 'CHANGES' && blocking === 0 && Object.values(counts).every((c) => c === 0)) verdict = 'CHANGES';
    out[r] = { verdict, declared, counts, blocking, coerced, file: path.relative(jobDir(root, id), file) };
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

export function parseDecision(root: string, id: string): { decision: string | null; reason: string | null } {
  const text = readText(path.join(jobDir(root, id), 'decision.md'));
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = first.match(/^\s*(APPROVE|ESCALATE)\b\s*[:\-–]?\s*(.*)$/i);
  return m ? { decision: m[1].toUpperCase(), reason: m[2].trim() || null } : { decision: null, reason: null };
}
