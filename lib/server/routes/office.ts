// Session pool routes: the per-session event stream, the session log, start and stop, permission
// answers and permission modes.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { daemonProblems, loadConfig } from '#core/config/load.ts';
import { scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { PERMISSION_MODES } from '#office/session/lifecycle.ts';
import { UUID, logBaseOf, readInfo, readLogPage, sessionFiles } from '#core/job/session-files.ts';
import type { PoolState } from '#office/pool.ts';
import { jobDir } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import { INBOX_SCOPE, JOBS_SCOPE, OFFICE_SCOPE, validScope } from '#core/job/requests.ts';
import { openConfinedLog } from '#engine/environment/status.ts';
import type { DaemonLogPage, DaemonSessionState, PermissionDecision, PostDaemonModeResponse } from '#core/types.ts';
import { json, jsonStatus, readBody, send } from '../http.ts';
import { redactPage } from '../redact.ts';
import { MAX_SSE_CLIENTS, SSE_MAX_AGE_MS, lineFrame, sseHead, startPing, stateFrame } from '../sse.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';

const PERMISSION_DECISIONS: readonly PermissionDecision[] = ['allow', 'session', 'deny'];

/**
 * Server-sent events for one session: its state, then its buffered log lines, then live ones,
 * each with its log offset as the id. GET only and loopback-only like every route; readGuard
 * keeps other sites out. A cross-site request from a browser that sends no Fetch Metadata can
 * still hold a slot until the stream is recycled (sseMaxAgeMs), which costs the live log's
 * availability, never the daemon.
 */
export function getEvents(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root, clients } = ctx;
  const scope = match.url.searchParams.get('session');
  // Syntax only, so the logs of deleted jobs stay viewable.
  if (!validScope(scope)) return jsonStatus(res, 400, { error: 'session must be "_inbox", "_office" or a job id' });
  if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
  // Before the headers: an unreadable config then fails the request instead of a half-open stream.
  const known = scopeKnownValues(root, scope, loadConfig(root).config);
  sseHead(res);
  res.write('retry: 3000\n\n');
  clients.set(res, scope);
  res.write(stateFrame(ctx.pool ? ctx.pool.sessionState(scope) : offSessionState(root, scope), known));
  const last = Number(req.headers['last-event-id']);
  for (const r of ctx.pool?.recent(scope, req.headers['last-event-id'] === undefined || !Number.isFinite(last) ? undefined : last) ?? []) res.write(lineFrame(r.offset, r.line));
  const recycle = setTimeout(() => res.end(), ctx.opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
  recycle.unref();
  // The response's close, not the request's: a GET's request side ends as soon as it is read.
  res.on('close', () => {
    clearTimeout(recycle);
    clients.delete(res);
  });
  startPing(ctx);
}

/**
 * GET /api/daemons/log: a page of one session's log, read backwards from `before`, through the
 * rotated `<scope>.log.1` once paging reaches the start of `<scope>.log` (offsets below logBase).
 * The scope is validated before any path is built, and each file is opened by openConfinedLog.
 */
export function getSessionLog(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root } = ctx;
  const scope = match.url.searchParams.get('session');
  if (!validScope(scope)) return jsonStatus(res, 400, { error: 'session must be "_inbox", "_office" or a job id' });
  const rawBefore = match.url.searchParams.get('before');
  const before = rawBefore === null || rawBefore === '' ? null : Number(rawBefore);
  if (before !== null && !(Number.isSafeInteger(before) && before >= 0)) return jsonStatus(res, 400, { error: 'before must be a log offset' });
  const f = sessionFiles(root, scope);
  const known = scopeKnownValues(root, scope, loadConfig(root).config);
  const empty: DaemonLogPage = { scope, lines: [], start: 0, end: 0, more: false };
  const opened: number[] = [];
  const open = (file: string) => {
    const r = openConfinedLog(root, f.dir, file);
    if (typeof r !== 'string') opened.push(r.fd);
    return r;
  };
  try {
    const logBase = logBaseOf(readInfo(f.info));
    if (before !== null && before <= logBase) {
      // Everything before logBase is in the previous generation, which starts at logBase - its size.
      const prev = open(`${f.log}.1`);
      if (prev === 'missing') return json(res, empty);
      if (prev === 'refused') return jsonStatus(res, 404, { error: 'no session log' });
      const page = redactPage(readLogPage(prev.fd, prev.size, Math.max(0, logBase - prev.size), { before }), known);
      return json(res, { scope, ...page } satisfies DaemonLogPage);
    }
    const cur = open(f.log);
    if (cur === 'refused') return jsonStatus(res, 404, { error: 'no session log' });
    const page = cur === 'missing' ? { lines: [], start: logBase, end: logBase, more: false } : readLogPage(cur.fd, cur.size, logBase, { before });
    if (page.start === logBase && !page.more) {
      // A refused .log.1 (a link or a FIFO) is never read: paging just ends at .log.
      const prev = open(`${f.log}.1`);
      if (typeof prev !== 'string' && prev.size > 0) page.more = true;
      else if (cur === 'missing') return json(res, empty);
    }
    return json(res, { scope, ...redactPage(page, known) } satisfies DaemonLogPage);
  } catch {
    return jsonStatus(res, 404, { error: 'no session log' });
  } finally {
    for (const fd of opened) fs.closeSync(fd);
  }
}

/** POST /api/daemon/permission: answer one session's permission prompt. */
export async function postPermission(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  let body: any;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return jsonStatus(res, 400, { error: 'body is not JSON' });
  }
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  if (!validScope(obj.scope)) return jsonStatus(res, 400, { error: 'scope must be "_inbox", "_office" or a job id' });
  if (typeof obj.id !== 'string' || !UUID.test(obj.id)) return jsonStatus(res, 400, { error: 'id must be a permission prompt id' });
  if (!PERMISSION_DECISIONS.includes(obj.decision)) return jsonStatus(res, 400, { error: `decision must be one of ${PERMISSION_DECISIONS.join(', ')}` });
  // Only the decision travels on: what the session gets back is built from claude's own request.
  if (!ctx.pool?.answerPermission(obj.scope, obj.id, obj.decision, dashboardActor())) return jsonStatus(res, 404, { error: 'that permission prompt is gone: already answered, or its session stopped' });
  return json(res, ctx.poolState());
}

/** POST /api/daemon/mode: a scope's permission mode, or the default for job sessions. */
export async function postDaemonMode(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  let body: any;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return jsonStatus(res, 400, { error: 'body is not JSON' });
  }
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const jobs = obj.scope === JOBS_SCOPE;
  if (!jobs && !validScope(obj.scope)) return jsonStatus(res, 400, { error: 'scope must be "_inbox", "_office", "_jobs" or a job id' });
  if (!jobs && obj.scope !== INBOX_SCOPE && obj.scope !== OFFICE_SCOPE && !exists(path.join(jobDir(root, obj.scope), 'job.json'))) return jsonStatus(res, 404, { error: `no job ${obj.scope}` });
  if (!PERMISSION_MODES.includes(obj.mode)) return jsonStatus(res, 400, { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` });
  // Only a value from that fixed list travels on, to the supervisor's memory and the session's stdin.
  const r = (jobs ? ctx.pool?.setJobPermissionMode(obj.mode, dashboardActor()) : ctx.pool?.setPermissionMode(obj.scope, obj.mode, dashboardActor())) ?? { error: 'the daemon pool is not ready' };
  if (r.error) return jsonStatus(res, 409, { error: r.error });
  return json(res, ctx.poolState() satisfies PostDaemonModeResponse);
}

/** POST /api/daemon: start or stop the pool, or one session. */
export async function postDaemon(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  let body: any;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return jsonStatus(res, 400, { error: 'body is not JSON' });
  }
  const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const action = obj.action;
  if (action !== 'start' && action !== 'stop') return jsonStatus(res, 400, { error: 'action must be "start" or "stop"' });
  if (obj.scope !== undefined) {
    // Checked before anything is built from it.
    if (!validScope(obj.scope)) return jsonStatus(res, 400, { error: 'scope must be "_inbox", "_office" or a job id' });
    if (obj.scope !== INBOX_SCOPE && obj.scope !== OFFICE_SCOPE && !exists(path.join(jobDir(root, obj.scope), 'job.json'))) return jsonStatus(res, 404, { error: `no job ${obj.scope}` });
    if (action === 'stop') {
      await ctx.pool?.stopSession(obj.scope);
      return json(res, ctx.poolState());
    }
    if (ctx.pool?.startSession(obj.scope).error) return jsonStatus(res, 409, { error: 'start the daemon first' });
    return json(res, ctx.poolState());
  }
  if (action === 'stop') {
    await ctx.pool?.stop('http');
    return json(res, ctx.poolState());
  }
  const { config } = loadConfig(root);
  if (config.daemon?.enabled !== true) return jsonStatus(res, 409, { error: 'daemon.enabled is false in .forge/config.yml' });
  const problem = daemonProblems(config, root)[0];
  if (problem) return jsonStatus(res, 409, { error: problem });
  ctx.pool?.start('http');
  return json(res, ctx.poolState());
}

/** A session's state before the pool exists (never visible once the server is listening). */
function offSessionState(_root: string, scope: string): DaemonSessionState {
  return { scope, wanted: false, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false, lastError: null, permissions: [], permissionMode: null, kept: null, effort: null };
}

/** The pool block before a pool exists (never visible once the server is listening). */
export function idlePoolState(root: string): PoolState {
  return { enabled: false, wanted: false, maxConcurrent: 1, live: 0, lastError: null, inbox: offSessionState(root, INBOX_SCOPE), office: offSessionState(root, OFFICE_SCOPE), foreman: false, jobs: {}, permissionMode: 'default', permissionModes: {}, jobPermissionMode: null };
}
