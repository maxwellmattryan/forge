import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { daemonProblems, loadConfig, resolveEffort, validateConfig } from './config.ts';
import { ConfigSetError, FIELDS } from './config-fields.ts';
import { setConfigValue } from './config-set.ts';
import { PERMISSION_MODES, UUID, logBaseOf, readInfo, readLogPage, sessionFiles } from './daemon.ts';
import type { DaemonOptions } from './daemon.ts';
import { createPool } from './daemon-pool.ts';
import type { DaemonPool, PoolState } from './daemon-pool.ts';
import { doctor } from './doctor.ts';
import { createPreviewer, ghRunner, parseGitHubUrl } from './github-preview.ts';
import type { GhRunner } from './github-preview.ts';
import { daemonSessionIds, jobSessionEnv, ownerStatusWithProof } from './daemon-owner.ts';
import { RUNNING_AGENT_MAX_MS, createJob, listJobs, loadJob, ownerStatus, progress, readEvents, jobDir, requestBody, setJobEffort } from './jobs.ts';
import { normalizeRef } from './issue-link.ts';
import { paths, exists, DEV_DIST_DIR, PLUGIN_ROOT } from './paths.ts';
import { API_VERSION, CONFIG_SCHEMA_VERSION, EFFORTS, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from './schema.ts';
import { computeStats } from './stats.ts';
import { listRuns, listTasks, compareRuns, forgeVersion } from './evals.ts';
import { INBOX_SCOPE, OFFICE_SCOPE, enqueue, listRequests, validJobId, validScope } from './requests.ts';
import { gateOwner } from './foreman.ts';
import { loadTracker } from './trackers/index.ts';
import { roster } from './roster.ts';
import { deriveTitle, normalizeTitle } from './title.ts';
import { agentTranscript, cachedActivity, claudeProjectsDir, openTranscript, ownerTranscript } from './transcripts.ts';
import type { TranscriptHit } from './transcripts.ts';
import { getPath, readJson, readText } from './util.ts';
import type {
  AboutResponse,
  AgentActivity,
  AgentRow,
  ApiError,
  ApiState,
  BacklogResponse,
  ConfigResponse,
  DaemonLogPage,
  DaemonPoolState,
  DaemonSessionState,
  DoctorResponse,
  EvalsResponse,
  GitHubPreviewResponse,
  ForgeTruncatedLine,
  JobDetail,
  JobEvent,
  JobSource,
  LoadedJob,
  PermissionDecision,
  PostConfigResponse,
  PostDaemonModeResponse,
  PostJobEffortResponse,
  PostJobResponse,
  PostRequestResponse,
  TranscriptPage,
} from './types.ts';

/** startServer's options. `distDir` is a test seam like `sseMaxAgeMs`. */
export interface ServerOptions {
  port?: number;
  host?: string;
  daemon?: DaemonOptions;
  sseMaxAgeMs?: number;
  ssePingMs?: number;
  distDir?: string;
  /**
   * Set only by `forge dash --dev` (what `npm run dev` runs): serve the watching dev build and leave
   * the daemon off until Start. No config key or /api route reaches it.
   */
  dev?: boolean;
  /** Test seam: what runs gh for GitHub previews. */
  ghRun?: GhRunner;
  /** Test seam: Claude Code's projects dir (claudeProjectsDir() by default). */
  projectsDir?: string;
}

/** A listening dashboard server: what startServer resolves to. */
export interface RunningServer {
  server: http.Server;
  url: string;
  pool: DaemonPool;
  close: () => Promise<void>;
}

const TEXT_EXT = new Set(['.md', '.log', '.patch', '.diff', '.json', '.jsonl', '.txt', '.yml', '.yaml', '.html']);
const MAX_FILE = 2 * 1024 * 1024;
// Raster formats only: SVG can carry script, so it is never served as an image.
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_IMAGE = 10 * 1024 * 1024;
// Mockups must be self-contained (inline script and style, data: images and fonts), and the frame makes
// no network request, so an agent misled into writing secrets into a mockup can't send them anywhere.
const RAW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const MAX_SCREENSHOTS = 200;
/** The newest requests a job's Thread shows. */
const MAX_JOB_REQUESTS = 50;
const MAX_REQUEST_EXCERPT = 2000;
const MAX_SSE_CLIENTS = 8;
const SSE_SLOW_CLIENT_BYTES = 1024 * 1024;
const SSE_MAX_LINE = 64 * 1024;
const SSE_PING_MS = 15_000;
// Streams are recycled (EventSource reconnects with Last-Event-ID), so an idle tab can't hold one
// of the few slots forever.
const SSE_MAX_AGE_MS = 5 * 60_000;
/** A transcript stream starts with at most this much of the file's end. */
const TRANSCRIPT_TAIL_BYTES = 64 * 1024;
/** How much of a transcript one poll (or a Last-Event-ID resume) reads at most. */
const TRANSCRIPT_READ_BYTES = 1024 * 1024;
const TRANSCRIPT_POLL_MS = 1000;
const NO_TRANSCRIPT = 'no transcript';
const DIST_DIR = path.join(PLUGIN_ROOT, 'dashboard', 'dist');
const NOT_BUILT = 'dashboard is not built: run npm run build:dashboard';
const DEV_NOT_BUILT = 'dashboard dev build is not ready: npm run dev is still building it; reload in a moment';
const DIST_ASSET = /^assets\/[\w.-]+\.(js|css|woff2)$/;
const DIST_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2' };

/** The build a server reads its page and assets from: an explicit test dir, the dev build, or dist/. */
export function distDirFor(opts: ServerOptions): string {
  return opts.distDir ?? (opts.dev ? DEV_DIST_DIR : DIST_DIR);
}

/**
 * Read-mostly, localhost-only server. POSTs need the per-process token embedded in the page,
 * so another site in the same browser cannot enqueue work or start the daemon.
 * `distDir` is a test seam like `sseMaxAgeMs`; it defaults to the plugin's committed dashboard/dist, or to
 * the dev build under `dev`.
 */
export function startServer(root: string, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = crypto.randomBytes(16).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  const distDir = distDirFor(opts);
  const notBuilt = opts.dev ? DEV_NOT_BUILT : NOT_BUILT;
  const previewGitHub = createPreviewer({ run: opts.ghRun ?? ghRunner(root) });
  const projects = opts.projectsDir ?? claudeProjectsDir();
  let backlogCache: { at: number; data: BacklogResponse } | null = null;
  /** Open event streams and the session each one follows; MAX_SSE_CLIENTS counts them all. */
  const clients = new Map<http.ServerResponse, string>();
  let pool: DaemonPool | null = null;
  let ping: NodeJS.Timeout | null = null;
  const poolState = (): DaemonPoolState => ({ ...(pool ? pool.state() : idlePoolState(root)), clients: clients.size });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, 'text/plain', 'misdirected request');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, token, distDir, notBuilt);
      // Re-read per request so a rebuild under a running `forge dash` is picked up; the manifest is
      // tiny. The pathname is never decoded or joined: lookup is by exact string.
      if (req.method === 'GET' && p.startsWith('/assets/')) {
        const hit = distAllowlist(distDir).get(p);
        return hit ? immutable(res, hit) : send(res, 404, 'text/plain', 'not found');
      }
      if (req.method === 'GET' && p === '/forge.png') return sendFile(res, path.join(PLUGIN_ROOT, 'assets', 'forge.png'), 'image/png');
      if (req.method === 'GET' && p === '/api/state') return json(res, state(root, poolState(), projects));
      if (req.method === 'GET' && p === '/api/events') return events(req, res, url);
      if (req.method === 'GET' && p === '/api/daemons/log') return sessionLog(req, res, url);
      if (req.method === 'GET' && p === '/api/stats') return json(res, computeStats(root, { since: url.searchParams.get('since') ?? undefined }));
      if (req.method === 'GET' && p === '/api/evals') return json(res, { tasks: listTasks(root).map(({ dir: _d, request: _r, ...t }) => t), runs: listRuns(root) } satisfies EvalsResponse);
      if (req.method === 'GET' && p === '/api/evals/compare') return json(res, compareRuns(root, url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? ''));
      if (req.method === 'GET' && p === '/api/requests') return json(res, listRequests(root));
      if (req.method === 'GET' && p === '/api/roster') return json(res, roster(root, loadConfig(root).config));
      if (req.method === 'GET' && p === '/api/backlog') {
        if (!backlogCache || Date.now() - backlogCache.at > 60_000 || url.searchParams.has('refresh')) {
          const { config } = loadConfig(root);
          try {
            const tracker = await loadTracker(root, config);
            backlogCache = { at: Date.now(), data: { tracker: tracker.name, items: tracker.list({ root, config }, { limit: 200 }) } };
          } catch (e) {
            backlogCache = { at: Date.now(), data: { tracker: config.tracker.kind, items: [], error: (e as Error).message } };
          }
        }
        return json(res, backlogCache.data);
      }
      if (req.method === 'GET' && p === '/api/config') return json(res, configResponse(root, Boolean(pool?.state().wanted)));
      if (req.method === 'GET' && p === '/api/about') return json(res, about());
      if (req.method === 'GET' && p === '/api/doctor') {
        // It spawns git and gh, so it takes the token like a POST.
        if (guardToken(req, res, token)) return;
        const { config, initialized } = loadConfig(root);
        return json(res, { ...(await doctor(root, config, initialized)), at: new Date().toISOString() } satisfies DoctorResponse);
      }
      if (req.method === 'GET' && p === '/api/github/preview') {
        // It spawns gh and spends the login's GitHub rate limit, so it takes the token like a POST.
        if (guardToken(req, res, token)) return;
        const target = parseGitHubUrl(url.searchParams.get('url') ?? '');
        if (!target) return jsonStatus(res, 400, { error: 'not a GitHub repository, pull request, issue or commit URL' });
        return json(res, (await previewGitHub(target)) satisfies GitHubPreviewResponse);
      }
      if (req.method === 'POST' && p === '/api/jobs') {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const { config, initialized } = loadConfig(root);
        if (!initialized) return jsonStatus(res, 409, { error: 'Forge is not set up in this repo: run /forge init first' });
        const input = jobInput(parsed.body);
        if ('error' in input) return jsonStatus(res, 400, { error: input.error });
        // The text goes only to request.md (and, through the title, job.json and events.jsonl); the
        // queued resume carries none, so it never reaches a daemon session's stdin, argv or env.
        const job = createJob(root, config, { title: input.title, body: input.text, origin: 'dashboard', slug: hasSlugText(input.title) ? undefined : 'request' });
        const request = enqueue(root, config, { type: 'resume', job: job.id, text: null, args: { intake: 'new' }, from: 'dashboard' });
        pool?.poke();
        return json(res, { id: job.id, title: job.title, branch: job.branch, request, daemon: Boolean(pool?.state().wanted) } satisfies PostJobResponse);
      }
      const m = p.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)(\/file|\/raw|\/transcript|\/transcript\/events)?$/);
      if (req.method === 'GET' && m) {
        const id = m[1];
        // The detail's owner proof can spawn `ps`, so other sites may not trigger it (as for the log routes).
        if (!m[2]) return readGuard(req, res) ? undefined : json(res, jobDetail(root, id, projects));
        if (m[2] === '/transcript') return transcriptPage(req, res, id, url);
        if (m[2] === '/transcript/events') return transcriptEvents(req, res, id, url);
        const rel = url.searchParams.get('path') ?? '';
        const file = safeJoin(jobDir(root, id), rel);
        if (file && m[2] === '/file' && IMAGE_TYPES[path.extname(file).toLowerCase()]) return sendImage(res, jobDir(root, id), file);
        if (!file || !exists(file) || !TEXT_EXT.has(path.extname(file))) return send(res, 404, 'text/plain', 'not found');
        if (m[2] === '/raw') {
          res.setHeader('Content-Security-Policy', RAW_CSP);
          return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(file));
        }
        const size = fs.statSync(file).size;
        const text = size > MAX_FILE ? `…truncated (${size} bytes); showing the last 2 MB…\n` + readTail(file, MAX_FILE) : readText(file);
        return send(res, 200, 'text/plain; charset=utf-8', text);
      }
      if (req.method === 'POST' && p === '/api/requests') {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const body: Record<string, any> = parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body) ? parsed.body : {};
        // Only the CLI's park and sync paths write gate requests: they carry the reserved check's result.
        if (body.type === 'gate') return jsonStatus(res, 400, { error: 'gate requests are written only by forge job set and forge pr sync' });
        const problem = requestArgsProblem(body);
        if (problem) return jsonStatus(res, 400, { error: problem });
        const held = resumeHeld(root, body);
        if (held) return jsonStatus(res, 409, { error: held });
        const { config } = loadConfig(root);
        const rec = enqueue(root, config, { type: body.type, job: body.job, text: body.text, args: body.args, from: 'dashboard' });
        pool?.poke();
        return json(res, { ...rec, daemon: Boolean(pool?.state().wanted) } satisfies PostRequestResponse);
      }
      if (req.method === 'POST' && p === '/api/config') {
        if (guardPost(req, res, token)) return;
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return jsonStatus(res, 400, { error: 'body is not JSON' });
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.key !== 'string' || !Object.prototype.hasOwnProperty.call(body, 'value'))
          return jsonStatus(res, 400, { error: 'body must be {"key": string, "value": …}' });
        // A change would trip the daemon's trust check mid-turn, and only a human may restart it.
        if (pool?.state().wanted) return jsonStatus(res, 409, { error: DAEMON_LOCK });
        try {
          const r = setConfigValue(root, body.key, body.value);
          if (r.changed) backlogCache = null;
          return json(res, r satisfies PostConfigResponse);
        } catch (e) {
          if (e instanceof ConfigSetError) return jsonStatus(res, CONFIG_STATUS[e.reason], { error: e.message });
          throw e;
        }
      }
      if (req.method === 'POST' && p === '/api/daemon/permission') {
        if (guardPost(req, res, token)) return;
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
        if (!pool?.answerPermission(obj.scope, obj.id, obj.decision)) return jsonStatus(res, 404, { error: 'that permission prompt is gone: already answered, or its session stopped' });
        return json(res, poolState());
      }
      if (req.method === 'POST' && p === '/api/daemon/mode') {
        if (guardPost(req, res, token)) return;
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return jsonStatus(res, 400, { error: 'body is not JSON' });
        }
        const obj = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
        if (!validScope(obj.scope)) return jsonStatus(res, 400, { error: 'scope must be "_inbox", "_office" or a job id' });
        if (obj.scope !== INBOX_SCOPE && obj.scope !== OFFICE_SCOPE && !exists(path.join(jobDir(root, obj.scope), 'job.json'))) return jsonStatus(res, 404, { error: `no job ${obj.scope}` });
        if (!PERMISSION_MODES.includes(obj.mode)) return jsonStatus(res, 400, { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` });
        // Only a value from that fixed list travels on, to the supervisor's memory and the session's stdin.
        const r = pool?.setPermissionMode(obj.scope, obj.mode) ?? { error: 'the daemon pool is not ready' };
        if (r.error) return jsonStatus(res, 409, { error: r.error });
        return json(res, poolState() satisfies PostDaemonModeResponse);
      }
      if (req.method === 'POST' && p === '/api/daemon') {
        if (guardPost(req, res, token)) return;
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
            await pool?.stopSession(obj.scope);
            return json(res, poolState());
          }
          if (pool?.startSession(obj.scope).error) return jsonStatus(res, 409, { error: 'start the daemon first' });
          return json(res, poolState());
        }
        if (action === 'stop') {
          await pool?.stop('http');
          return json(res, poolState());
        }
        const { config } = loadConfig(root);
        if (config.daemon?.enabled !== true) return jsonStatus(res, 409, { error: 'daemon.enabled is false in .forge/config.yml' });
        const problem = daemonProblems(config, root)[0];
        if (problem) return jsonStatus(res, 409, { error: problem });
        pool?.start('http');
        return json(res, poolState());
      }
      const em = p.match(/^\/api\/jobs\/([^/]+)\/effort$/);
      if (req.method === 'POST' && em) {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        // `_inbox` is not a job id, so it is a 404 like any unknown job.
        const id = em[1];
        if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
        const body = parsed.body;
        const effort = body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'effort') ? (body as Record<string, unknown>).effort : undefined;
        if (effort !== null && !(EFFORTS as readonly unknown[]).includes(effort)) return jsonStatus(res, 400, { error: `effort must be one of ${EFFORTS.join(', ')}, or null` });
        // No DAEMON_LOCK: job.json is outside the trust digest, and a running session picks the level up at its next spawn.
        return json(res, setJobEffort(root, id, effort as PostJobEffortResponse['effort'], 'dashboard') satisfies PostJobEffortResponse);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      if (res.headersSent) return void res.end();
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message } satisfies ApiError));
    }
  });

  /**
   * Server-sent events for one session: its state, then its buffered log lines, then live ones,
   * each with its log offset as the id. GET only and loopback-only like every route; readGuard
   * keeps other sites out. A cross-site request from a browser that sends no Fetch Metadata can
   * still hold a slot until the stream is recycled (sseMaxAgeMs), which costs the live log's
   * availability, never the daemon.
   */
  function events(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (readGuard(req, res)) return;
    const scope = url.searchParams.get('session');
    // Syntax only, so the logs of deleted jobs stay viewable.
    if (!validScope(scope)) return jsonStatus(res, 400, { error: 'session must be "_inbox", "_office" or a job id' });
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    clients.set(res, scope);
    res.write(stateFrame(pool ? pool.sessionState(scope) : offSessionState(root, scope)));
    const last = Number(req.headers['last-event-id']);
    for (const r of pool?.recent(scope, req.headers['last-event-id'] === undefined || !Number.isFinite(last) ? undefined : last) ?? []) res.write(lineFrame(r.offset, r.line));
    const recycle = setTimeout(() => res.end(), opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
    recycle.unref();
    // The response's close, not the request's: a GET's request side ends as soon as it is read.
    res.on('close', () => {
      clearTimeout(recycle);
      clients.delete(res);
    });
    startPing();
  }

  function startPing(): void {
    if (ping) return;
    ping = setInterval(() => broadcast(clients, ': ping\n\n'), opts.ssePingMs ?? SSE_PING_MS);
    ping.unref();
  }

  /**
   * The transcript a transcript route asked for, located from job state only: `agent` must be an own
   * key of job.agents, and without it the owner must be an interactive session. No query value is
   * ever used as a path or a path segment. Null for anything else, which the routes answer with 404.
   */
  function locateTranscript(id: string, url: URL): { hit: TranscriptHit; source: 'agent' | 'owner'; role: string | null } | null {
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
  function transcriptPage(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): void {
    if (readGuard(req, res) || guardToken(req, res, token)) return;
    const rawBefore = url.searchParams.get('before');
    const before = rawBefore === null || rawBefore === '' ? null : Number(rawBefore);
    if (before !== null && !(Number.isSafeInteger(before) && before >= 0)) return jsonStatus(res, 400, { error: 'before must be a transcript offset' });
    const found = locateTranscript(id, url);
    const t = found ? openTranscript(found.hit, projects) : null;
    if (!found || !t) return jsonStatus(res, 404, { error: NO_TRANSCRIPT });
    try {
      const page = readLogPage(t.fd, t.size, 0, { before });
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
  function transcriptEvents(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): void {
    if (readGuard(req, res)) return;
    if (!tokenMatches(url.searchParams.get('token'), token)) return send(res, 403, 'text/plain', 'bad token');
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    const found = locateTranscript(id, url);
    const t = found ? openTranscript(found.hit, projects) : null;
    if (!found || !t) return jsonStatus(res, 404, { error: NO_TRANSCRIPT });
    const fd = t.fd;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    clients.set(res, `transcript:${id}:${found.role ?? 'owner'}`);
    const last = Number(req.headers['last-event-id']);
    const resume = req.headers['last-event-id'] !== undefined && Number.isSafeInteger(last) && last >= 0 && last < t.size && t.size - last <= TRANSCRIPT_READ_BYTES;
    // From Last-Event-ID, the line at that offset is the one the client has: skip it.
    let pos = resume ? last : Math.max(0, t.size - TRANSCRIPT_TAIL_BYTES);
    let skipPartial = resume || pos > 0;
    if (pos > 0 && !resume) pos -= 1;
    let size = t.size;
    let closed = false;
    const pump = (): void => {
      if (closed) return;
      try {
        const now = fs.fstatSync(fd).size;
        if (now < size) {
          // Truncated or rewritten: start over.
          pos = 0;
          skipPartial = false;
        }
        size = now;
        while (pos < size) {
          const len = Math.min(size - pos, TRANSCRIPT_READ_BYTES);
          const buf = Buffer.alloc(len);
          const n = fs.readSync(fd, buf, 0, len, pos);
          if (n <= 0) break;
          const chunk = buf.subarray(0, n);
          const lastNl = chunk.lastIndexOf(0x0a);
          if (lastNl === -1) {
            // No complete line yet: wait for it, unless one line is over the read cap.
            if (n < TRANSCRIPT_READ_BYTES) break;
            if (!skipPartial) res.write(lineFrame(pos, JSON.stringify({ type: 'forge-truncated', originalType: null, bytes: n } satisfies ForgeTruncatedLine)));
            skipPartial = true;
            pos += n;
            continue;
          }
          let at = 0;
          while (at <= lastNl) {
            const nl = chunk.indexOf(0x0a, at);
            if (skipPartial) skipPartial = false;
            else {
              const line = chunk.subarray(at, nl).toString('utf8');
              if (line.trim()) res.write(lineFrame(pos + at, line));
            }
            at = nl + 1;
          }
          pos += lastNl + 1;
          if (res.writableLength > SSE_SLOW_CLIENT_BYTES) return void res.end();
        }
      } catch {
        res.end();
      }
    };
    pump();
    const poll = setInterval(pump, TRANSCRIPT_POLL_MS);
    poll.unref();
    const recycle = setTimeout(() => res.end(), opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
    recycle.unref();
    res.on('close', () => {
      closed = true;
      clearInterval(poll);
      clearTimeout(recycle);
      clients.delete(res);
      fs.closeSync(fd);
    });
    startPing();
  }

  /**
   * GET /api/daemons/log: a page of one session's log, read backwards from `before`. The scope is
   * validated before any path is built, the file must resolve inside the daemons dir, and it is
   * read through one non-blocking descriptor checked to be a regular file.
   */
  function sessionLog(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (readGuard(req, res)) return;
    const scope = url.searchParams.get('session');
    if (!validScope(scope)) return jsonStatus(res, 400, { error: 'session must be "_inbox", "_office" or a job id' });
    const rawBefore = url.searchParams.get('before');
    const before = rawBefore === null || rawBefore === '' ? null : Number(rawBefore);
    if (before !== null && !(Number.isSafeInteger(before) && before >= 0)) return jsonStatus(res, 400, { error: 'before must be a log offset' });
    const f = sessionFiles(root, scope);
    const empty: DaemonLogPage = { scope, lines: [], start: 0, end: 0, more: false };
    let real: string;
    let dir: string;
    try {
      dir = fs.realpathSync(f.dir);
      real = fs.realpathSync(f.log);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return json(res, empty);
      return jsonStatus(res, 404, { error: 'no session log' });
    }
    // The daemons dir itself must be where it should be: a symlinked .forge/runtime or daemons
    // dir would otherwise move the confinement root somewhere else.
    const expected = path.join(fs.realpathSync(root), path.relative(root, f.dir));
    if (dir !== expected || !real.startsWith(dir + path.sep)) return jsonStatus(res, 404, { error: 'no session log' });
    let fd: number | undefined;
    try {
      // O_NONBLOCK: a FIFO planted as the log must not hang the server; fstat rejects it.
      // `real` is fully resolved, so O_NOFOLLOW only refuses a link swapped in since the check.
      fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) return jsonStatus(res, 404, { error: 'no session log' });
      const page = readLogPage(fd, stat.size, logBaseOf(readInfo(f.info)), { before });
      return json(res, { scope, ...page } satisfies DaemonLogPage);
    } catch {
      return jsonStatus(res, 404, { error: 'no session log' });
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7400, host, () => {
      // Created only once the port is ours, so a dash retrying ports never starts a second pool.
      const d = createPool(root, opts.daemon);
      pool = d;
      // Each stream gets only its own session's lines and state.
      d.subscribe((e) => broadcast(clients, e.kind === 'line' ? lineFrame(e.offset, e.line) : stateFrame(e.state), SSE_SLOW_CLIENT_BYTES, e.scope));
      try {
        const { config } = loadConfig(root);
        // A dev dashboard often runs in a fresh clone of a repo that commits daemon.enabled: true,
        // so it never boots a paid session by itself; Start still works.
        if (!opts.dev && config.daemon?.enabled === true && !daemonProblems(config, root).length) d.start('boot');
      } catch {}
      const close = async () => {
        if (ping) clearInterval(ping);
        for (const c of clients.keys()) c.end();
        clients.clear();
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

const MAX_JOB_TEXT = 20_000;

/** POST /api/jobs: the request text and its title (the override, cleaned, or one derived from the text). */
function jobInput(body: unknown): { text: string; title: string } | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'body must be a JSON object: {"text": string, "title"?: string}' };
  const { text, title } = body as Record<string, unknown>;
  if (typeof text !== 'string' || !text.trim()) return { error: 'text must be a non-empty string' };
  if (text.length > MAX_JOB_TEXT) return { error: `text is over ${MAX_JOB_TEXT.toLocaleString('en-US')} characters` };
  if (title !== undefined && title !== null) {
    if (typeof title !== 'string') return { error: 'title must be a string' };
    const clean = normalizeTitle(title);
    return clean ? { text, title: clean } : { error: 'title is empty' };
  }
  const derived = deriveTitle(text);
  return derived ? { text, title: derived } : { error: 'the text has no words to make a title from: add a title' };
}

/** Whether slugify would find words in the title: otherwise it falls back to a bare `job-…` id. */
function hasSlugText(title: string): boolean {
  return /[a-z0-9]/.test(title.toLowerCase().normalize('NFKD'));
}

/**
 * POST /api/requests: why a resume would only bounce off a live owner, or null. Advisory: the job
 * session's own claim (inside the job lock) decides. Any `args` are ignored here, so `force` or
 * `intake` cannot switch it off. A bad or unknown id is left to enqueue and the inbox.
 */
function resumeHeld(root: string, body: Record<string, any>): string | null {
  if (body.type !== 'resume' || !validJobId(body.job) || !exists(path.join(jobDir(root, body.job), 'job.json'))) return null;
  let job: LoadedJob;
  try {
    job = loadJob(root, body.job);
  } catch {
    // A job.json from a newer Forge or a broken one: the inbox reports it, as for an unknown id.
    return null;
  }
  const o = ownerStatusWithProof(root, job, { env: jobSessionEnv(job.id) });
  if (o.status !== 'live' || o.jobSession) return null;
  const held = o.agentRunning ? `claimed ${o.since}; an agent is still running` : `claimed ${o.since}, last active ${o.heartbeat}`;
  return `job ${job.id} is held by session ${o.session} (${held}); resume it from that session or wait until it stops`;
}

/** POST /api/requests: the args a request type may carry beyond what enqueue checks. Null when fine. */
function requestArgsProblem(body: Record<string, any>): string | null {
  const args = body.args;
  // The inbox session puts a run's ref on `forge job from-ref <ref>`, so it is checked here, not only in the bar.
  if (body.type === 'run' && !normalizeRef(args?.ref)) return 'args.ref must be an issue ref';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (Object.prototype.hasOwnProperty.call(args, 'link')) {
    if (body.type !== 'approve') return 'args.link is only for approve requests';
    if (args.link !== 'new' && args.link !== 'none' && !normalizeRef(args.link)) return 'args.link must be "new", "none" or an issue ref';
  }
  if (Object.prototype.hasOwnProperty.call(args, 'n')) {
    if (body.type !== 'next') return 'args.n is only for next requests';
    if (!Number.isInteger(args.n) || args.n < 1 || args.n > 16) return 'args.n must be an integer from 1 to 16';
  }
  return null;
}

const PERMISSION_DECISIONS: readonly PermissionDecision[] = ['allow', 'session', 'deny'];

const DAEMON_LOCK = 'stop the daemon first: any change to .forge/config.yml stops it, and only a human may start it again';
const CONFIG_STATUS: Record<ConfigSetError['reason'], number> = { unknown: 400, invalid: 400, locked: 403, uninitialized: 409, 'unsupported-yaml': 409 };

function configResponse(root: string, daemonWanted: boolean): ConfigResponse {
  const { config, initialized } = loadConfig(root);
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, getPath(config, f.key) ?? null]));
  const lockedBy = !initialized ? 'uninitialized' : daemonWanted ? 'daemon' : null;
  return { initialized, path: '.forge/config.yml', fields: FIELDS, values, problems: initialized ? validateConfig(config, root) : [], writable: lockedBy === null, lockedBy };
}

/** Read per request: both files are tiny, and a plugin update under a running dash shows up. */
function about(): AboutResponse {
  const plugin = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {});
  const pricing = readJson(path.join(PLUGIN_ROOT, 'lib', 'pricing.json'), {});
  const link = plugin.homepage ?? plugin.repository;
  const repo = typeof link === 'string' ? link : typeof link?.url === 'string' ? link.url : null;
  return {
    forgeVersion: forgeVersion(),
    apiVersion: API_VERSION,
    pluginRoot: PLUGIN_ROOT,
    schemaVersions: { config: CONFIG_SCHEMA_VERSION, job: JOB_SCHEMA_VERSION, event: EVENT_SCHEMA_VERSION },
    pricingAsOf: typeof pricing.asOf === 'string' ? pricing.asOf : null,
    node: process.versions.node,
    links: { repo, docs: repo ? `${repo.replace(/\/$/, '')}/tree/main/docs` : null },
  };
}

/** A session's state before the pool exists (never visible once the server is listening). */
function offSessionState(_root: string, scope: string): DaemonSessionState {
  return { scope, wanted: false, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false, lastError: null, permissions: [], permissionMode: null, kept: null, effort: null };
}

/** The pool block before a pool exists (never visible once the server is listening). */
function idlePoolState(root: string): PoolState {
  return { enabled: false, wanted: false, maxConcurrent: 1, live: 0, lastError: null, inbox: offSessionState(root, INBOX_SCOPE), office: offSessionState(root, OFFICE_SCOPE), foreman: false, jobs: {}, permissionMode: 'default', permissionModes: {} };
}

/**
 * Token, then Origin, then JSON: the checks every POST shares. Returns true when it has
 * already answered the request.
 */
function guardPost(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
  if (req.headers['x-forge-token'] !== token) return send(res, 403, 'text/plain', 'bad token'), true;
  if (!req.headers.origin || !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'text/plain', 'json only'), true;
  return false;
}

/** The token, plus a same-origin Origin when one is sent: for GETs that do work. */
function guardToken(req: http.IncomingMessage, res: http.ServerResponse, token: string): boolean {
  if (req.headers['x-forge-token'] !== token) return send(res, 403, 'text/plain', 'bad token'), true;
  if (req.headers.origin !== undefined && !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  return false;
}

/**
 * The checks every streaming or log-reading GET shares: an Origin, when sent, must be ours, and a
 * request the browser labels cross-site through Fetch Metadata is refused. A no-cors request from
 * another site (fetch no-cors, <img>, <script>) carries no Origin, which is why the second check
 * exists. There are no CORS headers, so another site can't read the reply either way. Returns
 * true when it has already answered the request.
 */
function readGuard(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined && !sameOrigin(origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return send(res, 403, 'text/plain', 'cross-site'), true;
  return false;
}

function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function stateFrame(st: DaemonSessionState): string {
  return `event: state\ndata: ${JSON.stringify(st)}\n\n`;
}

/**
 * Lines are single-line JSON already; a stray CR would still end an SSE field, so it goes.
 */
function lineFrame(offset: number, line: string): string {
  let data = line.replace(/\r/g, '');
  const bytes = Buffer.byteLength(data);
  if (bytes > SSE_MAX_LINE) {
    let originalType: string | null = null;
    try {
      originalType = JSON.parse(data)?.type ?? null;
    } catch {}
    data = JSON.stringify({ type: 'forge-truncated', originalType, bytes } satisfies ForgeTruncatedLine);
  }
  return `event: line\nid: ${offset}\ndata: ${data}\n\n`;
}

type SseClient = { write: (s: string) => unknown; end: () => unknown; writableLength: number };

/**
 * Writes a frame to every client (in a Map, only those following `scope`) and ends any whose
 * unsent buffer is over the cap, so one stalled browser tab can't grow the server's memory; it
 * reconnects with Last-Event-ID.
 */
export function broadcast<C extends SseClient>(clients: Set<C> | Map<C, string>, frame: string, capBytes = SSE_SLOW_CLIENT_BYTES, scope?: string): void {
  for (const res of [...clients.keys()]) {
    if (scope !== undefined && clients instanceof Map && clients.get(res) !== scope) continue;
    res.write(frame);
    if (res.writableLength > capBytes) {
      clients.delete(res);
      res.end();
    }
  }
}

function isLoopbackHost(host: string | undefined): boolean {
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function state(root: string, daemons: DaemonPoolState, projects: string): ApiState {
  const { config, initialized } = loadConfig(root);
  const requests = listRequests(root);
  const jobs = listJobs(root).map((j) => {
    const events = readEvents(root, j.id);
    const last = events[events.length - 1] ?? null;
    // The time rule only, so polling never spawns `ps`; the job detail adds the daemon proofs.
    return { ...j, progress: progress(root, j.id), lastEvent: last, eventCount: events.length, ownerStatus: ownerStatus(j), activity: jobActivity(root, j, projects), gateOwner: gateOwner(root, config, j, requests) };
  });
  return {
    apiVersion: API_VERSION,
    forgeVersion: forgeVersion(),
    repo: { name: paths(root).repoName },
    initialized,
    config: {
      base: config.git.base,
      tracker: config.tracker.kind,
      panel: config.review.panel.map((r) => r.name),
      pipeline: config.pipeline,
      models: config.runtime.models,
      daemon: { enabled: config.daemon?.enabled === true },
      // Validated, so an invalid runtime.effort reads as none here while validate and doctor report it.
      effort: resolveEffort(config).level,
    },
    // `enabled` and the cap from this read of config.yml, so they are current even while the pool is stopped.
    daemons: { ...daemons, enabled: config.daemon?.enabled === true, foreman: config.foreman?.enabled === true, maxConcurrent: validCap(config.daemon?.maxConcurrent) ?? daemons.maxConcurrent },
    jobs,
    requests: requests.filter((r) => r.status === 'pending' || r.status === 'in-progress'),
    now: new Date().toISOString(),
  };
}

const startMs = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);
const newestFirst = (a: { startedAt?: string | null }, b: { startedAt?: string | null }): number => (startMs(b.startedAt) || 0) - (startMs(a.startedAt) || 0);

/**
 * One line per running agent (under ownerStatus's 2 h ceiling), newest first, each with what its
 * transcript says it did last. The tail read is bounded and cached, so the 2 s poll stays cheap.
 */
function jobActivity(root: string, job: LoadedJob, projects: string, at = Date.now()): AgentActivity[] {
  const out: AgentActivity[] = [];
  for (const [role, a] of Object.entries(job.agents ?? {})) {
    if (a?.status !== 'running' || !(at - startMs(a.startedAt) < RUNNING_AGENT_MAX_MS)) continue;
    const hit = agentTranscript(root, job, role, { projects });
    out.push({ role, model: a.model ?? null, startedAt: a.startedAt ?? null, last: hit ? cachedActivity(hit, projects, { worktree: job.worktree, root }) : null });
  }
  return out.sort(newestFirst);
}

/** The current round's agent records plus any still running, newest first, with each run's tokens from its agent-end event. */
function roundAgents(root: string, job: LoadedJob, events: JobEvent[], projects: string): AgentRow[] {
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
function interactiveOwner(root: string, job: LoadedJob, projects: string): (TranscriptHit & { session: string }) | null {
  const sid = job.owner?.session;
  if (typeof sid !== 'string' || !UUID.test(sid) || daemonSessionIds(root).includes(sid)) return null;
  const hit = ownerTranscript(root, job, { projects });
  return hit ? { ...hit, session: sid } : null;
}

/** The SSE token from a query parameter, compared in constant time. */
function tokenMatches(given: string | null, token: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validCap(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}

function jobDetail(root: string, id: string, projects: string): JobDetail {
  const job = loadJob(root, id);
  const dir = jobDir(root, id);
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && TEXT_EXT.has(path.extname(e.name)) && !['job.json', 'events.jsonl', 'runtime.json'].includes(e.name))
        files.push(path.relative(dir, full));
    }
  };
  walk(dir, 0);
  const order = ['request.md', 'plan.md', 'spec.md', 'design.md', 'mockup.html', 'questions.md', 'tasks.md', 'build.md', 'verify/', 'review/', 'decision.md', 'runbook.md', 'pr.md', 'pr-feedback.md', 'feedback.md', 'eval-judge.md'];
  const rank = (f: string) => {
    const i = order.findIndex((o) => (o.endsWith('/') ? f.startsWith(o) : f === o));
    return i === -1 ? (f.startsWith('logs/') ? 1000 : 500) : i;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
  const events = readEvents(root, id);
  // `forge job link` and `--create` set job.source later, so only the source at creation says request.md is tracker text.
  const createdSource = events.find((e) => e.type === 'created')?.source as Partial<JobSource> | null | undefined;
  return {
    job: { ...job, progress: progress(root, id), ownerStatus: ownerStatusWithProof(root, job, { env: jobSessionEnv(job.id) }) },
    events: events.slice(-400),
    files,
    screenshots: listScreenshots(dir),
    requests: listRequests(root).filter((r) => r.job === id).slice(-MAX_JOB_REQUESTS),
    request: requestExcerpt(root, id),
    requestFromTracker: Boolean(createdSource?.ref),
    agents: roundAgents(root, job, events, projects),
    ownerTranscript: ((o) => (o ? { session: o.session } : null))(interactiveOwner(root, job, projects)),
  };
}

/** request.md without its `# title` line, for the Thread's opening message; null when empty. */
function requestExcerpt(root: string, id: string): string | null {
  const body = requestBody(root, id);
  if (!body) return null;
  return body.length > MAX_REQUEST_EXCERPT ? `${body.slice(0, MAX_REQUEST_EXCERPT)}…` : body;
}

/**
 * Images under the job's `screenshots/` dir, as paths relative to the job dir. Symlinks are
 * skipped (`isFile()` is false for them), so the list never points outside the job.
 */
function listScreenshots(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 2) walk(full, depth + 1);
      else if (e.isFile() && IMAGE_TYPES[path.extname(e.name).toLowerCase()]) out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(dir, 'screenshots'), 0);
  return out.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).slice(0, MAX_SCREENSHOTS);
}

/**
 * Screenshots are agent-written files, so they are confined twice: the request path must sit under
 * `screenshots/`, and the resolved file (after symlinks) must stay inside the job dir.
 */
function sendImage(res: http.ServerResponse, base: string, file: string): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  // The Host check can't stop another site from embedding an <img> of this URL; CORP makes the
  // browser refuse cross-origin loads, so screenshots of real data never reach a foreign page.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (path.relative(base, file).split(path.sep)[0] !== 'screenshots') return send(res, 404, 'text/plain', 'not found');
  let reply: [number, string, string | Buffer] = [404, 'text/plain', 'not found'];
  let fd: number | undefined;
  try {
    // Resolve once, then check, stat and read through one descriptor, so a symlink swapped in
    // between the check and the read can't redirect it.
    const real = fs.realpathSync(file);
    if (real.startsWith(fs.realpathSync(base) + path.sep)) {
      // O_NONBLOCK: opening a FIFO planted under screenshots/ must not hang the server; fstat rejects it.
      // `real` is fully resolved, so O_NOFOLLOW only refuses a link swapped in since the check.
      fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = fs.fstatSync(fd);
      if (stat.isFile() && stat.size > MAX_IMAGE) reply = [413, 'text/plain', 'image too large'];
      else if (stat.isFile()) reply = [200, IMAGE_TYPES[path.extname(file).toLowerCase()], fs.readFileSync(fd)];
    }
  } catch {
    // A missing file, a dangling link or an unreadable one is simply not there.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return send(res, ...reply);
}

function safeJoin(base: string, rel: string): string | null {
  if (!rel || rel.includes('\0')) return null;
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.min(bytes, size));
  fs.readSync(fd, buf, 0, buf.length, size - buf.length);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

/** A POST body parsed as JSON, or the 400 message: never a 500 for a client's mistake. */
async function readJsonBody(req: http.IncomingMessage): Promise<{ body: unknown } | { error: string }> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    return { error: (e as Error).message };
  }
  try {
    return { body: JSON.parse(raw || '{}') };
  } catch {
    return { error: 'body is not JSON' };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/**
 * The URL paths the dashboard may serve from dist/, keyed `/assets/<file>`. The Vite manifest is
 * the allowlist and nothing under dashboard/ is served by directory, so sources, the manifest and
 * the rest of the plugin root never are. Entries that aren't plain `assets/<file>.js|css|woff2`
 * names are dropped (the vendored fonts are the only woff2; SVG and HTML never qualify), and a
 * missing or unparseable manifest allows nothing.
 */
export function distAllowlist(distDir: string): Map<string, { file: string; type: string }> {
  const out = new Map<string, { file: string; type: string }>();
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(distDir, 'manifest.json'), 'utf8'));
  } catch {
    return out;
  }
  if (!manifest || typeof manifest !== 'object') return out;
  const assetsDir = path.join(distDir, 'assets') + path.sep;
  const accept = (s: unknown) => {
    if (typeof s !== 'string') return;
    const m = DIST_ASSET.exec(s);
    if (!m) return;
    const file = path.resolve(distDir, s);
    if (!file.startsWith(assetsDir)) return;
    out.set('/' + s, { file, type: DIST_TYPES[m[1]] });
  };
  // Raw JSON from the build: each entry is checked before it is used.
  for (const entry of Object.values<any>(manifest)) {
    if (!entry || typeof entry !== 'object') continue;
    accept(entry.file);
    for (const k of ['css', 'assets']) if (Array.isArray(entry[k])) entry[k].forEach(accept);
  }
  return out;
}

function page(res: http.ServerResponse, token: string, distDir: string, notBuilt: string): void {
  let html;
  try {
    // The page loads only manifest files, so it counts as built only when both exist.
    if (!exists(path.join(distDir, 'manifest.json'))) throw new Error('no manifest');
    html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 503, 'text/plain', notBuilt);
  }
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'text/html; charset=utf-8', html.replace('__FORGE_TOKEN__', token));
}

/** Hashed file names change with their content, so they are cached for good. */
function immutable(res: http.ServerResponse, hit: { file: string; type: string }): void {
  let body;
  try {
    body = fs.readFileSync(hit.file);
  } catch {
    // Removed mid-rebuild: the next page load names the new files.
    return send(res, 404, 'text/plain', 'not found');
  }
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  send(res, 200, hit.type, body);
}

function sendFile(res: http.ServerResponse, file: string, type: string): void {
  res.setHeader('Cache-Control', 'max-age=86400');
  send(res, 200, type, fs.readFileSync(file));
}

function json(res: http.ServerResponse, data: unknown): void {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));
}

function jsonStatus(res: http.ServerResponse, status: number, data: ApiError): void {
  res.setHeader('Cache-Control', 'no-store');
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

function send(res: http.ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
