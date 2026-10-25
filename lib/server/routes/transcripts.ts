// Claude Code transcripts on the dashboard: locating a job's agent or owner transcript, its page and
// stream, and the agent rows and activity read from them.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { knownValues, redactKnown } from '#engine/guard/known-secrets.ts';
import { UUID, readLogPage } from '#core/job/session-files.ts';
import { daemonSessionIds } from '#office/driver.ts';
import { AGENT_LEASE_MS, loadJob, jobDir } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import { validJobId } from '#core/job/requests.ts';
import { agentTranscript, cachedActivity, openTranscript, ownerTranscript } from '#integrations/claude/transcripts.ts';
import type { TranscriptHit } from '#integrations/claude/transcripts.ts';
import type { AgentActivity, AgentRow, ForgeTruncatedLine, JobEvent, LoadedJob, TranscriptPage } from '#core/types.ts';
import { json, jsonStatus, send } from '../http.ts';
import { knownReader, redactPage } from '../redact.ts';
import { MAX_SSE_CLIENTS, SSE_MAX_AGE_MS, followFd, lineFrame, sseHead, startPing } from '../sse.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';

const NO_TRANSCRIPT = 'no transcript';

/**
 * The transcript a transcript route asked for, located from job state only: `agent` must be an own
 * key of job.agents, and without it the owner must be an interactive session. No query value is
 * ever used as a path or a path segment. Null for anything else, which the routes answer with 404.
 */
function locateTranscript(ctx: ServerCtx, id: string, url: URL): { hit: TranscriptHit; source: 'agent' | 'owner'; role: string | null } | null {
  const { root, projects } = ctx;
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return null;
  let job: LoadedJob;
  try {
    job = loadJob(root, id);
  } catch {
    return null;
  }
  if (url.searchParams.has('agent')) {
    const role = url.searchParams.get('agent') ?? '';
    if (!Object.hasOwn(job.agents, role)) return null;
    const hit = agentTranscript(root, job, role, { projects });
    return hit ? { hit, source: 'agent', role } : null;
  }
  const hit = interactiveOwner(root, job, projects);
  return hit ? { hit, source: 'owner', role: null } : null;
}

/**
 * GET /api/jobs/<id>/transcript: a page of an agent's (or the interactive owner's) Claude Code
 * transcript, read backwards from `before` like /api/daemons/log. Transcripts can hold anything
 * a session read, so it takes the token like a POST as well as the read checks.
 */
export function getTranscript(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root, projects } = ctx;
  const id = match.params[0];
  const rawBefore = match.url.searchParams.get('before');
  const before = rawBefore === null || rawBefore === '' ? null : Number(rawBefore);
  if (before !== null && !(Number.isSafeInteger(before) && before >= 0)) return jsonStatus(res, 400, { error: 'before must be a transcript offset' });
  const found = locateTranscript(ctx, id, match.url);
  const t = found ? openTranscript(found.hit, projects) : null;
  if (!found || !t) return jsonStatus(res, 404, { error: NO_TRANSCRIPT });
  try {
    const page = redactPage(readLogPage(t.fd, t.size, 0, { before }), knownValues(root, id, loadConfig(root).config));
    return json(res, { job: id, source: found.source, role: found.role, ...page } satisfies TranscriptPage);
  } catch {
    return jsonStatus(res, 404, { error: NO_TRANSCRIPT });
  } finally {
    fs.closeSync(t.fd);
  }
}

/**
 * GET /api/jobs/<id>/transcript/events: the transcript's last ≤64 KiB of complete lines (or what
 * follows Last-Event-ID), then each line appended later. EventSource can't send headers, so the
 * token comes as a query parameter, compared in constant time. One descriptor, opened through
 * openTranscript, is held for the stream's life, so a symlink swapped in later can't redirect it.
 * The stream's scope contains `:`, which no session scope can, so pool frames never reach it.
 */
export function getTranscriptEvents(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root, projects, clients } = ctx;
  const id = match.params[0];
  if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
  const found = locateTranscript(ctx, id, match.url);
  const t = found ? openTranscript(found.hit, projects) : null;
  if (!found || !t) return jsonStatus(res, 404, { error: NO_TRANSCRIPT });
  const fd = t.fd;
  const known = knownReader(root, id);
  sseHead(res);
  res.write('retry: 3000\n\n');
  clients.set(res, `${ctx.name}/transcript:${id}:${found.role ?? 'owner'}`);
  const stop = followFd(
    res,
    fd,
    t.size,
    req.headers['last-event-id'],
    (offset, line) => {
      if (line.trim()) res.write(lineFrame(offset, redactKnown(line, known())));
    },
    (offset, bytes) => res.write(lineFrame(offset, JSON.stringify({ type: 'forge-truncated', originalType: null, bytes } satisfies ForgeTruncatedLine))),
  );
  const recycle = setTimeout(() => res.end(), ctx.opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
  recycle.unref();
  res.on('close', () => {
    stop();
    clearTimeout(recycle);
    clients.delete(res);
    fs.closeSync(fd);
  });
  startPing(ctx.machine);
}

const startMs = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);
const newestFirst = (a: { startedAt?: string | null }, b: { startedAt?: string | null }): number => (startMs(b.startedAt) || 0) - (startMs(a.startedAt) || 0);

/**
 * One line per running agent (under agent start's 2 h lease), newest first, each with what its
 * transcript says it did last. The tail read is bounded and cached, so the 2 s poll stays cheap.
 */
export function jobActivity(root: string, job: LoadedJob, projects: string, at = Date.now()): AgentActivity[] {
  const out: AgentActivity[] = [];
  for (const [role, a] of Object.entries(job.agents ?? {})) {
    if (a?.status !== 'running' || !(at - startMs(a.startedAt) < AGENT_LEASE_MS)) continue;
    const hit = agentTranscript(root, job, role, { projects });
    out.push({ role, model: a.model ?? null, startedAt: a.startedAt ?? null, last: hit ? cachedActivity(hit, projects, { worktree: job.worktree, root }) : null });
  }
  return out.sort(newestFirst);
}

/** The current round's agent records plus any still running, newest first, with each run's tokens from its agent-end event. */
export function roundAgents(root: string, job: LoadedJob, events: JobEvent[], projects: string): AgentRow[] {
  const rows: AgentRow[] = [];
  for (const [role, a] of Object.entries(job.agents ?? {})) {
    if (!a || (a.round !== job.round && a.status !== 'running')) continue;
    const started = startMs(a.startedAt);
    const running = a.status === 'running';
    const end = running ? undefined : events.findLast((e) => e.type === 'agent-end' && e.role === role && !(Date.parse(e.ts) < started));
    const tokens = end?.usage?.totalTokens;
    const ended = startMs(a.endedAt);
    rows.push({
      role,
      status: a.status ?? null,
      model: a.model ?? null,
      startedAt: a.startedAt ?? null,
      endedAt: a.endedAt ?? null,
      durationMs: !running && Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : null,
      tokens: typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : null,
      transcript: agentTranscript(root, job, role, { projects }) !== null,
    });
  }
  return rows.sort(newestFirst);
}

/** The owner's transcript when the owner is an interactive session: in no daemon session record. */
export function interactiveOwner(root: string, job: LoadedJob, projects: string): (TranscriptHit & { session: string }) | null {
  const sid = job.lease.driver;
  if (typeof sid !== 'string' || !UUID.test(sid) || daemonSessionIds(root).includes(sid)) return null;
  const hit = ownerTranscript(root, job, { projects });
  return hit ? { ...hit, session: sid } : null;
}
