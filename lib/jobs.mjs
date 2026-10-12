// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths, exists } from './paths.mjs';
import { STAGES, STATES, WAITING_ON, SEVERITIES, EVENT_SCHEMA_VERSION, normalizeJob, serializeJob } from './schema.mjs';
import { estimateCost } from './usage.mjs';
import { ForgeError, now, readJson, readText, setPath, slugify, shortId, withLock, writeJsonAtomic } from './util.mjs';

/** A session that has not touched its job for this long is presumed dead and can be taken over. */
const OWNER_STALE_MS = 30 * 60 * 1000;

/** @param {string} root @param {string} id */
export function jobDir(root, id) {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new ForgeError(`invalid job id "${id}"`);
  return paths(root).job(id);
}

/** @param {string} root @param {string} id */
export function loadJob(root, id) {
  const file = path.join(jobDir(root, id), 'job.json');
  if (!exists(file)) throw new ForgeError(`no job "${id}" (looked in ${path.dirname(file)})`);
  const job = normalizeJob(readJson(file));
  if (job._unsupported) throw new ForgeError(`job ${id} was written by a newer Forge; update the plugin`);
  return job;
}

/**
 * All job.json writes go through here: locked, atomic, timestamped, heartbeat-refreshing.
 * @param {string} root @param {string} id @param {(job:any)=>void} mutate
 */
export function updateJob(root, id, mutate) {
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

/**
 * @param {string} root @param {string} id @param {string} type @param {Record<string, any>} [data]
 */
export function logEvent(root, id, type, data = {}) {
  const line = JSON.stringify({ v: EVENT_SCHEMA_VERSION, ts: now(), type, ...data });
  fs.appendFileSync(path.join(jobDir(root, id), 'events.jsonl'), line + '\n');
}

/** @param {string} root @param {string} id */
export function readEvents(root, id) {
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

/**
 * @param {string} root @param {any} config
 * @param {{title:string, ref?:string, url?:string, tracker?:string, body?:string, parent?:string, branch?:string, kind?:string, slug?:string, services?:string[]}} opts
 */
export function createJob(root, config, opts) {
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
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
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
  logEvent(root, id, 'created', { title: opts.title, source: job.source });
  if (opts.parent) {
    updateJob(root, opts.parent, (parent) => {
      if (!parent.children.includes(id)) parent.children.push(id);
    });
  }
  return job;
}

/** @param {string} root */
export function listJobs(root) {
  const dir = paths(root).jobs;
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && exists(path.join(dir, d.name, 'job.json')))
    .map((d) => {
      try {
        return normalizeJob(readJson(path.join(dir, d.name, 'job.json')));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

/** @param {any} job */
export function isActive(job) {
  return !['done', 'cancelled'].includes(job.state);
}

/**
 * @param {string} root @param {string} id
 * @param {{stage?:string, state?:string, waitingOn?:string|null, reason?:string|null, fields?:Record<string, any>, note?:string}} change
 */
export function setJob(root, id, change) {
  if (change.stage && !STAGES.includes(/** @type {any} */ (change.stage)))
    throw new ForgeError(`unknown stage "${change.stage}" (${STAGES.join(', ')})`);
  if (change.state && !STATES.includes(/** @type {any} */ (change.state)))
    throw new ForgeError(`unknown state "${change.state}" (${STATES.join(', ')})`);
  if (change.waitingOn && !WAITING_ON.includes(/** @type {any} */ (change.waitingOn)))
    throw new ForgeError(`unknown waiting-on "${change.waitingOn}" (${WAITING_ON.join(', ')})`);
  let before = null;
  const job = updateJob(root, id, (j) => {
    before = { stage: j.stage, state: j.state, waitingOn: j.waitingOn };
    if (change.stage) j.stage = change.stage;
    if (change.state) j.state = change.state;
    if (change.state && change.state !== 'waiting' && change.waitingOn === undefined) j.waitingOn = null;
    if (change.waitingOn !== undefined) j.waitingOn = change.waitingOn;
    if (change.reason !== undefined) j.reason = change.reason;
    if (j.state === 'waiting' && !j.waitingOn) throw new ForgeError('state "waiting" needs --waiting-on');
    for (const [k, v] of Object.entries(change.fields ?? {})) setPath(j, k, v);
    if (['done', 'cancelled'].includes(j.state) && !j.finishedAt) j.finishedAt = now();
  });
  const b = /** @type {any} */ (before);
  if (b.stage !== job.stage || b.state !== job.state || b.waitingOn !== job.waitingOn)
    logEvent(root, id, 'transition', { from: b, to: { stage: job.stage, state: job.state, waitingOn: job.waitingOn }, reason: change.reason ?? undefined });
  if (change.fields && Object.keys(change.fields).length) logEvent(root, id, 'fields', { fields: change.fields });
  if (change.note) logEvent(root, id, 'note', { text: change.note });
  return job;
}

/**
 * Prevents two sessions from driving the same job at once while letting a new session
 * take over a job whose previous session died.
 * @param {string} root @param {string} id @param {string} session @param {boolean} force
 */
export function claimJob(root, id, session, force = false) {
  const job = updateJob(root, id, (j) => {
    const o = j.owner;
    const fresh = o && Date.now() - Date.parse(o.heartbeat ?? o.since) < OWNER_STALE_MS;
    if (o && o.session !== session && fresh && !force)
      throw new ForgeError(`job ${id} is being driven by session ${o.session} (last active ${o.heartbeat}); pass --force to take over`, 3);
    j.owner = { session, host: os.hostname(), since: o?.session === session ? o.since : now(), heartbeat: now() };
    if (!o || o.session !== session) j.runs.push({ session, startedAt: now() });
  });
  logEvent(root, id, 'claimed', { session });
  return job;
}

/** @param {string} root @param {string} id */
export function releaseJob(root, id) {
  updateJob(root, id, (j) => {
    const run = j.runs[j.runs.length - 1];
    if (run && !run.endedAt) run.endedAt = now();
    j.owner = null;
  });
  logEvent(root, id, 'released');
}

/**
 * @param {string} root @param {string} id
 * @param {{role:string, phase:'start'|'end', model?:string, agentId?:string, status?:string, summary?:string,
 *   usage?:{totalTokens?:number, input?:number, output?:number, cacheRead?:number, cacheWrite?:number, toolUses?:number, durationMs?:number, exact?:boolean}}} rec
 * @param {any} config
 */
export function recordAgent(root, id, rec, config) {
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

/** @param {any} job @param {string} role @param {string|null} model @param {any} u @param {any} config */
export function addUsage(job, role, model, u, config) {
  const total = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
  const cost = estimateCost({ ...u, totalTokens: total, model }, config?.usage?.pricing);
  const bump = (/** @type {Record<string, any>} */ bucket, /** @type {string} */ key) => {
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

/** @param {number} n */
const round4 = (n) => Math.round(n * 10000) / 10000;

/** @param {string} root @param {string} id */
export function progress(root, id) {
  const text = readText(path.join(jobDir(root, id), 'tasks.md'));
  const done = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
  const open = (text.match(/^\s*[-*]\s*\[ \]/gm) ?? []).length;
  return { done, total: done + open };
}

/** @param {string} text */
export function parseReview(text) {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = first.match(/^\s*VERDICT:\s*(PASS|CHANGES)\b/i);
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of text.matchAll(/^\s*[-*]\s*\[(blocker|major|minor|nit)\]/gim)) counts[f[1].toLowerCase()]++;
  return { declared: m ? m[1].toUpperCase() : null, counts };
}

/**
 * The tagged findings decide the verdict, so a reviewer that writes PASS above a blocker
 * (or CHANGES over nothing but nits) cannot silently override the repo's blockOn policy.
 * @param {string} root @param {string} id @param {number} round @param {string[]} reviewers @param {string[]} blockOn
 */
export function roundVerdicts(root, id, round, reviewers, blockOn) {
  const dir = path.join(jobDir(root, id), 'review', `round-${round}`);
  /** @type {Record<string, any>} */
  const out = {};
  for (const r of reviewers) {
    const file = path.join(dir, `${r}.md`);
    if (!exists(file)) {
      out[r] = { verdict: 'PENDING' };
      continue;
    }
    const { declared, counts } = parseReview(readText(file));
    const blocking = blockOn.reduce((n, s) => n + (counts[s] ?? 0), 0);
    let verdict = blocking > 0 ? 'CHANGES' : 'PASS';
    if (!declared) verdict = 'MALFORMED';
    else if (declared === 'CHANGES' && blocking === 0 && Object.values(counts).every((c) => c === 0)) verdict = 'CHANGES';
    out[r] = { verdict, declared, counts, blocking, file: path.relative(jobDir(root, id), file) };
  }
  const values = Object.values(out).map((v) => v.verdict);
  const complete = !values.includes('PENDING');
  const outcome = !complete ? 'PENDING' : values.includes('MALFORMED') ? 'MALFORMED' : values.includes('CHANGES') ? 'CHANGES' : 'PASS';
  return { round, complete, outcome, reviewers: out };
}

/** @param {string} root @param {string} id */
export function parseDecision(root, id) {
  const text = readText(path.join(jobDir(root, id), 'decision.md'));
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const m = first.match(/^\s*(APPROVE|ESCALATE)\b\s*[:\-–]?\s*(.*)$/i);
  return m ? { decision: m[1].toUpperCase(), reason: m[2].trim() || null } : { decision: null, reason: null };
}
