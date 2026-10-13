import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { daemonProblems, loadConfig, validateConfig } from './config.ts';
import { ConfigSetError, FIELDS } from './config-fields.ts';
import { setConfigValue } from './config-set.ts';
import { createDaemon } from './daemon.ts';
import { doctor } from './doctor.ts';
import type { Daemon, DaemonOptions, SupervisorState } from './daemon.ts';
import { listJobs, loadJob, progress, readEvents, jobDir } from './jobs.ts';
import { paths, exists, PLUGIN_ROOT } from './paths.ts';
import { API_VERSION, CONFIG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from './schema.ts';
import { computeStats } from './stats.ts';
import { listRuns, listTasks, compareRuns, forgeVersion } from './evals.ts';
import { enqueue, listRequests } from './requests.ts';
import { loadTracker } from './trackers/index.ts';
import { roster } from './roster.ts';
import { getPath, readJson, readText } from './util.ts';
import type {
  AboutResponse,
  ApiError,
  ApiState,
  BacklogResponse,
  ConfigResponse,
  DaemonState,
  DoctorResponse,
  EvalsResponse,
  ForgeTruncatedLine,
  JobDetail,
  PostConfigResponse,
  PostRequestResponse,
} from './types.ts';

/** startServer's options. `distDir` is a test seam like `sseMaxAgeMs`. */
export interface ServerOptions {
  port?: number;
  host?: string;
  daemon?: DaemonOptions;
  sseMaxAgeMs?: number;
  ssePingMs?: number;
  distDir?: string;
}

/** A listening dashboard server: what startServer resolves to. */
export interface RunningServer {
  server: http.Server;
  url: string;
  daemon: Daemon;
  close: () => Promise<void>;
}

const TEXT_EXT = new Set(['.md', '.log', '.patch', '.diff', '.json', '.jsonl', '.txt', '.yml', '.yaml', '.html']);
const MAX_FILE = 2 * 1024 * 1024;
// Raster formats only: SVG can carry script, so it is never served as an image.
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_SCREENSHOTS = 200;
const MAX_SSE_CLIENTS = 8;
const SSE_SLOW_CLIENT_BYTES = 1024 * 1024;
const SSE_MAX_LINE = 64 * 1024;
const SSE_PING_MS = 15_000;
// Streams are recycled (EventSource reconnects with Last-Event-ID), so an idle tab can't hold one
// of the few slots forever.
const SSE_MAX_AGE_MS = 5 * 60_000;
const DIST_DIR = path.join(PLUGIN_ROOT, 'dashboard', 'dist');
const NOT_BUILT = 'dashboard is not built: run npm run build:dashboard';
const DIST_ASSET = /^assets\/[\w.-]+\.(js|css)$/;
const DIST_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

/**
 * Read-mostly, localhost-only server. POSTs need the per-process token embedded in the page,
 * so another site in the same browser cannot enqueue work or start the daemon.
 * `distDir` is a test seam like `sseMaxAgeMs`; it defaults to the plugin's committed dashboard/dist.
 */
export function startServer(root: string, opts: ServerOptions = {}): Promise<RunningServer> {
  const token = crypto.randomBytes(16).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  const distDir = opts.distDir ?? DIST_DIR;
  let backlogCache: { at: number; data: BacklogResponse } | null = null;
  const clients = new Set<http.ServerResponse>();
  let daemon: Daemon | null = null;
  let ping: NodeJS.Timeout | null = null;
  const daemonState = (): DaemonState => ({ ...(daemon ? daemon.state() : idleDaemonState()), clients: clients.size });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, 'text/plain', 'misdirected request');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, token, distDir);
      // Re-read per request so a rebuild under a running `forge dash` is picked up; the manifest is
      // tiny. The pathname is never decoded or joined: lookup is by exact string.
      if (req.method === 'GET' && p.startsWith('/assets/')) {
        const hit = distAllowlist(distDir).get(p);
        return hit ? immutable(res, hit) : send(res, 404, 'text/plain', 'not found');
      }
      if (req.method === 'GET' && p === '/forge.png') return sendFile(res, path.join(PLUGIN_ROOT, 'assets', 'forge.png'), 'image/png');
      if (req.method === 'GET' && p === '/api/state') return json(res, state(root, daemonState()));
      if (req.method === 'GET' && p === '/api/events') return events(req, res);
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
      if (req.method === 'GET' && p === '/api/config') return json(res, configResponse(root, Boolean(daemon?.state().wanted)));
      if (req.method === 'GET' && p === '/api/about') return json(res, about());
      if (req.method === 'GET' && p === '/api/doctor') {
        // It spawns git and gh, so it takes the token like a POST.
        if (guardToken(req, res, token)) return;
        const { config, initialized } = loadConfig(root);
        return json(res, { ...(await doctor(root, config, initialized)), at: new Date().toISOString() } satisfies DoctorResponse);
      }
      const m = p.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)(\/file|\/raw)?$/);
      if (req.method === 'GET' && m) {
        const id = m[1];
        if (!m[2]) return json(res, jobDetail(root, id));
        const rel = url.searchParams.get('path') ?? '';
        const file = safeJoin(jobDir(root, id), rel);
        if (file && m[2] === '/file' && IMAGE_TYPES[path.extname(file).toLowerCase()]) return sendImage(res, jobDir(root, id), file);
        if (!file || !exists(file) || !TEXT_EXT.has(path.extname(file))) return send(res, 404, 'text/plain', 'not found');
        if (m[2] === '/raw') {
          res.setHeader('Content-Security-Policy', 'sandbox allow-scripts');
          return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(file));
        }
        const size = fs.statSync(file).size;
        const text = size > MAX_FILE ? `…truncated (${size} bytes); showing the last 2 MB…\n` + readTail(file, MAX_FILE) : readText(file);
        return send(res, 200, 'text/plain; charset=utf-8', text);
      }
      if (req.method === 'POST' && p === '/api/requests') {
        if (guardPost(req, res, token)) return;
        const body = JSON.parse((await readBody(req)) || '{}');
        const { config } = loadConfig(root);
        const rec = enqueue(root, config, { type: body.type, job: body.job, text: body.text, args: body.args, from: 'dashboard' });
        daemon?.poke();
        return json(res, { ...rec, daemon: Boolean(daemon?.state().wanted) } satisfies PostRequestResponse);
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
        if (daemon?.state().wanted) return jsonStatus(res, 409, { error: DAEMON_LOCK });
        try {
          const r = setConfigValue(root, body.key, body.value);
          if (r.changed) backlogCache = null;
          return json(res, r satisfies PostConfigResponse);
        } catch (e) {
          if (e instanceof ConfigSetError) return jsonStatus(res, CONFIG_STATUS[e.reason], { error: e.message });
          throw e;
        }
      }
      if (req.method === 'POST' && p === '/api/daemon') {
        if (guardPost(req, res, token)) return;
        let body: any;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return jsonStatus(res, 400, { error: 'body is not JSON' });
        }
        const action = body && typeof body === 'object' ? body.action : undefined;
        if (action === 'stop') {
          await daemon?.stop('http');
          return json(res, daemonState());
        }
        if (action !== 'start') return jsonStatus(res, 400, { error: 'action must be "start" or "stop"' });
        const { config } = loadConfig(root);
        if (config.daemon?.enabled !== true) return jsonStatus(res, 409, { error: 'daemon.enabled is false in .forge/config.yml' });
        const problem = daemonProblems(config, root)[0];
        if (problem) return jsonStatus(res, 409, { error: problem });
        daemon?.start('http');
        return json(res, daemonState());
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      if (res.headersSent) return void res.end();
      send(res, 500, 'application/json', JSON.stringify({ error: (e as Error).message } satisfies ApiError));
    }
  });

  /**
   * Server-sent events: the daemon's state, then its buffered log lines, then live ones. GET
   * only and loopback-only like every route; an Origin, when sent, must be ours, and there are
   * no CORS headers, so another site can't read the stream. A cross-site request is refused when
   * the browser sends Fetch Metadata; one that doesn't can still hold a slot until the stream is
   * recycled (sseMaxAgeMs), which costs the live log's availability, never the daemon.
   */
  function events(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin;
    if (origin !== undefined && !sameOrigin(origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin');
    // A no-cors request from another site (fetch no-cors, <img>, <script>) carries no Origin, but
    // browsers that send Fetch Metadata label it cross-site; refuse it so it can't hold a slot.
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return send(res, 403, 'text/plain', 'cross-site');
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    res.write(stateFrame(daemonState()));
    const last = Number(req.headers['last-event-id']);
    for (const r of daemon?.recent(req.headers['last-event-id'] === undefined || !Number.isFinite(last) ? undefined : last) ?? []) res.write(lineFrame(r.seq, r.line));
    const recycle = setTimeout(() => res.end(), opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
    recycle.unref();
    // The response's close, not the request's: a GET's request side ends as soon as it is read.
    res.on('close', () => {
      clearTimeout(recycle);
      clients.delete(res);
      broadcast(clients, stateFrame(daemonState()));
    });
    if (!ping) {
      ping = setInterval(() => broadcast(clients, ': ping\n\n'), opts.ssePingMs ?? SSE_PING_MS);
      ping.unref();
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7400, host, () => {
      // Created only once the port is ours, so a dash retrying ports never starts a second daemon.
      const d = createDaemon(root, opts.daemon);
      daemon = d;
      d.subscribe((e) => broadcast(clients, e.kind === 'line' ? lineFrame(e.seq, e.line) : stateFrame({ ...e.state, clients: clients.size })));
      try {
        const { config } = loadConfig(root);
        if (config.daemon?.enabled === true && !daemonProblems(config, root).length) d.start('boot');
      } catch {}
      const close = async () => {
        if (ping) clearInterval(ping);
        for (const c of clients) c.end();
        clients.clear();
        await d.close();
        await new Promise((r) => {
          server.close(() => r(undefined));
          server.closeAllConnections?.();
        });
      };
      resolve({ server, url: `http://${host}:${(server.address() as AddressInfo).port}`, daemon: d, close });
    });
  });
}

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

/** The daemon block before a daemon exists (never visible once the server is listening). */
function idleDaemonState(): SupervisorState {
  return { enabled: false, wanted: false, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, held: null, lastError: null };
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

function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function stateFrame(st: DaemonState): string {
  return `event: state\ndata: ${JSON.stringify(st)}\n\n`;
}

/**
 * Lines are single-line JSON already; a stray CR would still end an SSE field, so it goes.
 */
function lineFrame(seq: number, line: string): string {
  let data = line.replace(/\r/g, '');
  const bytes = Buffer.byteLength(data);
  if (bytes > SSE_MAX_LINE) {
    let originalType: string | null = null;
    try {
      originalType = JSON.parse(data)?.type ?? null;
    } catch {}
    data = JSON.stringify({ type: 'forge-truncated', originalType, bytes } satisfies ForgeTruncatedLine);
  }
  return `event: line\nid: ${seq}\ndata: ${data}\n\n`;
}

/**
 * Writes a frame to every client and ends any whose unsent buffer is over the cap, so one
 * stalled browser tab can't grow the server's memory; it reconnects with Last-Event-ID.
 */
export function broadcast(clients: Set<{ write: (s: string) => unknown; end: () => unknown; writableLength: number }>, frame: string, capBytes = SSE_SLOW_CLIENT_BYTES): void {
  for (const res of [...clients]) {
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

function state(root: string, daemon: DaemonState): ApiState {
  const { config, initialized } = loadConfig(root);
  const jobs = listJobs(root).map((j) => {
    const events = readEvents(root, j.id);
    const last = events[events.length - 1] ?? null;
    return { ...j, progress: progress(root, j.id), lastEvent: last, eventCount: events.length };
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
    },
    // `enabled` from this read of config.yml, so it is current even while the daemon is stopped.
    daemon: { ...daemon, enabled: config.daemon?.enabled === true },
    jobs,
    requests: listRequests(root).filter((r) => r.status === 'pending' || r.status === 'in-progress'),
    now: new Date().toISOString(),
  };
}

function jobDetail(root: string, id: string): JobDetail {
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
  return { job: { ...job, progress: progress(root, id) }, events: readEvents(root, id).slice(-400), files, screenshots: listScreenshots(dir) };
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
      fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
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
 * the rest of the plugin root never are. Entries that aren't plain `assets/<file>.js|css` names
 * are dropped, and a missing or unparseable manifest allows nothing.
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

function page(res: http.ServerResponse, token: string, distDir: string): void {
  let html;
  try {
    // The page loads only manifest files, so it counts as built only when both exist.
    if (!exists(path.join(distDir, 'manifest.json'))) throw new Error('no manifest');
    html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    return send(res, 503, 'text/plain', NOT_BUILT);
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
