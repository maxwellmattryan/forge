// The machine's dashboard HTTP server (`forge dash`): startServer, the two route tables (the machine's,
// and each project's under /api/p/<project>/) that name each route's handler and guards, and the
// dispatch that answers loopback Hosts only.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { PLUGIN_ROOT, forgeHome } from '#core/paths.ts';
import { ghGitHub } from '#integrations/github/pull-requests.ts';
import { claudeProjectsDir } from '#integrations/claude/transcripts.ts';
import { versionInfo } from '#engine/ops/version.ts';
import { createMachineSlots } from '#office/slots.ts';
import type { ApiError } from '#core/types.ts';
import { guardPost, guardQueryToken, guardToken, isLoopbackAddress, isLoopbackHost, readGuard, send } from './http.ts';
import { createEntries } from './machine.ts';
import { startKeepAwake } from './uptime.ts';
import { DEV_NOT_BUILT, NOT_BUILT, distDirFor, getAsset, getLogo, getPage } from './static.ts';
import { postJobEnvironment, getEnvironmentLogs, getEnvironments, getJobEnvironment } from './routes/environment.ts';
import { getConfig, postBudgetAck, postConfig } from './routes/config.ts';
import { getJob, getJobFile, getRequests, postJob, postJobBudget, postJobDelete, postJobEffort, postJobMerge, postJobRepos, postRequest, postRunOrEditor } from './routes/jobs.ts';
import { getProjects, getProjectsEvents, getProjectsStats } from './routes/machine.ts';
import { getMandateDraft, postMandateDraft } from './routes/mandates.ts';
import { getAbout, getBacklog, getDoctor, getEvals, getEvalsCompare, getGitHubPreview, getProject, getRoster, getState, getStats, getSupportBundle, postFocus } from './routes/misc.ts';
import { getEvents, getSessionLog, postDaemon, postDaemonMode, postPermission } from './routes/office.ts';
import { getTranscript, getTranscriptEvents } from './routes/transcripts.ts';
import type { Guard, MachineCtx, RequestInfo, Route, RunningServer, ServerCtx, ServerOptions } from './types.ts';

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
const GUARDS: Record<Guard, (m: MachineCtx, req: http.IncomingMessage, res: http.ServerResponse, url: URL) => boolean> = {
  read: (_m, req, res) => readGuard(req, res),
  token: (m, req, res) => guardToken(req, res, m.token),
  queryToken: (m, _req, res, url) => guardQueryToken(res, url, m.token),
};

/**
 * The machine's routes, matched on the full pathname: the page and its assets, /api/about and the
 * registered projects. Rows are a method, an exact path or an anchored RegExp with no flags, the guards
 * a GET runs before its handler, and the handler. Every POST row gets guardPost first, so a POST row
 * names no guards. Anything that matches no row in either table is a 404.
 */
export const ROUTES: readonly Route<MachineCtx>[] = [
  { method: 'GET', path: '/', handler: getPage },
  { method: 'GET', path: '/index.html', handler: getPage },
  { method: 'GET', path: /^\/assets\//, handler: getAsset },
  { method: 'GET', path: '/forge.png', handler: getLogo },
  { method: 'GET', path: '/api/about', guards: ['read'], handler: getAbout },
  { method: 'GET', path: '/api/projects', guards: ['read'], handler: getProjects },
  { method: 'GET', path: '/api/projects/events', guards: ['read'], handler: getProjectsEvents },
  { method: 'GET', path: '/api/projects/stats', guards: ['read'], handler: getProjectsStats },
];

/**
 * Each project's routes, matched on the path after `/api/p/<project>`, in the order dispatch tries them;
 * rows are as in ROUTES. Every GET takes the read guard: a no-cors GET from another site can't read the
 * reply, but without it could still loop the expensive reads.
 */
export const PROJECT_ROUTES: readonly Route<ServerCtx>[] = [
  { method: 'GET', path: '/state', guards: ['read'], handler: getState },
  { method: 'GET', path: '/events', guards: ['read'], handler: getEvents },
  { method: 'GET', path: '/daemons/log', guards: ['read'], handler: getSessionLog },
  { method: 'GET', path: '/stats', guards: ['read'], handler: getStats },
  { method: 'GET', path: '/evals', guards: ['read'], handler: getEvals },
  { method: 'GET', path: '/evals/compare', guards: ['read'], handler: getEvalsCompare },
  { method: 'GET', path: '/requests', guards: ['read'], handler: getRequests },
  { method: 'GET', path: '/roster', guards: ['read'], handler: getRoster },
  { method: 'GET', path: '/project', guards: ['read'], handler: getProject },
  { method: 'GET', path: '/backlog', guards: ['read'], handler: getBacklog },
  { method: 'GET', path: '/config', guards: ['read'], handler: getConfig },
  { method: 'GET', path: '/environments', guards: ['read', 'token'], handler: getEnvironments },
  { method: 'GET', path: /^\/jobs\/([^/]+)\/environment$/, guards: ['read', 'token'], handler: getJobEnvironment },
  { method: 'GET', path: /^\/jobs\/([^/]+)\/environment\/logs$/, guards: ['read', 'queryToken'], handler: getEnvironmentLogs },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/environment$/, handler: postJobEnvironment },
  // It spawns git and gh, so it takes the token like a POST.
  { method: 'GET', path: '/doctor', guards: ['read', 'token'], handler: getDoctor },
  { method: 'GET', path: '/doctor/bundle', guards: ['read', 'token'], handler: getSupportBundle },
  // It spawns gh and spends the login's GitHub rate limit, so it takes the token like a POST.
  { method: 'GET', path: '/github/preview', guards: ['read', 'token'], handler: getGitHubPreview },
  { method: 'POST', path: '/jobs', handler: postJob },
  { method: 'GET', path: /^\/jobs\/([A-Za-z0-9._-]+)$/, guards: ['read'], handler: getJob },
  { method: 'GET', path: /^\/jobs\/([A-Za-z0-9._-]+)\/transcript$/, guards: ['read', 'token'], handler: getTranscript },
  { method: 'GET', path: /^\/jobs\/([A-Za-z0-9._-]+)\/transcript\/events$/, guards: ['read', 'queryToken'], handler: getTranscriptEvents },
  { method: 'GET', path: /^\/jobs\/([A-Za-z0-9._-]+)\/(file|raw)$/, guards: ['read'], handler: getJobFile },
  { method: 'POST', path: '/requests', handler: postRequest },
  { method: 'POST', path: '/config', handler: postConfig },
  { method: 'POST', path: '/budget/ack', handler: postBudgetAck },
  { method: 'POST', path: '/daemon/permission', handler: postPermission },
  { method: 'POST', path: '/daemon/mode', handler: postDaemonMode },
  { method: 'POST', path: '/daemon', handler: postDaemon },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/effort$/, handler: postJobEffort },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/budget$/, handler: postJobBudget },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/delete$/, handler: postJobDelete },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/merge$/, handler: postJobMerge },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/repos$/, handler: postJobRepos },
  { method: 'GET', path: /^\/mandates\/([^/]+)\/draft$/, guards: ['read'], handler: getMandateDraft },
  // Filing runs in the handler: the tracker methods are synchronous by contract.
  { method: 'POST', path: /^\/mandates\/([^/]+)\/draft$/, handler: postMandateDraft },
  { method: 'POST', path: '/focus', handler: postFocus },
  { method: 'POST', path: /^\/jobs\/([^/]+)\/(run|editor)$/, handler: postRunOrEditor },
];

/** A project route's prefix: the segment (validated later by PROJECT_NAME) and the path PROJECT_ROUTES match. */
const PROJECT_PREFIX = /^\/api\/p\/([^/]+)(\/.*)$/;

/**
 * The first row whose method is `method` and whose path matches `pathname`: a string path by
 * equality, a RegExp with its capture groups as `params`. Null when nothing matches, or for no method.
 */
export function matchRoute<C>(routes: readonly Route<C>[], method: string | undefined, pathname: string): { route: Route<C>; params: string[] } | null {
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

/** One startServer call's machine state: nothing per-server lives at module level, since a test process runs several servers. */
function createMachine(opts: ServerOptions): MachineCtx & { entries: ReturnType<typeof createEntries> } {
  let entries: ReturnType<typeof createEntries> | null = null;
  const machine = {
    opts,
    home: opts.home ?? forgeHome(),
    token: crypto.randomBytes(16).toString('hex'),
    distDir: distDirFor(opts),
    notBuilt: opts.dev ? DEV_NOT_BUILT : NOT_BUILT,
    github: opts.github ?? ghGitHub,
    projects: opts.projectsDir ?? claudeProjectsDir(),
    // Once per server: finding the commit can spawn git, and /api/about takes no token. The running
    // code's commit can't change under a live server (`forge update` restarts the dashboard).
    provenance: versionInfo(PLUGIN_ROOT),
    /** Open event streams and what each follows; MAX_SSE_CLIENTS counts them all, across projects. */
    clients: new Map<http.ServerResponse, string>(),
    ping: null,
    // The settings value is read at each index refresh, never per call.
    slots: createMachineSlots(() => entries?.setting() ?? null),
  } as MachineCtx & { entries: ReturnType<typeof createEntries> };
  entries = createEntries(machine);
  machine.entries = entries;
  return machine;
}

const noProject = (segment: string): string => JSON.stringify({ error: `no registered project ${JSON.stringify(segment.slice(0, 64))}` } satisfies ApiError);

/**
 * Read-mostly, localhost-only server for every project registered on the machine. POSTs need the
 * per-process token embedded in the page, so another site in the same browser cannot enqueue work or
 * start a pool. `distDir` is a test seam like `sseMaxAgeMs`; it defaults to the plugin's
 * dashboard/dist, or to the dev build under `dev`.
 */
export function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const machine = createMachine(opts);
  const host = opts.host ?? '127.0.0.1';

  const server = http.createServer(async (req, res) => {
    if (opts.onRequest) observeRequest(req, res, opts.onRequest);
    try {
      // The bind is 127.0.0.1; this holds if that ever changes.
      if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, 403, 'text/plain', 'not loopback');
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, 'text/plain', 'misdirected request');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const scoped = PROJECT_PREFIX.exec(url.pathname);
      const hit = scoped ? matchRoute(PROJECT_ROUTES, req.method, scoped[2]!) : matchRoute(ROUTES, req.method, url.pathname);
      if (!hit) return send(res, 404, 'text/plain', 'not found');
      // Every guard runs before the project is resolved, so a cross-site or untokened request never reads the index.
      if (hit.route.method === 'POST' && guardPost(req, res, machine.token)) return;
      for (const g of hit.route.guards ?? []) if (GUARDS[g](machine, req, res, url)) return;
      const match = { url, params: hit.params };
      if (!scoped) return await (hit.route as Route<MachineCtx>).handler(machine, req, res, match);
      const entry = machine.entries.resolve(scoped[1]!);
      if (!entry) return send(res, 404, 'application/json', noProject(scoped[1]!));
      await (hit.route as Route<ServerCtx>).handler(entry.ctx, req, res, match);
    } catch (e) {
      if (res.headersSent) return void res.end();
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message } satisfies ApiError));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7400, host, () => {
      // Loaded only once the port is ours, so a dash retrying ports never starts a pool.
      machine.entries.start();
      // Only a non-dev `forge dash` passes keepAwake, so no test or dev dashboard holds the machine awake.
      const awake = opts.keepAwake && !opts.dev ? startKeepAwake(machine.entries, machine.home, opts.keepAwake) : null;
      const close = async () => {
        awake?.close();
        if (machine.ping) clearInterval(machine.ping);
        machine.ping = null;
        await machine.entries.close();
        for (const c of machine.clients.keys()) c.end();
        machine.clients.clear();
        await new Promise((r) => {
          server.close(() => r(undefined));
          server.closeAllConnections?.();
        });
      };
      resolve({
        server,
        url: `http://${host}:${(server.address() as AddressInfo).port}`,
        entry: (name) => machine.entries.get(name),
        entries: () => machine.entries.list(),
        onProject: (fn) => machine.entries.onProject(fn),
        refresh: () => machine.entries.refresh(true),
        booted: () => machine.entries.booted(),
        close,
        killSync: () => {
          awake?.killSync();
          machine.entries.killSync();
        },
      });
    });
  });
}
