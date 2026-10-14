import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, exists } from './paths.ts';
import { STAGES, STATES, WAITING_ON, SEVERITIES, EVENT_SCHEMA_VERSION, normalizeJob, serializeJob } from './schema.ts';
import type { AgentUsage, Config, Job, JobAgent, JobEvent, JobState, LoadedJob, Progress, Stage, TransitionSide, UsageBucket, Verdict, WaitingOn } from './types.ts';
import { estimateCost } from './usage.ts';
import { ForgeError, now, readJson, readText, setPath, slugify, shortId, withLock, writeJsonAtomic } from './util.ts';

/** A session that has not touched its job for this long is presumed dead and can be taken over. */
const OWNER_STALE_MS = 30 * 60 * 1000;
/**
 * An agent still marked running keeps its session's claim alive this long after it started,
 * so a long builder with no CLI writes is not mistaken for a dead session. The ceiling keeps a
 * crashed session from holding a job forever.
 */
const RUNNING_AGENT_MAX_MS = 2 * 60 * 60 * 1000;

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
  if (!exists(file)) throw new ForgeError(`no job "${id}" (looked in ${path.dirname(file)})`);
  const job = normalizeJob(readJson(file));
  if (job._unsupported) throw new ForgeError(`job ${id} was written by a newer Forge; update the plugin`);
  return job;
}

/**
 * All job.json writes go through here: locked, atomic, timestamped, heartbeat-refreshing.
 */
export function updateJob(root: string, id: string, mutate: (job: LoadedJob) => void): LoadedJob {
  const dir = jobDir(root, id);
  return withLock(path.join(dir, '.lock'), () => {
    const job = loadJob(root, id);
    mutate(job);
    job.updatedAt = now();
    if (job.owner) job.owner.heartbeat = job.updatedAt;
    writeJsonAtomic(path.join(dir, 'job.json'), serializeJob(job));
    return job;
  });
}

/** Refreshes the owner heartbeat without changing anything else. */
export function touchJob(root: string, id: string): LoadedJob {
  return updateJob(root, id, () => {});
}

export function logEvent(root: string, id: string, type: string, data: Record<string, any> = {}): void {
  const line = JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: now(), type, ...data });
  fs.appendFileSync(path.join(jobDir(root, id), 'events.jsonl'), line + '\n');
}

export function readEvents(root: string, id: string): JobEvent[] {
  return readText(path.join(jobDir(root, id), 'events.jsonl'))
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function createJob(
  root: string,
  config: Config,
  opts: { title: string; ref?: string; url?: string; tracker?: string; body?: string; parent?: string; branch?: string; kind?: string; slug?: string; services?: string[]; origin?: string },
): LoadedJob {
  if (!opts.title) throw new ForgeError('a job needs a title');
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
    createdAt: now(),
    updatedAt: now(),
  });
  writeJsonAtomic(path.join(p.job(id), 'job.json'), serializeJob(job));
  fs.writeFileSync(path.join(p.job(id), 'request.md'), `# ${opts.title}\n\n${opts.body?.trim() ?? ''}\n`);
  logEvent(root, id, 'created', { title: opts.title, source: job.source, ...(opts.origin ? { origin: opts.origin } : {}) });
  if (opts.parent) {
    updateJob(root, opts.parent, (parent) => {
      if (!parent.children.includes(id)) parent.children.push(id);
    });
  }
  return job;
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

export function setJob(
  root: string,
  id: string,
  change: { stage?: string; state?: string; waitingOn?: string | null; reason?: string | null; fields?: Record<string, any>; note?: string },
): LoadedJob {
  if (change.stage && !STAGES.includes(change.stage as any))
    throw new ForgeError(`unknown stage "${change.stage}" (${STAGES.join(', ')})`);
  if (change.state && !STATES.includes(change.state as any))
    throw new ForgeError(`unknown state "${change.state}" (${STATES.join(', ')})`);
  if (change.waitingOn && !WAITING_ON.includes(change.waitingOn as any))
    throw new ForgeError(`unknown waiting-on "${change.waitingOn}" (${WAITING_ON.join(', ')})`);
  let before: TransitionSide | null = null;
  const job = updateJob(root, id, (j) => {
    before = { stage: j.stage, state: j.state, waitingOn: j.waitingOn };
    // stage, state and waitingOn were checked against their lists above.
    if (change.stage) j.stage = change.stage as Stage;
    if (change.state) j.state = change.state as JobState;
    if (change.state && change.state !== 'waiting' && change.waitingOn === undefined) j.waitingOn = null;
    if (change.waitingOn !== undefined) j.waitingOn = change.waitingOn as WaitingOn | null;
    if (change.reason !== undefined) j.reason = change.reason;
    if (j.state === 'waiting' && !j.waitingOn) throw new ForgeError('state "waiting" needs --waiting-on');
    for (const [k, v] of Object.entries(change.fields ?? {})) setPath(j, k, v);
    if (['done', 'cancelled'].includes(j.state) && !j.finishedAt) j.finishedAt = now();
  });
  const b = before as any;
  if (b.stage !== job.stage || b.state !== job.state || b.waitingOn !== job.waitingOn)
    logEvent(root, id, 'transition', { from: b, to: { stage: job.stage, state: job.state, waitingOn: job.waitingOn }, reason: change.reason ?? undefined });
  if (change.fields && Object.keys(change.fields).length) logEvent(root, id, 'fields', { fields: change.fields });
  if (change.note) logEvent(root, id, 'note', { text: change.note });
  return job;
}

/**
 * Prevents two sessions from driving the same job at once while letting a new session
 * take over a job whose previous session died.
 */
export function claimJob(root: string, id: string, session: string, force = false): LoadedJob {
  const job = updateJob(root, id, (j) => {
    const o = j.owner;
    const heartbeatFresh = o && Date.now() - Date.parse(o.heartbeat ?? o.since) < OWNER_STALE_MS;
    const agentRunning = Object.values(j.agents).some((a: JobAgent) => a.status === 'running' && a.startedAt && Date.now() - Date.parse(a.startedAt) < RUNNING_AGENT_MAX_MS);
    if (o && o.session !== session && (heartbeatFresh || agentRunning) && !force)
      throw new ForgeError(`job ${id} is being driven by session ${o.session} (${agentRunning ? 'an agent is still running' : `last active ${o.heartbeat}`}); pass --force to take over`, 3);
    j.owner = { session, host: os.hostname(), since: o?.session === session ? o.since : now(), heartbeat: now() };
    if (!o || o.session !== session) j.runs.push({ session, startedAt: now() });
  });
  logEvent(root, id, 'claimed', { session });
  return job;
}

export function releaseJob(root: string, id: string): void {
  updateJob(root, id, (j) => {
    const run = j.runs[j.runs.length - 1];
    if (run && !run.endedAt) run.endedAt = now();
    j.owner = null;
  });
  logEvent(root, id, 'released');
}

export function recordAgent(
  root: string,
  id: string,
  rec: { role: string; phase: 'start' | 'end'; model?: string; agentId?: string; status?: string; summary?: string; usage?: AgentUsage; importedThrough?: string | null },
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
    } else {
      a.status = rec.status ?? 'done';
      a.endedAt = now();
      if (rec.agentId) a.agentId = rec.agentId;
      if (rec.model) a.model = rec.model;
      if (rec.summary) a.summary = rec.summary.slice(0, 280);
      if (rec.usage) addUsage(j, rec.role, a.model, rec.usage, config);
      if (rec.agentId && rec.importedThrough) (a.importedThrough ??= {})[rec.agentId] = rec.importedThrough;
    }
  });
  logEvent(root, id, `agent-${rec.phase}`, {
    role: rec.role,
    model: rec.model ?? job.agents[rec.role]?.model,
    agentId: rec.agentId,
    status: rec.status,
    summary: rec.summary,
    usage: rec.usage,
  });
  return job;
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
