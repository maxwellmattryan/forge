// The dashboard's HTTP server (`forge dash`): the `/api` endpoints, server-sent events and the
// built dashboard, for loopback Hosts only, with token- and Origin-checked POSTs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { daemonProblems, loadConfig, resolveEffort, validateConfig } from '../core/config/load.ts';
import { allKnownValues, isPrivateJobFile, isPrivateName, knownValues, redactDeep, redactKnown, scopeKnownValues } from '../engine/guard/known-secrets.ts';
import { ConfigSetError, FIELDS } from '../core/config/fields.ts';
import { dashboardActor } from '../integrations/github/actor.ts';
import { setConfigValue } from '../core/config/set.ts';
import { PERMISSION_MODES } from '../office/session/lifecycle.ts';
import { UUID, logBaseOf, readInfo, readLogPage, sessionFiles } from '../core/job/session-files.ts';
import { createPool } from '../office/pool.ts';
import type { DaemonPool, PoolState } from '../office/pool.ts';
import { buildBundle, bundleFileName } from '../engine/ops/bundle.ts';
import { doctor } from '../engine/ops/doctor.ts';
import { containedWorktree, editorArgv, openEditor } from '../engine/workspace/editor.ts';
import { readSmallJson } from '../core/job/focus.ts';
import { CheckoutError } from '../engine/workspace/checkout.ts';
import { InactiveJobError, currentFocus, focusJob } from '../engine/workspace/focus-actions.ts';
import { recordEnvironmentStopped } from '../engine/environment/lifecycle.ts';
import { createPreviewer, ghRunner, parseGitHubUrl } from '../integrations/github/preview.ts';
import type { GhRunner } from '../integrations/github/preview.ts';
import { daemonSessionIds } from '../office/owner.ts';
import { AGENT_LEASE_MS, createJob, isActive, leaseStatus, listJobs, loadJob, progress, readEvents, jobDir, requestBody, setJob, setJobEffort } from '../core/job/store.ts';
import { deleteJob, deleteRefusal } from '../engine/ops/delete.ts';
import { decideRepoProposals, isRepoProposalPark } from '../engine/project/repo-proposals.ts';
import { REPO_NAME } from '../engine/project/member-repos.ts';
import { parseIssueRef } from '../core/job/issue-ref.ts';
import { paths, exists, BUILD_DASHBOARD, DEV_DIST_DIR, PLUGIN_ROOT } from '../core/paths.ts';
import { API_VERSION, CONFIG_SCHEMA_VERSION, EFFORTS, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from '../core/job/schema.ts';
import { computeStats } from '../engine/metrics/stats.ts';
import { projectGraph } from '../engine/project/graph.ts';
import { RepoBudgetAckError, ackRepoBudget, repoBudgetStatus, validPeriod } from '../engine/metrics/repo-budget.ts';
import { jobBudgetOf } from '../engine/metrics/budget.ts';
import { listRuns, listTasks, compareRuns, forgeVersion } from '../engine/evals/run.ts';
import { INBOX_SCOPE, JOBS_SCOPE, OFFICE_SCOPE, enqueue, listRequests, validJobId, validScope } from '../core/job/requests.ts';
import { foremanHandoff, gateOwner } from '../office/foreman.ts';
import { loadTracker } from '../engine/trackers/load.ts';
import { roster } from '../engine/pipeline/roster.ts';
import { readTriageCache } from '../engine/trackers/triage.ts';
import { deriveTitle, normalizeTitle } from '../engine/ops/title.ts';
import { agentTranscript, cachedActivity, claudeProjectsDir, openTranscript, ownerTranscript } from '../integrations/claude/transcripts.ts';
import type { TranscriptHit } from '../integrations/claude/transcripts.ts';
import { redactContext, redactText } from '../engine/guard/redact.ts';
import { getPath, isMap } from '../core/shape.ts';
import { ForgeError } from '../core/errors.ts';
import { pidAlive } from '../core/os/process.ts';
import { readJson, readText } from '../core/os/fs.ts';
import { versionInfo } from '../engine/ops/version.ts';
import { commandTemplate, startBackground, stopDevProven } from '../engine/workspace/worktree.ts';
import { jobEndpoints } from '../engine/environment/endpoints.ts';
import { containerName, entriesOrNone, isManaged, projectSlug } from '../engine/environment/backing.ts';
import { dockerSpawn } from '../integrations/docker/runner.ts';
import { DOCKER_NAME, environmentsSnapshot, forgeJson, jobEnvironment, openConfinedLog, openDevLog } from '../engine/environment/status.ts';
import { zip } from '../core/format/zip.ts';
import type {
  AboutResponse,
  AgentActivity,
  AgentRow,
  ApiError,
  DeleteJobResult,
  ApiState,
  BackingEntry,
  BacklogResponse,
  Config,
  EnvironmentAction,
  EnvironmentsResponse,
  EnvironmentTarget,
  JobEnvironmentResponse,
  PostEnvironmentResponse,
  ConfigResponse,
  DaemonLogPage,
  DaemonPoolState,
  DaemonSessionState,
  DoctorResponse,
  Endpoint,
  EvalsResponse,
  ProjectResponse,
  FocusResponse,
  GitHubPreviewResponse,
  ForgeTruncatedLine,
  JobDetail,
  JobEvent,
  LastHuman,
  LoadedJob,
  PermissionDecision,
  PostBudgetAckResponse,
  PostConfigResponse,
  PostDaemonModeResponse,
  PostEditorResponse,
  PostJobEffortResponse,
  PostJobReposResponse,
  PostJobResponse,
  PostRequestResponse,
  PostRunResponse,
  RepoBudgetStatus,
  RequestInfo,
  TranscriptPage,
  VersionInfo,
} from '../core/types.ts';

/** startServer's options. `distDir` is a test seam like `sseMaxAgeMs`. */
export interface ServerOptions {
  port?: number;
  host?: string;
  daemon?: import('../office/modes.ts').PoolOptions;
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
  /**
   * Called once per request when its response finishes or closes early. Only `forge dash`'s activity
   * log sets it (lib/cli/activity.ts); it observes requests and never changes a response.
   */
  onRequest?: (r: RequestInfo) => void;
}

/** The pathname for the activity log, from a URL whose Host may be bad (that request is still reported). */
function logPath(raw: string | undefined): string {
  try {
    return new URL(raw ?? '/', 'http://x').pathname;
  } catch {
    return '/';
  }
}

/**
 * An event stream's head. Set through setHeader rather than writeHead's object, so getHeader still
 * reads the Content-Type afterwards and the activity log can tell a stream from a request.
 */
function sseHead(res: http.ServerResponse): void {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.writeHead(200);
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

/** A listening dashboard server: what startServer resolves to. */
export interface RunningServer {
  server: http.Server;
  url: string;
  pool: DaemonPool;
  close: () => Promise<void>;
}

const TEXT_EXT = new Set(['.md', '.log', '.patch', '.diff', '.json', '.jsonl', '.txt', '.yml', '.yaml', '.html']);
const MAX_FILE = 2 * 1024 * 1024;
/** POST /api/jobs/:id/repos: the longest note it records. */
const REPO_NOTE_MAX = 2000;
/** A decision lists at most this many repos: more than any project has members. */
const REPO_LIST_MAX = 100;
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
/** How long /api/state reuses the repo budget status. */
const BUDGET_MEMO_MS = 5000;
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
/** How long GET /api/jobs/:id/environment reuses a job's environment. */
const ENV_MEMO_MS = 2000;
/** How long GET /api/environments reuses its snapshot. */
const ENVS_CACHE_MS = 5000;
const ENV_STATUS_TIMEOUT_MS = 10_000;
/** `backing up` may pull images: lib/engine/environment/backing.ts's RUN_TIMEOUT_MS plus a margin. */
const BACKING_UP_TIMEOUT_MS = 11 * 60_000;
const BACKING_STOP_TIMEOUT_MS = 60_000;
/** An environment log frame carries at most this many characters of one line. */
const TEXT_FRAME_MAX = 16384;
const ENV_ACTIONS: readonly EnvironmentAction[] = ['start', 'stop', 'restart'];
const NO_TRANSCRIPT = 'no transcript';
const DIST_DIR = path.join(PLUGIN_ROOT, 'dashboard', 'dist');
const NOT_BUILT = `dashboard is not built: run ${BUILD_DASHBOARD}`;
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
 * `distDir` is a test seam like `sseMaxAgeMs`; it defaults to the plugin's dashboard/dist, or to
 * the dev build under `dev`.
 */
export function startServer(root: string, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = crypto.randomBytes(16).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  const distDir = distDirFor(opts);
  const notBuilt = opts.dev ? DEV_NOT_BUILT : NOT_BUILT;
  const previewGitHub = createPreviewer({ run: opts.ghRun ?? ghRunner(root) });
  const projects = opts.projectsDir ?? claudeProjectsDir();
  // Once per server: finding the commit can spawn git, and /api/about takes no token. The running
  // code's commit can't change under a live server (`forge update` restarts the dashboard).
  const provenance = versionInfo(PLUGIN_ROOT);
  let backlogCache: { at: number; data: BacklogResponse } | null = null;
  /** Open event streams and the session each one follows; MAX_SSE_CLIENTS counts them all. */
  const clients = new Map<http.ServerResponse, string>();
  let pool: DaemonPool | null = null;
  let ping: NodeJS.Timeout | null = null;
  const poolState = (): DaemonPoolState => ({ ...(pool ? pool.state() : idlePoolState(root)), clients: clients.size });
  /**
   * The lease's driver is this job's own pool session and that session runs: a resume reaches exactly
   * it, so its live lease doesn't hold the resume. Asked of the pool, never of ps or the session records.
   */
  const ownPoolSession = (job: Pick<LoadedJob, 'id' | 'lease'>): boolean => {
    if (!pool || !job.lease.driver) return false;
    const s = pool.sessionState(job.id);
    return s.running && s.sessionId === job.lease.driver;
  };
  // Polls come every few seconds and the ledger stats every job's events, so the status is reused for 5 s.
  // write: false, so a GET never writes .forge/runtime/.
  let budgetCache: { at: number; data: RepoBudgetStatus } | null = null;
  const budget = (): RepoBudgetStatus => {
    if (!budgetCache || Date.now() - budgetCache.at > BUDGET_MEMO_MS) budgetCache = { at: Date.now(), data: repoBudgetStatus(root, loadConfig(root).config, { write: false }) };
    return budgetCache.data;
  };
  const envMemo = new Map<string, { at: number; p: Promise<JobEnvironmentResponse> }>();
  let envsCache: { at: number; p: Promise<EnvironmentsResponse> } | null = null;

  const server = http.createServer(async (req, res) => {
    if (opts.onRequest) observeRequest(req, res, opts.onRequest);
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
      if (req.method === 'GET' && p === '/api/state') return json(res, state(root, poolState(), projects, budget()));
      if (req.method === 'GET' && p === '/api/events') return events(req, res, url);
      if (req.method === 'GET' && p === '/api/daemons/log') return sessionLog(req, res, url);
      if (req.method === 'GET' && p === '/api/stats') return json(res, computeStats(root, { since: url.searchParams.get('since') ?? undefined, config: loadConfig(root).config }));
      if (req.method === 'GET' && p === '/api/evals') return json(res, { tasks: listTasks(root).map(({ dir: _d, request: _r, ...t }) => t), runs: listRuns(root) } satisfies EvalsResponse);
      if (req.method === 'GET' && p === '/api/evals/compare') return json(res, compareRuns(root, url.searchParams.get('a') ?? '', url.searchParams.get('b') ?? ''));
      if (req.method === 'GET' && p === '/api/requests') return json(res, listRequests(root));
      if (req.method === 'GET' && p === '/api/roster') return json(res, roster(root, loadConfig(root).config));
      // Read-only and a subset of /api/config (no commands, owners or notes), so it needs no token.
      if (req.method === 'GET' && p === '/api/project') return json(res, projectGraph(loadConfig(root).config) satisfies ProjectResponse);
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
        // Read per request, unlike the item list: a triage run shows on the next load, not a minute later.
        const triage = readTriageCache(root);
        const { tracker } = backlogCache.data;
        const items = backlogCache.data.items.map((item) => {
          const e = triage[`${tracker}:${item.ref}`];
          return e ? { ...item, triage: { ready: e.ready, missing: e.missing, at: e.at } } : item;
        });
        return json(res, { ...backlogCache.data, items } satisfies BacklogResponse);
      }
      if (req.method === 'GET' && p === '/api/config') return json(res, configResponse(root, Boolean(pool?.state().wanted)));
      if (req.method === 'GET' && p === '/api/about') return json(res, about(provenance));
      if (req.method === 'GET' && p === '/api/environments') return environments(req, res);
      const envm = p.match(/^\/api\/jobs\/([^/]+)\/environment(\/logs)?$/);
      if (envm && req.method === 'GET') return envm[2] ? environmentLogs(req, res, envm[1], url) : environmentGet(req, res, envm[1]);
      if (envm && req.method === 'POST' && !envm[2]) return environmentPost(req, res, envm[1]);
      if (req.method === 'GET' && p === '/api/doctor') {
        // It spawns git and gh, so it takes the token like a POST.
        if (guardToken(req, res, token)) return;
        const { config, initialized } = loadConfig(root);
        return json(res, { ...(await doctor(root, config, initialized)), at: new Date().toISOString() } satisfies DoctorResponse);
      }
      if (req.method === 'GET' && p === '/api/doctor/bundle') return supportBundle(req, res, url);
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
        if (!m[2]) return readGuard(req, res) ? undefined : json(res, jobDetail(root, id, projects, ownPoolSession));
        if (m[2] === '/transcript') return transcriptPage(req, res, id, url);
        if (m[2] === '/transcript/events') return transcriptEvents(req, res, id, url);
        const rel = url.searchParams.get('path') ?? '';
        const file = safeJoin(jobDir(root, id), rel);
        // Private job files hold credentials: not served under any path that names them or links to them.
        if (!file || isPrivateJobFile(file)) return send(res, 404, 'text/plain', 'not found');
        if (m[2] === '/file' && IMAGE_TYPES[path.extname(file).toLowerCase()]) return sendImage(res, jobDir(root, id), file);
        if (!exists(file) || !TEXT_EXT.has(path.extname(file))) return send(res, 404, 'text/plain', 'not found');
        // Background logs are written by the child itself, so known values are taken out here.
        const known = knownValues(root, id, loadConfig(root).config);
        if (m[2] === '/raw') {
          res.setHeader('Content-Security-Policy', RAW_CSP);
          const raw = fs.readFileSync(file);
          return send(res, 200, 'text/html; charset=utf-8', known.length ? redactKnown(raw.toString('utf8'), known) : raw);
        }
        const size = fs.statSync(file).size;
        const text = size > MAX_FILE ? `…truncated (${size} bytes); showing the last 2 MB…\n` + readTail(file, MAX_FILE) : readText(file);
        return send(res, 200, 'text/plain; charset=utf-8', redactKnown(text, known));
      }
      if (req.method === 'POST' && p === '/api/requests') {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const body: Record<string, any> = parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body) ? parsed.body : {};
        // Only the CLI's park and sync paths write gate requests: they carry the reserved check's result.
        if (body.type === 'gate') return jsonStatus(res, 400, { error: 'gate requests are written only by forge job set and forge pr sync' });
        const problem = requestArgsProblem(body, loadConfig(root).config.tracker.kind);
        if (problem) return jsonStatus(res, 400, { error: problem });
        const held = resumeHeld(root, body, ownPoolSession);
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
          const r = setConfigValue(root, body.key, body.value, dashboardActor);
          if (r.changed) backlogCache = null;
          return json(res, r satisfies PostConfigResponse);
        } catch (e) {
          if (e instanceof ConfigSetError) return jsonStatus(res, CONFIG_STATUS[e.reason], { error: e.message });
          throw e;
        }
      }
      // Not blocked by the daemon lock: an ack is an audit line, never a config.yml change.
      if (req.method === 'POST' && p === '/api/budget/ack') {
        if (guardPost(req, res, token)) return;
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return jsonStatus(res, 400, { error: 'body is not JSON' });
        }
        const period = body && typeof body === 'object' && !Array.isArray(body) ? body.period : undefined;
        if (!validPeriod(period)) return jsonStatus(res, 400, { error: 'period must be the current UTC month (YYYY-MM) or day (YYYY-MM-DD)' });
        try {
          const r = ackRepoBudget(root, loadConfig(root).config, period, null, dashboardActor());
          budgetCache = { at: Date.now(), data: r.status };
          pool?.poke();
          return json(res, r.status satisfies PostBudgetAckResponse);
        } catch (e) {
          if (e instanceof RepoBudgetAckError) return jsonStatus(res, e.reason === 'within' ? 409 : 400, { error: e.message });
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
        if (!pool?.answerPermission(obj.scope, obj.id, obj.decision, dashboardActor())) return jsonStatus(res, 404, { error: 'that permission prompt is gone: already answered, or its session stopped' });
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
        const jobs = obj.scope === JOBS_SCOPE;
        if (!jobs && !validScope(obj.scope)) return jsonStatus(res, 400, { error: 'scope must be "_inbox", "_office", "_jobs" or a job id' });
        if (!jobs && obj.scope !== INBOX_SCOPE && obj.scope !== OFFICE_SCOPE && !exists(path.join(jobDir(root, obj.scope), 'job.json'))) return jsonStatus(res, 404, { error: `no job ${obj.scope}` });
        if (!PERMISSION_MODES.includes(obj.mode)) return jsonStatus(res, 400, { error: `mode must be one of ${PERMISSION_MODES.join(', ')}` });
        // Only a value from that fixed list travels on, to the supervisor's memory and the session's stdin.
        const r = (jobs ? pool?.setJobPermissionMode(obj.mode, dashboardActor()) : pool?.setPermissionMode(obj.scope, obj.mode, dashboardActor())) ?? { error: 'the daemon pool is not ready' };
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
      const dm = p.match(/^\/api\/jobs\/([^/]+)\/delete$/);
      if (req.method === 'POST' && dm) {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const id = dm[1];
        if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
        // The id typed back: a stray or replayed click never deletes a job the human did not name.
        if (!isMap(parsed.body) || parsed.body.confirm !== id) return jsonStatus(res, 400, { error: 'body must be {"confirm": "<the job id>"}' });
        const { config } = loadConfig(root);
        // The job's own dashboard session is the one thing the delete may stop, and only once nothing else refuses it.
        const refusal = deleteRefusal(root, loadJob(root, id), listJobs(root), { stopsDaemon: true });
        if (refusal) return jsonStatus(res, 409, { error: `cannot delete ${id}: ${refusal}` });
        await pool?.dropSession(id);
        try {
          return json(res, (await deleteJob(root, config, id, { trigger: 'dashboard', actor: dashboardActor() })) satisfies DeleteJobResult);
        } catch (e) {
          if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
          throw e;
        }
      }
      const rm = p.match(/^\/api\/jobs\/([^/]+)\/repos$/);
      if (req.method === 'POST' && rm) {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const id = rm[1];
        if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
        const body = parsed.body;
        if (!isMap(body) || (body.decision !== 'approve' && body.decision !== 'reject')) return jsonStatus(res, 400, { error: 'body must be {"decision": "approve"|"reject", "repos": [names], "note"?: string}' });
        const repos = body.repos;
        if (!Array.isArray(repos) || !repos.length || repos.length > REPO_LIST_MAX || !repos.every((r) => typeof r === 'string' && REPO_NAME.test(r))) return jsonStatus(res, 400, { error: `repos must be a list of 1 to ${REPO_LIST_MAX} repo names: the proposals you decide` });
        const note = body.note;
        if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > REPO_NOTE_MAX)) return jsonStatus(res, 400, { error: `note must be a string of at most ${REPO_NOTE_MAX} characters, or null` });
        let decided: ReturnType<typeof decideRepoProposals>;
        try {
          // Exactly the repos the drawer listed, or 409: a repo proposed since, or hidden from repo-proposals.json, is never approved unseen.
          decided = decideRepoProposals(root, loadConfig(root).config, id, body.decision, { repos: repos as string[], exact: true, note: (note as string | null | undefined) ?? null, actor: dashboardActor() });
        } catch (e) {
          if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
          throw e;
        }
        let resumed = false;
        if (!decided.pending.length && isRepoProposalPark(loadJob(root, id))) {
          setJob(root, id, { state: 'running' });
          // A live session that holds the job picks the decision up at its next step.
          if (resumeHeld(root, { type: 'resume', job: id }, ownPoolSession) === null) {
            enqueue(root, null, { type: 'resume', job: id, from: 'dashboard' });
            pool?.poke();
            resumed = true;
          }
        }
        return json(res, { ...decided, resumed } satisfies PostJobReposResponse);
      }
      if (req.method === 'POST' && p === '/api/focus') {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const body = parsed.body;
        const raw = isMap(body) && Object.hasOwn(body, 'job') ? body.job : undefined;
        const job = typeof raw === 'string' ? raw : null;
        if (raw !== null && job === null) return jsonStatus(res, 400, { error: 'body must be {"job": "<id>"} or {"job": null}' });
        if (job !== null && !validJobId(job)) return jsonStatus(res, 400, { error: 'invalid job id' });
        if (job !== null && !exists(path.join(jobDir(root, job), 'job.json'))) return jsonStatus(res, 404, { error: `no job ${job}` });
        try {
          return json(res, (await focusJob(root, job, 'dashboard', dashboardActor())) satisfies FocusResponse);
        } catch (e) {
          if (e instanceof InactiveJobError || e instanceof CheckoutError) return jsonStatus(res, 409, { error: e.message });
          if (e instanceof ForgeError && (e.code === 'not_found' || e.code === 'usage')) return jsonStatus(res, e.code === 'not_found' ? 404 : 400, { error: e.message });
          throw e;
        }
      }
      const jm = p.match(/^\/api\/jobs\/([^/]+)\/(run|editor)$/);
      if (req.method === 'POST' && jm) {
        if (guardPost(req, res, token)) return;
        const parsed = await readJsonBody(req);
        if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
        const id = jm[1];
        if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
        if (!isMap(parsed.body)) return jsonStatus(res, 400, { error: 'body must be a JSON object' });
        const job = loadJob(root, id);
        const { config } = loadConfig(root);
        return jm[2] === 'run' ? runDev(res, config, job, parsed.body) : editor(res, config, job);
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      if (res.headersSent) return void res.end();
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message } satisfies ApiError));
    }
  });

  /**
   * Starts the job's dev command, or reports the live one: the only command the dashboard may run,
   * and only in the job's own worktree (containedWorktree), since job.json is agent-writable.
   */
  async function runDev(res: http.ServerResponse, config: Config, job: LoadedJob, body: Record<string, unknown>): Promise<void> {
    if (body.command !== 'dev') return jsonStatus(res, 400, { error: 'command must be "dev"' });
    if (!isActive(job)) return jsonStatus(res, 409, { error: `job ${job.id} is ${job.state}; only an active job's dev server can be started` });
    if (!job.worktree || !containedWorktree(root, config, job)) return jsonStatus(res, 409, { error: `job ${job.id} has no worktree inside the worktrees root` });
    try {
      const r = await startBackground(root, config, job.id, 'dev');
      return json(res, { reused: r.reused, listening: r.listening, port: r.port } satisfies PostRunResponse);
    } catch (e) {
      if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
      throw e;
    }
  }

  /** Opens the job's contained worktree in FORGE_EDITOR (default `code`): a fixed argv, no shell. */
  async function editor(res: http.ServerResponse, config: Config, job: LoadedJob): Promise<void> {
    const dir = containedWorktree(root, config, job);
    if (!dir) return jsonStatus(res, 409, { error: `job ${job.id} has no worktree inside the worktrees root` });
    let argv: string[];
    try {
      argv = editorArgv(process.env);
    } catch (e) {
      return jsonStatus(res, 409, { error: (e as Error).message });
    }
    try {
      await openEditor(argv, dir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const error = code === 'ENOENT' ? `no editor "${argv[0]}" found: set FORGE_EDITOR to your editor's command` : `cannot start editor "${argv[0]}": ${(e as Error).message}`;
      return jsonStatus(res, 409, { error });
    }
    return json(res, { ok: true, editor: argv[0] } satisfies PostEditorResponse);
  }

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
    // Before the headers: an unreadable config then fails the request instead of a half-open stream.
    const known = scopeKnownValues(root, scope, loadConfig(root).config);
    sseHead(res);
    res.write('retry: 3000\n\n');
    clients.set(res, scope);
    res.write(stateFrame(pool ? pool.sessionState(scope) : offSessionState(root, scope), known));
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
  function transcriptEvents(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): void {
    if (readGuard(req, res)) return;
    if (!tokenMatches(url.searchParams.get('token'), token)) return send(res, 403, 'text/plain', 'bad token');
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    const found = locateTranscript(id, url);
    const t = found ? openTranscript(found.hit, projects) : null;
    if (!found || !t) return jsonStatus(res, 404, { error: NO_TRANSCRIPT });
    const fd = t.fd;
    const known = knownReader(id);
    sseHead(res);
    res.write('retry: 3000\n\n');
    clients.set(res, `transcript:${id}:${found.role ?? 'owner'}`);
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
    const recycle = setTimeout(() => res.end(), opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
    recycle.unref();
    res.on('close', () => {
      stop();
      clearTimeout(recycle);
      clients.delete(res);
      fs.closeSync(fd);
    });
    startPing();
  }

  /**
   * A reader of a job's known values for one open stream: a value a sink resolves while the stream is
   * open is redacted from then on. Re-read at most once a second, since a tail is hundreds of lines.
   */
  function knownReader(id: string): () => string[] {
    let cached: { at: number; values: string[] } | null = null;
    return () => {
      if (!cached || Date.now() - cached.at > 1000) cached = { at: Date.now(), values: knownValues(root, id, loadConfig(root).config) };
      return cached.values;
    };
  }

  /** The job behind an environment route, or null after answering 404. */
  function environmentJob(res: http.ServerResponse, id: string): LoadedJob | null {
    if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) {
      jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
      return null;
    }
    return loadJob(root, id);
  }

  const redactor = (config: Config) => (s: string): string => {
    try {
      return redactText(s, redactContext(root, config)).text;
    } catch {
      return 'the backing status could not be read';
    }
  };

  /** A job's environment, reused for 2 s per job: the card polls every 5 s and each read can spawn the CLI. */
  function environmentOf(config: Config, job: LoadedJob, fresh = false): Promise<JobEnvironmentResponse> {
    const hit = envMemo.get(job.id);
    if (!fresh && hit && Date.now() - hit.at < ENV_MEMO_MS) return hit.p;
    const p = jobEnvironment(root, config, job, redactor(config));
    envMemo.set(job.id, { at: Date.now(), p });
    p.catch(() => envMemo.delete(job.id));
    return p;
  }

  /** GET /api/jobs/:id/environment: the job's dev server and backing services. */
  async function environmentGet(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    if (readGuard(req, res) || guardToken(req, res, token)) return;
    const job = environmentJob(res, id);
    if (!job) return;
    return json(res, (await environmentOf(loadConfig(root).config, job)) satisfies JobEnvironmentResponse);
  }

  /**
   * POST /api/jobs/:id/environment: start, stop or restart the job's dev server or its backing services.
   * Every action needs the job's own contained worktree (job.json is agent-writable), start needs an
   * active job, and stop signals only a pid ownDevProcess proves is this job's dev server.
   */
  async function environmentPost(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
    if (guardPost(req, res, token)) return;
    const parsed = await readJsonBody(req);
    if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
    const job = environmentJob(res, id);
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
        detail = redactor(config)(typeof failed === 'string' ? failed : (r.data?.error ?? r.error ?? `forge ${args.join(' ')} failed`));
        break;
      }
    }
    const environment = await environmentOf(config, loadJob(root, job.id), true);
    return json(res, { target, action, ok, detail, environment } satisfies PostEnvironmentResponse);
  }

  /**
   * GET /api/jobs/:id/environment/logs: the dev log (`logs/dev.log`, followed like a transcript) or a
   * managed backing container's `docker logs --follow`, as SSE frames whose data is a JSON string of one
   * line. `source` is validated before anything is opened or spawned: `dev`, or `backing:<name>` for a
   * managed entry in config, whose container name is derived from config and the job id, never from
   * the query. The container must read as this job's (or this project's) in `backing status`.
   */
  async function environmentLogs(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL): Promise<void> {
    if (readGuard(req, res)) return;
    if (!tokenMatches(url.searchParams.get('token'), token)) return send(res, 403, 'text/plain', 'bad token');
    const job = environmentJob(res, id);
    if (!job) return;
    const { config } = loadConfig(root);
    const source = url.searchParams.get('source') ?? '';
    let entry: BackingEntry | null = null;
    let container: string | null = null;
    if (source !== 'dev') {
      const name = source.startsWith('backing:') ? source.slice('backing:'.length) : null;
      entry = name === null ? null : (entriesOrNone(config).find((e) => e.name === name && isManaged(e)) ?? null);
      container = entry ? containerName(entry.isolation === 'shared' ? projectSlug(root, config) : id, entry.name) : null;
      if (!entry || !container || !DOCKER_NAME.test(container)) return jsonStatus(res, 400, { error: 'source must be "dev" or "backing:<name>" for a backing service Forge runs' });
    }
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    const scope = `env:${id}:${source}`;
    if (source === 'dev') {
      const opened = openDevLog(root, id);
      if (typeof opened === 'string') return jsonStatus(res, 404, { error: 'no dev log' });
      const fd = opened.fd;
      const known = knownReader(id);
      sseHead(res);
      res.write('retry: 3000\n\n');
      clients.set(res, scope);
      const stop = followFd(
        res,
        fd,
        opened.size,
        req.headers['last-event-id'],
        (offset, line) => res.write(textFrame(offset, redactKnown(line, known()))),
        (offset, bytes) => res.write(textFrame(offset, `… a line of ${bytes} bytes was skipped`)),
      );
      const recycle = setTimeout(() => res.end(), opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
      recycle.unref();
      res.on('close', () => {
        stop();
        clearTimeout(recycle);
        clients.delete(res);
        fs.closeSync(fd);
      });
      return startPing();
    }
    // A client that leaves during the status call has already fired `close`, so the handler below would
    // never run: its slot and its `docker logs --follow` child would outlive it.
    let gone = false;
    res.once('close', () => (gone = true));
    const status = await forgeJson(root, ['backing', 'status', id], ENV_STATUS_TIMEOUT_MS);
    if (gone || res.destroyed) return;
    const svc = Array.isArray(status.data?.services) ? status.data.services.find((s: any) => s?.name === entry!.name) : null;
    if (!svc || (svc.state !== 'running' && svc.state !== 'stopped')) return jsonStatus(res, 409, { error: `container ${container} is ${svc?.state ?? 'unknown'}: its logs are not shown` });
    // Checked again: the status call above took time, and other streams may have opened meanwhile.
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    sseHead(res);
    res.write('retry: 3000\n\n');
    clients.set(res, scope);
    const known = knownReader(id);
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
    const recycle = setTimeout(finish, opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
    recycle.unref();
    res.on('close', () => {
      ended = true;
      clearTimeout(recycle);
      clients.delete(res);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    });
    startPing();
  }

  /** GET /api/environments: every running environment, reused for 5 s, with one computation shared by concurrent callers. */
  async function environments(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (readGuard(req, res) || guardToken(req, res, token)) return;
    if (!envsCache || Date.now() - envsCache.at > ENVS_CACHE_MS) {
      const p = environmentsSnapshot(root, loadConfig(root).config);
      envsCache = { at: Date.now(), p };
      p.catch(() => {
        if (envsCache?.p === p) envsCache = null;
      });
    }
    return json(res, (await envsCache.p) satisfies EnvironmentsResponse);
  }

  /**
   * GET /api/daemons/log: a page of one session's log, read backwards from `before`, through the
   * rotated `<scope>.log.1` once paging reaches the start of `<scope>.log` (offsets below logBase).
   * The scope is validated before any path is built, and each file is opened by openConfinedLog.
   */
  function sessionLog(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    if (readGuard(req, res)) return;
    const scope = url.searchParams.get('session');
    if (!validScope(scope)) return jsonStatus(res, 400, { error: 'session must be "_inbox", "_office" or a job id' });
    const rawBefore = url.searchParams.get('before');
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

  /**
   * GET /api/doctor/bundle: the support bundle `forge doctor --bundle` writes, as a download. It
   * spawns git and gh and reads job logs, so it takes the token header (never a query parameter)
   * on top of the read guard. The job id is validated before any path is built, and the dashboard
   * never gets agent text: any other parameter, include-text among them, is ignored.
   */
  async function supportBundle(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (readGuard(req, res) || guardToken(req, res, token)) return;
    const job = url.searchParams.get('job');
    if (job !== null && !validJobId(job)) return jsonStatus(res, 400, { error: 'job must be a job id' });
    if (job !== null && !exists(path.join(jobDir(root, job), 'job.json'))) return jsonStatus(res, 404, { error: 'no such job' });
    const { config, initialized } = loadConfig(root);
    try {
      const date = new Date();
      const { entries } = await buildBundle(root, config, initialized, { job: job ?? undefined, includeText: false });
      const body = zip(entries, date);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${bundleFileName(date)}"`,
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      res.end(body);
    } catch (e) {
      let message = 'could not build the support bundle';
      try {
        message = redactText((e as Error).message, redactContext(root, config)).text;
      } catch {}
      jsonStatus(res, 500, { error: message });
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7400, host, () => {
      // Created only once the port is ours, so a dash retrying ports never starts a second pool.
      const d = createPool(root, opts.daemon);
      pool = d;
      // Each stream gets only its own session's lines and state.
      d.subscribe((e) => {
        let frame: string;
        try {
          frame = e.kind === 'line' ? lineFrame(e.offset, e.line) : stateFrame(e.state, scopeKnownValues(root, e.scope, loadConfig(root).config));
        } catch {
          // Unreadable config: a state frame that can't be redacted is dropped, never sent raw.
          return;
        }
        broadcast(clients, frame, SSE_SLOW_CLIENT_BYTES, e.scope);
      });
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
 * POST /api/requests: why a resume would only bounce off another driver's live lease, or null.
 * Advisory: the job session's own claim (inside the job lock) decides. Any `args` are ignored here,
 * so `force` or `intake` cannot switch it off. A bad or unknown id is left to enqueue and the inbox.
 */
function resumeHeld(root: string, body: Record<string, any>, ownPoolSession: (job: LoadedJob) => boolean): string | null {
  if (body.type !== 'resume' || !validJobId(body.job) || !exists(path.join(jobDir(root, body.job), 'job.json'))) return null;
  let job: LoadedJob;
  try {
    job = loadJob(root, body.job);
  } catch {
    // A job.json from a newer Forge or a broken one: the inbox reports it, as for an unknown id.
    return null;
  }
  const o = leaseStatus(job);
  if (o.status !== 'live' || ownPoolSession(job)) return null;
  return `job ${job.id} is held by session ${o.session} (claimed ${o.since}, lease renewed ${o.renewedAt}, until ${o.expiresAt}); resume it from that session or wait until its lease expires`;
}

/** POST /api/requests: the args a request type may carry beyond what enqueue checks. Null when fine. */
function requestArgsProblem(body: Record<string, any>, trackerKind: string): string | null {
  const args = body.args;
  // Syntax only, with no slug, so `#12` passes as it is; the CLI qualifies and checks it again.
  const isRef = (v: unknown) => parseIssueRef(v, { tracker: trackerKind, slug: null }) !== null;
  // The inbox session puts a run's ref on `forge job from-ref <ref>`, so it is checked here, not only in the bar.
  if (body.type === 'run' && !isRef(args?.ref)) return 'args.ref must be an issue ref';
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (Object.prototype.hasOwnProperty.call(args, 'link')) {
    if (body.type !== 'approve') return 'args.link is only for approve requests';
    if (args.link !== 'new' && args.link !== 'none' && !isRef(args.link)) return 'args.link must be "new", "none" or an issue ref';
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

/** A webhook's path and query are its secret (a Slack URL is a bearer token), so the dashboard gets scheme and host. */
function maskWebhooks(hooks: unknown): unknown {
  if (!Array.isArray(hooks)) return hooks;
  return hooks.map((h) => {
    // A malformed entry may be a bare URL string, so it is masked whole.
    if (!h || typeof h !== 'object' || Array.isArray(h)) return '<invalid>';
    let url = '<invalid>';
    try {
      const u = new URL(String((h as { url?: unknown }).url));
      url = `${u.protocol}//${u.host}/…`;
    } catch {}
    return { ...h, url };
  });
}

function configResponse(root: string, daemonWanted: boolean): ConfigResponse {
  const { config, initialized } = loadConfig(root);
  const values = Object.fromEntries(FIELDS.map((f) => [f.key, getPath(config, f.key) ?? null]));
  values['notify.webhooks'] = maskWebhooks(values['notify.webhooks']);
  // A command can embed a webhook URL or an auth header; the field is locked, so the dashboard never needs its text.
  if (values['notify.command'] !== null) values['notify.command'] = '<set>';
  const lockedBy = !initialized ? 'uninitialized' : daemonWanted ? 'daemon' : null;
  return { initialized, path: '.forge/config.yml', fields: FIELDS, values, problems: initialized ? validateConfig(config, root) : [], writable: lockedBy === null, lockedBy };
}

/**
 * The two files are read per request: both are tiny, and a plugin update under a running dash shows
 * up. The commit comes from `provenance`, computed once at start, so this route never spawns.
 */
function about({ commit, installedAs }: Pick<VersionInfo, 'commit' | 'installedAs'>): AboutResponse {
  const plugin = readJson(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), {});
  const pricing = readJson(path.join(PLUGIN_ROOT, 'lib', 'integrations', 'claude', 'pricing.json'), {});
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
    commit,
    installedAs,
  };
}

/** A session's state before the pool exists (never visible once the server is listening). */
function offSessionState(_root: string, scope: string): DaemonSessionState {
  return { scope, wanted: false, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, failures: 0, held: null, waiting: false, lastError: null, permissions: [], permissionMode: null, kept: null, effort: null };
}

/** The pool block before a pool exists (never visible once the server is listening). */
function idlePoolState(root: string): PoolState {
  return { enabled: false, wanted: false, maxConcurrent: 1, live: 0, lastError: null, inbox: offSessionState(root, INBOX_SCOPE), office: offSessionState(root, OFFICE_SCOPE), foreman: false, jobs: {}, permissionMode: 'default', permissionModes: {}, jobPermissionMode: null };
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

/** A log or transcript page with known values taken out of each line; offsets stay the file's. */
function redactPage<P extends { lines: { offset: number; line: string }[] }>(page: P, known: readonly string[]): P {
  return known.length ? { ...page, lines: page.lines.map((l) => ({ ...l, line: redactKnown(l.line, known) })) } : page;
}

/** A session's state as an SSE frame; its permission inputs and errors can quote a known value, so they are redacted like /api/state. */
export function stateFrame(st: DaemonSessionState, known: readonly string[]): string {
  return `event: state\ndata: ${JSON.stringify(redactDeep(st, known))}\n\n`;
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

/**
 * One line of a text log as an SSE frame: the data is a JSON string, so a CR, a `<script>` or text that
 * looks like SSE stays inside one frame and reaches the page as text. Never lineFrame, which assumes JSON lines.
 */
export function textFrame(offset: number | null, line: string): string {
  const text = line.length > TEXT_FRAME_MAX ? `${line.slice(0, TEXT_FRAME_MAX)}…` : line;
  return `${offset === null ? '' : `id: ${offset}\n`}data: ${JSON.stringify(text)}\n\n`;
}

/**
 * Follows a file through one open descriptor: its last ≤64 KiB of complete lines (or what follows
 * Last-Event-ID), then each line appended later, polled every second. `emit` gets each complete line
 * at its offset; `oversize` a line over the read cap, which is skipped. A truncated file starts over.
 * Ends the response on a read error or a slow client. Returns the function that stops the polling.
 */
function followFd(
  res: http.ServerResponse,
  fd: number,
  initialSize: number,
  lastEventId: string | string[] | undefined,
  emit: (offset: number, line: string) => void,
  oversize: (offset: number, bytes: number) => void,
): () => void {
  const last = Number(lastEventId);
  const resume = lastEventId !== undefined && Number.isSafeInteger(last) && last >= 0 && last < initialSize && initialSize - last <= TRANSCRIPT_READ_BYTES;
  // From Last-Event-ID, the line at that offset is the one the client has: skip it.
  let pos = resume ? last : Math.max(0, initialSize - TRANSCRIPT_TAIL_BYTES);
  let skipPartial = resume || pos > 0;
  if (pos > 0 && !resume) pos -= 1;
  let size = initialSize;
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
          if (!skipPartial) oversize(pos, n);
          skipPartial = true;
          pos += n;
          continue;
        }
        let at = 0;
        while (at <= lastNl) {
          const nl = chunk.indexOf(0x0a, at);
          if (skipPartial) skipPartial = false;
          else emit(pos + at, chunk.subarray(at, nl).toString('utf8'));
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
  return () => {
    closed = true;
    clearInterval(poll);
  };
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

function state(root: string, daemons: DaemonPoolState, projects: string, budget: RepoBudgetStatus): ApiState {
  const { config, initialized } = loadConfig(root);
  const requests = listRequests(root);
  const jobs = listJobs(root).map((j) => {
    const events = readEvents(root, j.id);
    const last = events[events.length - 1] ?? null;
    return { ...j, progress: progress(root, j.id), lastEvent: last, eventCount: events.length, ownerStatus: leaseStatus(j), activity: jobActivity(root, j, projects), gateOwner: gateOwner(root, config, j, requests), lastHuman: lastHuman(events), endpoints: endpointsFor(root, config, j), foremanHandoff: foremanHandoff(j, events) };
  });
  // Every string leaf: titles, events and activity lines can all carry what a command printed.
  return redactDeep<ApiState>({
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
      daemon: { enabled: config.daemon?.enabled === true, jobBudget: jobBudgetOf(config) },
      // Validated, so an invalid runtime.effort reads as none here while validate and doctor report it.
      effort: resolveEffort(config).level,
    },
    // `enabled` and the cap from this read of config.yml, so they are current even while the pool is stopped.
    daemons: { ...daemons, enabled: config.daemon?.enabled === true, foreman: config.foreman?.enabled === true, maxConcurrent: validCap(config.daemon?.maxConcurrent) ?? daemons.maxConcurrent },
    jobs,
    requests: requests.filter((r) => r.status === 'pending' || r.status === 'in-progress'),
    focus: currentFocus(root),
    budget,
    now: new Date().toISOString(),
  }, allKnownValues(root, config));
}

/**
 * A job's dev endpoint: an active job with a worktree, a valid port and a dev command configured.
 * `live` reads runtime.json without following a link or blocking on a FIFO (the job dir is
 * agent-writable) and only signals 0, so polling opens no socket and spawns nothing.
 */
function endpointsFor(root: string, config: Config, j: LoadedJob): Endpoint[] {
  if (!isActive(j) || !j.worktree) return [];
  const ep = jobEndpoints(root, config, j);
  const dev = commandTemplate(config, j, 'dev');
  // The dev command serves the first component (job.port); only that row can be live, and only once per job.
  let served = typeof dev === 'string' && dev.trim() ? ep.components.find((c) => c.port === j.port) : undefined;
  const liveNow = (): boolean => {
    const rec = readSmallJson(path.join(jobDir(root, j.id), 'runtime.json'))?.dev;
    const pid = isMap(rec) ? rec.pid : undefined;
    return pidAlive(pid);
  };
  const rows: Endpoint[] = ep.components.map((c) => {
    const live = c === served ? liveNow() : null;
    if (c === served) served = undefined;
    return { kind: 'component', name: c.name, url: `${c.url}/`, port: c.port, live };
  });
  for (const b of ep.backing) if (b.port !== null) rows.push({ kind: 'backing', name: b.name, url: null, port: b.port, live: null });
  return rows;
}

/** Who last acted on a job: its last event with an actor (already normalised by readEvents). */
function lastHuman(events: JobEvent[]): LastHuman | null {
  const e = events.findLast((x) => x.actor);
  return e?.actor ? { ts: e.ts, type: e.type, action: typeof e.action === 'string' ? e.action : null, actor: e.actor } : null;
}

const startMs = (s: string | null | undefined): number => (s ? Date.parse(s) : NaN);
const newestFirst = (a: { startedAt?: string | null }, b: { startedAt?: string | null }): number => (startMs(b.startedAt) || 0) - (startMs(a.startedAt) || 0);

/**
 * One line per running agent (under agent start's 2 h lease), newest first, each with what its
 * transcript says it did last. The tail read is bounded and cached, so the 2 s poll stays cheap.
 */
function jobActivity(root: string, job: LoadedJob, projects: string, at = Date.now()): AgentActivity[] {
  const out: AgentActivity[] = [];
  for (const [role, a] of Object.entries(job.agents ?? {})) {
    if (a?.status !== 'running' || !(at - startMs(a.startedAt) < AGENT_LEASE_MS)) continue;
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
  const sid = job.lease.driver;
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

function jobDetail(root: string, id: string, projects: string, ownPoolSession: (job: LoadedJob) => boolean): JobDetail {
  const job = loadJob(root, id);
  const dir = jobDir(root, id);
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(full, depth + 1);
      else if (e.isFile() && TEXT_EXT.has(path.extname(e.name)) && !['job.json', 'events.jsonl', 'runtime.json'].includes(e.name) && !isPrivateName(e.name))
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
  // `forge job link` and `--create` add issues later, so only the issues at creation say request.md
  // is tracker text. A job created before v11 logged a `source` instead.
  const created = events.find((e) => e.type === 'created');
  const createdIssues = Array.isArray(created?.issues) ? (created.issues as unknown[]) : [];
  const createdSource = created?.source as { ref?: unknown } | null | undefined;
  const fromTracker = createdIssues.some((i) => Boolean(i && typeof i === 'object' && (i as { ref?: unknown }).ref)) || Boolean(createdSource?.ref);
  return redactDeep<JobDetail>({
    job: { ...job, progress: progress(root, id), ownerStatus: { ...leaseStatus(job), jobSession: ownPoolSession(job) } },
    events: events.slice(-400),
    files,
    screenshots: listScreenshots(dir),
    requests: listRequests(root).filter((r) => r.job === id).slice(-MAX_JOB_REQUESTS),
    request: requestExcerpt(root, id),
    requestFromTracker: fromTracker,
    agents: roundAgents(root, job, events, projects),
    ownerTranscript: ((o) => (o ? { session: o.session } : null))(interactiveOwner(root, job, projects)),
  }, knownValues(root, id, loadConfig(root).config));
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
  const notReady = () => {
    res.setHeader('Cache-Control', 'no-store');
    send(res, 503, 'text/plain', notBuilt);
  };
  // The page loads only manifest files, so it counts as built only when both exist.
  if (!exists(path.join(distDir, 'manifest.json'))) return notReady();
  let html;
  try {
    html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    return notReady();
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
