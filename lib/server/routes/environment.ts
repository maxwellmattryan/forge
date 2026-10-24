// Environment routes: a job's dev server and backing services, their actions and logs, and every
// running environment.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { redactKnown } from '#engine/guard/known-secrets.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { containedWorktree } from '#engine/workspace/editor.ts';
import { recordEnvironmentStopped } from '#engine/environment/lifecycle.ts';
import { isActive, loadJob, jobDir } from '#core/job/store.ts';
import { exists } from '#core/paths.ts';
import { validJobId } from '#core/job/requests.ts';
import { redactContext, redactText } from '#engine/guard/redact.ts';
import { isMap } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import { startBackground, stopDevProven } from '#engine/workspace/dev-server.ts';
import { entriesOrNone, isManaged } from '#engine/environment/backing.ts';
import { containerName, ownersOf } from '#engine/environment/backing-names.ts';
import { dockerSpawn } from '#integrations/docker/runner.ts';
import { DOCKER_NAME, environmentsSnapshot, forgeJson, jobEnvironment, openDevLog } from '#engine/environment/status.ts';
import type {
  BackingEntry,
  Config,
  EnvironmentAction,
  EnvironmentsResponse,
  EnvironmentTarget,
  JobEnvironmentResponse,
  LoadedJob,
  PostEnvironmentResponse,
} from '#core/types.ts';
import { json, jsonStatus, readJsonBody, send } from '../http.ts';
import { knownReader } from '../redact.ts';
import { MAX_SSE_CLIENTS, SSE_MAX_AGE_MS, SSE_MAX_LINE, SSE_SLOW_CLIENT_BYTES, followFd, sseHead, startPing, textFrame } from '../sse.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';

/** How long GET /api/jobs/:id/environment reuses a job's environment. */
const ENV_MEMO_MS = 2000;
/** How long GET /api/environments reuses its snapshot. */
const ENVS_CACHE_MS = 5000;
const ENV_STATUS_TIMEOUT_MS = 10_000;
/** `backing up` may pull images: lib/engine/environment/backing.ts's RUN_TIMEOUT_MS plus a margin. */
const BACKING_UP_TIMEOUT_MS = 11 * 60_000;
const BACKING_STOP_TIMEOUT_MS = 60_000;
const ENV_ACTIONS: readonly EnvironmentAction[] = ['start', 'stop', 'restart'];

/** The job behind an environment route, or null after answering 404. */
function environmentJob(ctx: ServerCtx, res: http.ServerResponse, id: string): LoadedJob | null {
  const { root } = ctx;
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) {
    jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
    return null;
  }
  return loadJob(root, id);
}

const redactor = (root: string, config: Config) => (s: string): string => {
  try {
    return redactText(s, redactContext(root, config)).text;
  } catch {
    return 'the backing status could not be read';
  }
};

/** A job's environment, reused for 2 s per job: the card polls every 5 s and each read can spawn the CLI. */
function environmentOf(ctx: ServerCtx, config: Config, job: LoadedJob, fresh = false): Promise<JobEnvironmentResponse> {
  const { root, envMemo } = ctx;
  const hit = envMemo.get(job.id);
  if (!fresh && hit && Date.now() - hit.at < ENV_MEMO_MS) return hit.p;
  const p = jobEnvironment(root, config, job, redactor(root, config));
  envMemo.set(job.id, { at: Date.now(), p });
  p.catch(() => envMemo.delete(job.id));
  return p;
}

/** GET /api/jobs/:id/environment: the job's dev server and backing services. */
export async function getJobEnvironment(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const id = match.params[0];
  const job = environmentJob(ctx, res, id);
  if (!job) return;
  return json(res, (await environmentOf(ctx, loadConfig(root).config, job)) satisfies JobEnvironmentResponse);
}

/**
 * POST /api/jobs/:id/environment: start, stop or restart the job's dev server or its backing services.
 * Every action needs the job's own contained worktree (job.json is agent-writable), start needs an
 * active job, and stop signals only a pid ownDevProcess proves is this job's dev server.
 */
export async function postJobEnvironment(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const id = match.params[0];
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const job = environmentJob(ctx, res, id);
  if (!job) return;
  const body = parsed.body;
  const keys = isMap(body) ? Object.keys(body).sort().join(',') : '';
  if (!isMap(body) || keys !== 'action,target' || (body.target !== 'dev' && body.target !== 'backing') || !ENV_ACTIONS.includes(body.action as EnvironmentAction))
    return jsonStatus(res, 400, { error: 'body must be {"target": "dev"|"backing", "action": "start"|"stop"|"restart"}' });
  const target = body.target as EnvironmentTarget;
  const action = body.action as EnvironmentAction;
  const { config } = loadConfig(root);
  const starts = action !== 'stop';
  const wt = containedWorktree(root, config, job);
  if (starts && !isActive(job)) return jsonStatus(res, 409, { error: `job ${job.id} is ${job.state}; only an active job's ${target === 'dev' ? 'dev server' : 'backing services'} can be started` });
  // A worktree field pointing anywhere but <root>/<id> is forged: nothing is spawned or signalled for it.
  if ((target === 'dev' || job.worktree) && !wt) return jsonStatus(res, 409, { error: `job ${job.id} has no worktree inside the worktrees root` });
  let ok = true;
  let detail: string | null = null;
  if (target === 'dev') {
    if (action !== 'start') {
      const r = await stopDevProven(root, job.id, wt!, dashboardActor());
      if (r.refused !== undefined)
        return jsonStatus(res, 409, {
          error: process.platform === 'win32' ? `the dashboard cannot stop a dev server on Windows; stop it with forge stop ${job.id}` : `cannot prove pid ${r.refused} is this job's dev server; stop it with forge stop ${job.id}`,
        });
    }
    if (starts) {
      try {
        await startBackground(root, config, job.id, 'dev');
      } catch (e) {
        if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
        throw e;
      }
    }
  } else {
    if (!entriesOrNone(config).some(isManaged)) return jsonStatus(res, 409, { error: 'no backing service is run by Forge: every backing entry is external or none is configured' });
    // Start is an ensure up, so the environment record and environments.maxRunning count it (and
    // it may evict); Stop keeps the dev server running, so it is backing stop plus the record.
    const up: [string[], number] = [['environment', 'up', job.id], BACKING_UP_TIMEOUT_MS];
    const stop: [string[], number] = [['backing', 'stop', job.id], BACKING_STOP_TIMEOUT_MS];
    const steps = action === 'start' ? [up] : action === 'stop' ? [stop] : [stop, up];
    for (const [args, timeout] of steps) {
      const r = await forgeJson(root, args, timeout);
      if (args[1] === 'stop') recordEnvironmentStopped(root, job.id);
      if (r.exitCode === 0) continue;
      ok = false;
      const list = Array.isArray(r.data?.backing) ? r.data.backing : r.data?.services;
      const failed = Array.isArray(list) ? list.find((s: any) => s && s.ok === false)?.error : r.data?.error;
      detail = redactor(root, config)(typeof failed === 'string' ? failed : (r.data?.error ?? r.error ?? `forge ${args.join(' ')} failed`));
      break;
    }
  }
  const environment = await environmentOf(ctx, config, loadJob(root, job.id), true);
  return json(res, { target, action, ok, detail, environment } satisfies PostEnvironmentResponse);
}

/**
 * GET /api/jobs/:id/environment/logs: the dev log (`logs/dev.log`, followed like a transcript) or a
 * managed backing container's `docker logs --follow`, as SSE frames whose data is a JSON string of one
 * line. `source` is validated before anything is opened or spawned: `dev`, or `backing:<name>` for a
 * managed entry in config, whose container name is derived from config and the job id, never from
 * the query. The container must read as this job's (or this project's) in `backing status`.
 */
export async function getEnvironmentLogs(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root, clients } = ctx;
  const id = match.params[0];
  const job = environmentJob(ctx, res, id);
  if (!job) return;
  const { config } = loadConfig(root);
  const source = match.url.searchParams.get('source') ?? '';
  let entry: BackingEntry | null = null;
  let container: string | null = null;
  // The qualified name and the legacy one (backing-names.ts); status says which one exists.
  let candidates: string[] = [];
  if (source !== 'dev') {
    const name = source.startsWith('backing:') ? source.slice('backing:'.length) : null;
    entry = name === null ? null : (entriesOrNone(config).find((e) => e.name === name && isManaged(e)) ?? null);
    candidates = entry ? ownersOf(root, config, entry.isolation === 'shared' ? null : id).map((o) => containerName(o, entry!.name)) : [];
    container = candidates[0] ?? null;
    if (!entry || !container || !candidates.every((c) => DOCKER_NAME.test(c))) return jsonStatus(res, 400, { error: 'source must be "dev" or "backing:<name>" for a backing service Forge runs' });
  }
  if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
  const scope = `env:${id}:${source}`;
  if (source === 'dev') {
    const opened = openDevLog(root, id);
    if (typeof opened === 'string') return jsonStatus(res, 404, { error: 'no dev log' });
    const fd = opened.fd;
    const known = knownReader(root, id);
    sseHead(res);
    res.write('retry: 3000\n\n');
    clients.set(res, `${ctx.name}/${scope}`);
    const stop = followFd(
      res,
      fd,
      opened.size,
      req.headers['last-event-id'],
      (offset, line) => res.write(textFrame(offset, redactKnown(line, known()))),
      (offset, bytes) => res.write(textFrame(offset, `… a line of ${bytes} bytes was skipped`)),
    );
    const recycle = setTimeout(() => res.end(), ctx.opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
    recycle.unref();
    res.on('close', () => {
      stop();
      clearTimeout(recycle);
      clients.delete(res);
      fs.closeSync(fd);
    });
    return startPing(ctx.machine);
  }
  // A client that leaves during the status call has already fired `close`, so the handler below would
  // never run: its slot and its `docker logs --follow` child would outlive it.
  let gone = false;
  res.once('close', () => (gone = true));
  const status = await forgeJson(root, ['backing', 'status', id], ENV_STATUS_TIMEOUT_MS);
  if (gone || res.destroyed) return;
  const svc = Array.isArray(status.data?.services) ? status.data.services.find((s: any) => s?.name === entry!.name) : null;
  if (svc && candidates.includes(svc.container)) container = svc.container;
  if (!svc || (svc.state !== 'running' && svc.state !== 'stopped')) return jsonStatus(res, 409, { error: `container ${container} is ${svc?.state ?? 'unknown'}: its logs are not shown` });
  // Checked again: the status call above took time, and other streams may have opened meanwhile.
  if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
  sseHead(res);
  res.write('retry: 3000\n\n');
  clients.set(res, `${ctx.name}/${scope}`);
  const known = knownReader(root, id);
  const child = dockerSpawn(['logs', '--follow', '--tail', '200', '--', container!]);
  let ended = false;
  const lines = (pipe: NodeJS.ReadableStream) => {
    let partial = '';
    pipe.setEncoding?.('utf8');
    pipe.on('data', (c: string) => {
      partial += c;
      let nl = partial.indexOf('\n');
      while (nl !== -1) {
        res.write(textFrame(null, redactKnown(partial.slice(0, nl), known())));
        partial = partial.slice(nl + 1);
        nl = partial.indexOf('\n');
      }
      // One endless line is sent in pieces rather than held.
      if (partial.length > SSE_MAX_LINE) {
        // Redacted whole, before it is cut into pieces, so a value can't straddle two of them.
        res.write(textFrame(null, redactKnown(partial, known())));
        partial = '';
      }
      if (res.writableLength > SSE_SLOW_CLIENT_BYTES) res.end();
    });
    pipe.on('end', () => {
      if (partial && !ended) res.write(textFrame(null, redactKnown(partial, known())));
      partial = '';
    });
  };
  lines(child.stdout);
  lines(child.stderr);
  child.on('error', () => res.end());
  const finish = () => {
    if (ended) return;
    ended = true;
    res.write('event: end\ndata: null\n\n');
    res.end();
  };
  child.on('close', finish);
  // A recycled container stream ends rather than reconnects: its frames carry no offset, so a reconnect
  // would replay the last 200 lines on top of the ones already shown.
  const recycle = setTimeout(finish, ctx.opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
  recycle.unref();
  res.on('close', () => {
    ended = true;
    clearTimeout(recycle);
    clients.delete(res);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  });
  startPing(ctx.machine);
}

/** GET /api/environments: every running environment, reused for 5 s, with one computation shared by concurrent callers. */
export async function getEnvironments(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  if (!ctx.envsCache || Date.now() - ctx.envsCache.at > ENVS_CACHE_MS) {
    const p = environmentsSnapshot(root, loadConfig(root).config);
    ctx.envsCache = { at: Date.now(), p };
    p.catch(() => {
      if (ctx.envsCache?.p === p) ctx.envsCache = null;
    });
  }
  return json(res, (await ctx.envsCache.p) satisfies EnvironmentsResponse);
}
