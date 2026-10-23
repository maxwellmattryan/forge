// The dashboard's HTTP server (`forge dash`): startServer, the route table that names each route's
// handler and guards, and the dispatch that answers loopback Hosts only.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { daemonProblems, loadConfig } from '#core/config/load.ts';
import { scopeKnownValues } from '#engine/guard/known-secrets.ts';
import { createPool } from '#office/pool.ts';
import { createPreviewer, ghRunner } from '#integrations/github/preview.ts';
import { PLUGIN_ROOT } from '#core/paths.ts';
import { repoBudgetStatus } from '#engine/metrics/repo-budget.ts';
import { claudeProjectsDir } from '#integrations/claude/transcripts.ts';
import { versionInfo } from '#engine/ops/version.ts';
import type { ApiError, DaemonPoolState, RepoBudgetStatus } from '#core/types.ts';
import { guardPost, guardQueryToken, guardToken, isLoopbackHost, readGuard, send } from './http.ts';
import { SSE_SLOW_CLIENT_BYTES, broadcast, lineFrame, stateFrame } from './sse.ts';
import { DEV_NOT_BUILT, NOT_BUILT, distDirFor, getAsset, getLogo, getPage } from './static.ts';
import { postJobEnvironment, getEnvironmentLogs, getEnvironments, getJobEnvironment } from './routes/environment.ts';
import { getConfig, postBudgetAck, postConfig } from './routes/config.ts';
import { getJob, getJobFile, getRequests, postJob, postJobDelete, postJobEffort, postJobRepos, postRequest, postRunOrEditor } from './routes/jobs.ts';
import { getAbout, getBacklog, getDoctor, getEvals, getEvalsCompare, getGitHubPreview, getProject, getRoster, getState, getStats, getSupportBundle, postFocus } from './routes/misc.ts';
import { getEvents, getSessionLog, idlePoolState, postDaemon, postDaemonMode, postPermission } from './routes/office.ts';
import { getTranscript, getTranscriptEvents } from './routes/transcripts.ts';
import type { Guard, RequestInfo, Route, RunningServer, ServerCtx, ServerOptions } from './types.ts';

/** How long /api/state reuses the repo budget status. */
const BUDGET_MEMO_MS = 5000;

/** The pathname for the activity log, from a URL whose Host may be bad (that request is still reported). */
function logPath(raw: string | undefined): string {
  try {
    return new URL(raw ?? '/', 'http://x').pathname;
  } catch {
    return '/';
  }
}

/** Reports a request to `hook` once, on finish or on an early close; a throwing hook is swallowed. */
function observeRequest(req: http.IncomingMessage, res: http.ServerResponse, hook: (r: RequestInfo) => void): void {
  const t0 = performance.now();
  const method = req.method ?? 'GET';
  const p = logPath(req.url);
  let done = false;
  const report = (status: number | 'aborted') => {
    if (done) return;
    done = true;
    try {
      hook({ method, path: p, status, ms: Math.round(performance.now() - t0), sse: String(res.getHeader('content-type') ?? '').startsWith('text/event-stream') });
    } catch {
      // The activity log never affects a response.
    }
  };
  res.once('finish', () => report(res.statusCode));
  res.once('close', () => report(res.writableFinished ? res.statusCode : 'aborted'));
}

/** Each Guard name's check (lib/server/http.ts); each returns true when it has already answered the request. */
const GUARDS: Record<Guard, (ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean> = {
  read: (_ctx, req, res) => readGuard(req, res),
  token: (ctx, req, res) => guardToken(req, res, ctx.token),
  queryToken: (ctx, _req, res, url) => guardQueryToken(res, url, ctx.token),
};

/**
 * Every route, in the order dispatch tries them: a method, an exact path or an anchored RegExp with no
 * flags, the guards a GET runs before its handler, and the handler. Every POST row gets guardPost first,
 * so a POST row names no guards. Anything that matches no row is a 404.
 */
export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/', handler: getPage },
  { method: 'GET', path: '/index.html', handler: getPage },
  { method: 'GET', path: /^\/assets\//, handler: getAsset },
  { method: 'GET', path: '/forge.png', handler: getLogo },
  { method: 'GET', path: '/api/state', handler: getState },
  { method: 'GET', path: '/api/events', guards: ['read'], handler: getEvents },
  { method: 'GET', path: '/api/daemons/log', guards: ['read'], handler: getSessionLog },
  { method: 'GET', path: '/api/stats', handler: getStats },
  { method: 'GET', path: '/api/evals', handler: getEvals },
  { method: 'GET', path: '/api/evals/compare', handler: getEvalsCompare },
  { method: 'GET', path: '/api/requests', handler: getRequests },
  { method: 'GET', path: '/api/roster', handler: getRoster },
  { method: 'GET', path: '/api/project', handler: getProject },
  { method: 'GET', path: '/api/backlog', handler: getBacklog },
  { method: 'GET', path: '/api/config', handler: getConfig },
  { method: 'GET', path: '/api/about', handler: getAbout },
  { method: 'GET', path: '/api/environments', guards: ['read', 'token'], handler: getEnvironments },
  { method: 'GET', path: /^\/api\/jobs\/([^/]+)\/environment$/, guards: ['read', 'token'], handler: getJobEnvironment },
  { method: 'GET', path: /^\/api\/jobs\/([^/]+)\/environment\/logs$/, guards: ['read', 'queryToken'], handler: getEnvironmentLogs },
  { method: 'POST', path: /^\/api\/jobs\/([^/]+)\/environment$/, handler: postJobEnvironment },
  // It spawns git and gh, so it takes the token like a POST.
  { method: 'GET', path: '/api/doctor', guards: ['token'], handler: getDoctor },
  { method: 'GET', path: '/api/doctor/bundle', guards: ['read', 'token'], handler: getSupportBundle },
  // It spawns gh and spends the login's GitHub rate limit, so it takes the token like a POST.
  { method: 'GET', path: '/api/github/preview', guards: ['token'], handler: getGitHubPreview },
  { method: 'POST', path: '/api/jobs', handler: postJob },
  { method: 'GET', path: /^\/api\/jobs\/([A-Za-z0-9._-]+)$/, guards: ['read'], handler: getJob },
  { method: 'GET', path: /^\/api\/jobs\/([A-Za-z0-9._-]+)\/transcript$/, guards: ['read', 'token'], handler: getTranscript },
  { method: 'GET', path: /^\/api\/jobs\/([A-Za-z0-9._-]+)\/transcript\/events$/, guards: ['read', 'queryToken'], handler: getTranscriptEvents },
  { method: 'GET', path: /^\/api\/jobs\/([A-Za-z0-9._-]+)\/(file|raw)$/, handler: getJobFile },
  { method: 'POST', path: '/api/requests', handler: postRequest },
  { method: 'POST', path: '/api/config', handler: postConfig },
  { method: 'POST', path: '/api/budget/ack', handler: postBudgetAck },
  { method: 'POST', path: '/api/daemon/permission', handler: postPermission },
  { method: 'POST', path: '/api/daemon/mode', handler: postDaemonMode },
  { method: 'POST', path: '/api/daemon', handler: postDaemon },
  { method: 'POST', path: /^\/api\/jobs\/([^/]+)\/effort$/, handler: postJobEffort },
  { method: 'POST', path: /^\/api\/jobs\/([^/]+)\/delete$/, handler: postJobDelete },
  { method: 'POST', path: /^\/api\/jobs\/([^/]+)\/repos$/, handler: postJobRepos },
  { method: 'POST', path: '/api/focus', handler: postFocus },
  { method: 'POST', path: /^\/api\/jobs\/([^/]+)\/(run|editor)$/, handler: postRunOrEditor },
];

/**
 * The first row whose method is `method` and whose path matches `pathname`: a string path by
 * equality, a RegExp with its capture groups as `params`. Null when nothing matches, or for no method.
 */
export function matchRoute(routes: readonly Route[], method: string | undefined, pathname: string): { route: Route; params: string[] } | null {
  if (method === undefined) return null;
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: [] };
      continue;
    }
    const m = pathname.match(route.path);
    if (m) return { route, params: m.slice(1) };
  }
  return null;
}

/** One startServer call's state: nothing per-server lives at module level, since a test process runs several servers. */
function createContext(root: string, opts: ServerOptions): ServerCtx {
  const ctx: ServerCtx = {
    root,
    opts,
    token: crypto.randomBytes(16).toString('hex'),
    distDir: distDirFor(opts),
    notBuilt: opts.dev ? DEV_NOT_BUILT : NOT_BUILT,
    previewGitHub: createPreviewer({ run: opts.ghRun ?? ghRunner(root) }),
    projects: opts.projectsDir ?? claudeProjectsDir(),
    // Once per server: finding the commit can spawn git, and /api/about takes no token. The running
    // code's commit can't change under a live server (`forge update` restarts the dashboard).
    provenance: versionInfo(PLUGIN_ROOT),
    backlogCache: null,
    /** Open event streams and the session each one follows; MAX_SSE_CLIENTS counts them all. */
    clients: new Map<http.ServerResponse, string>(),
    pool: null,
    ping: null,
    poolState: (): DaemonPoolState => ({ ...(ctx.pool ? ctx.pool.state() : idlePoolState(root)), clients: ctx.clients.size }),
    /**
     * The lease's driver is this job's own pool session and that session runs: a resume reaches exactly
     * it, so its live lease doesn't hold the resume. Asked of the pool, never of ps or the session records.
     */
    ownPoolSession: (job) => {
      if (!ctx.pool || !job.lease.driver) return false;
      const s = ctx.pool.sessionState(job.id);
      return s.running && s.sessionId === job.lease.driver;
    },
    // Polls come every few seconds and the ledger stats every job's events, so the status is reused for 5 s.
    // write: false, so a GET never writes .forge/runtime/.
    budgetCache: null,
    budget: (): RepoBudgetStatus => {
      if (!ctx.budgetCache || Date.now() - ctx.budgetCache.at > BUDGET_MEMO_MS) ctx.budgetCache = { at: Date.now(), data: repoBudgetStatus(root, loadConfig(root).config, { write: false }) };
      return ctx.budgetCache.data;
    },
    envMemo: new Map(),
    envsCache: null,
  };
  return ctx;
}

/**
 * Read-mostly, localhost-only server. POSTs need the per-process token embedded in the page,
 * so another site in the same browser cannot enqueue work or start the daemon.
 * `distDir` is a test seam like `sseMaxAgeMs`; it defaults to the plugin's dashboard/dist, or to
 * the dev build under `dev`.
 */
export function startServer(root: string, opts: ServerOptions = {}): Promise<RunningServer> {
  const ctx = createContext(root, opts);
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    if (opts.onRequest) observeRequest(req, res, opts.onRequest);
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, 'text/plain', 'misdirected request');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const hit = matchRoute(ROUTES, req.method, url.pathname);
      if (!hit) return send(res, 404, 'text/plain', 'not found');
      if (hit.route.method === 'POST' && guardPost(req, res, ctx.token)) return;
      for (const g of hit.route.guards ?? []) if (GUARDS[g](ctx, req, res, url)) return;
      await hit.route.handler(ctx, req, res, { url, params: hit.params });
    } catch (e) {
      if (res.headersSent) return void res.end();
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message } satisfies ApiError));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7400, host, () => {
      // Created only once the port is ours, so a dash retrying ports never starts a second pool.
      const d = createPool(root, opts.daemon);
      ctx.pool = d;
      // Each stream gets only its own session's lines and state.
      d.subscribe((e) => {
        let frame: string;
        try {
          frame = e.kind === 'line' ? lineFrame(e.offset, e.line) : stateFrame(e.state, scopeKnownValues(root, e.scope, loadConfig(root).config));
        } catch {
          // Unreadable config: a state frame that can't be redacted is dropped, never sent raw.
          return;
        }
        broadcast(ctx.clients, frame, SSE_SLOW_CLIENT_BYTES, e.scope);
      });
      try {
        const { config } = loadConfig(root);
        // A dev dashboard often runs in a fresh clone of a repo that commits daemon.enabled: true,
        // so it never boots a paid session by itself; Start still works.
        if (!opts.dev && config.daemon?.enabled === true && !daemonProblems(config, root).length) d.start('boot');
      } catch {}
      const close = async () => {
        if (ctx.ping) clearInterval(ctx.ping);
        for (const c of ctx.clients.keys()) c.end();
        ctx.clients.clear();
        await d.close();
        await new Promise((r) => {
          server.close(() => r(undefined));
          server.closeAllConnections?.();
        });
      };
      resolve({ server, url: `http://${host}:${(server.address() as AddressInfo).port}`, pool: d, close });
    });
  });
}
