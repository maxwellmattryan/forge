// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { daemonProblems, loadConfig } from './config.mjs';
import { createDaemon } from './daemon.mjs';
import { listJobs, loadJob, progress, readEvents, jobDir } from './jobs.mjs';
import { paths, exists, PLUGIN_ROOT } from './paths.mjs';
import { API_VERSION } from './schema.mjs';
import { computeStats } from './stats.mjs';
import { listRuns, listTasks, compareRuns, forgeVersion } from './evals.mjs';
import { enqueue, listRequests } from './requests.mjs';
import { loadTracker } from './trackers/index.mjs';
import { roster } from './roster.mjs';
import { readText } from './util.mjs';

const TEXT_EXT = new Set(['.md', '.log', '.patch', '.diff', '.json', '.jsonl', '.txt', '.yml', '.yaml', '.html']);
const MAX_FILE = 2 * 1024 * 1024;
// An explicit allowlist, not static serving, so nothing else under dashboard/ or the plugin root is ever served.
const MODULES = new Set(['app.js', 'util.js', 'budget.js', 'deps.js', 'screenshots.js']);
// Raster formats only: SVG can carry script, so it is never served as an image.
/** @type {Record<string, string>} */
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_SCREENSHOTS = 200;
const MAX_SSE_CLIENTS = 8;
const SSE_SLOW_CLIENT_BYTES = 1024 * 1024;
const SSE_MAX_LINE = 64 * 1024;
const SSE_PING_MS = 15_000;

/**
 * Read-mostly, localhost-only server. POSTs need the per-process token embedded in the page,
 * so another site in the same browser cannot enqueue work or start the daemon.
 * @param {string} root @param {{port?:number, host?:string, daemon?:import('./daemon.mjs').DaemonOptions}} opts
 * @returns {Promise<{server:http.Server, url:string, daemon:ReturnType<typeof createDaemon>, close:()=>Promise<void>}>}
 */
export function startServer(root, opts = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  /** @type {{at:number, data:any}|null} */
  let backlogCache = null;
  /** @type {Set<http.ServerResponse>} */
  const clients = new Set();
  /** @type {ReturnType<typeof createDaemon>|null} */
  let daemon = null;
  /** @type {NodeJS.Timeout|null} */
  let ping = null;
  const daemonState = () => ({ ...(daemon ? daemon.state() : idleDaemonState()), clients: clients.size });

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, 'text/plain', 'misdirected request');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, token);
      const mod = req.method === 'GET' ? /^\/([a-z]+\.js)$/.exec(p) : null;
      if (mod && MODULES.has(mod[1])) return asset(res, mod[1], 'text/javascript');
      if (req.method === 'GET' && p === '/forge.png') return sendFile(res, path.join(PLUGIN_ROOT, 'assets', 'forge.png'), 'image/png');
      if (req.method === 'GET' && p === '/api/state') return json(res, state(root, daemonState()));
      if (req.method === 'GET' && p === '/api/events') return events(req, res);
      if (req.method === 'GET' && p === '/api/stats') return json(res, computeStats(root, { since: url.searchParams.get('since') ?? undefined }));
      if (req.method === 'GET' && p === '/api/evals') return json(res, { tasks: listTasks(root).map(({ dir: _d, request: _r, ...t }) => t), runs: listRuns(root) });
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
            backlogCache = { at: Date.now(), data: { tracker: config.tracker.kind, items: [], error: /** @type {Error} */ (e).message } };
          }
        }
        return json(res, backlogCache.data);
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
        return json(res, { ...rec, daemon: Boolean(daemon?.state().wanted) });
      }
      if (req.method === 'POST' && p === '/api/daemon') {
        if (guardPost(req, res, token)) return;
        let body;
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
        const problem = daemonProblems(config)[0];
        if (problem) return jsonStatus(res, 409, { error: problem });
        daemon?.start('http');
        return json(res, daemonState());
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      if (res.headersSent) return void res.end();
      send(res, 500, 'application/json', JSON.stringify({ error: /** @type {Error} */ (e).message }));
    }
  });

  /**
   * Server-sent events: the daemon's state, then its buffered log lines, then live ones. GET
   * only and loopback-only like every route; an Origin, when sent, must be ours, and there are
   * no CORS headers, so another site can neither read the stream nor exhaust its slots.
   * @param {http.IncomingMessage} req @param {http.ServerResponse} res
   */
  function events(req, res) {
    const origin = req.headers.origin;
    if (origin !== undefined && !sameOrigin(origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin');
    if (clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    res.write(stateFrame(daemonState()));
    const last = Number(req.headers['last-event-id']);
    for (const r of daemon?.recent(req.headers['last-event-id'] === undefined || !Number.isFinite(last) ? undefined : last) ?? []) res.write(lineFrame(r.seq, r.line));
    // The response's close, not the request's: a GET's request side ends as soon as it is read.
    res.on('close', () => {
      clients.delete(res);
      broadcast(clients, stateFrame(daemonState()));
    });
    if (!ping) {
      ping = setInterval(() => broadcast(clients, ': ping\n\n'), SSE_PING_MS);
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
        if (config.daemon?.enabled === true && !daemonProblems(config).length) d.start('boot');
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
      resolve({ server, url: `http://${host}:${/** @type {any} */ (server.address()).port}`, daemon: d, close });
    });
  });
}

/** The daemon block before a daemon exists (never visible once the server is listening). */
function idleDaemonState() {
  return { enabled: false, wanted: false, running: false, status: 'off', sessionId: null, pid: null, lastTurnAt: null, lastResultAt: null, turns: 0, held: null, lastError: null };
}

/**
 * Token, then Origin, then JSON: the checks every POST shares. Returns true when it has
 * already answered the request.
 * @param {http.IncomingMessage} req @param {http.ServerResponse} res @param {string} token
 */
function guardPost(req, res, token) {
  if (req.headers['x-forge-token'] !== token) return send(res, 403, 'text/plain', 'bad token'), true;
  if (!req.headers.origin || !sameOrigin(req.headers.origin, req.headers.host)) return send(res, 403, 'text/plain', 'bad origin'), true;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'text/plain', 'json only'), true;
  return false;
}

/** @param {string} origin @param {string|undefined} host */
function sameOrigin(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** @param {any} st */
function stateFrame(st) {
  return `event: state\ndata: ${JSON.stringify(st)}\n\n`;
}

/**
 * Lines are single-line JSON already; a stray CR would still end an SSE field, so it goes.
 * @param {number} seq @param {string} line
 */
function lineFrame(seq, line) {
  let data = line.replace(/\r/g, '');
  const bytes = Buffer.byteLength(data);
  if (bytes > SSE_MAX_LINE) {
    let originalType = null;
    try {
      originalType = JSON.parse(data)?.type ?? null;
    } catch {}
    data = JSON.stringify({ type: 'forge-truncated', originalType, bytes });
  }
  return `event: line\nid: ${seq}\ndata: ${data}\n\n`;
}

/**
 * Writes a frame to every client and ends any whose unsent buffer is over the cap, so one
 * stalled browser tab can't grow the server's memory; it reconnects with Last-Event-ID.
 * @param {Set<{write:(s:string)=>any, end:()=>any, writableLength:number}>} clients @param {string} frame @param {number} [capBytes]
 */
export function broadcast(clients, frame, capBytes = SSE_SLOW_CLIENT_BYTES) {
  for (const res of [...clients]) {
    res.write(frame);
    if (res.writableLength > capBytes) {
      clients.delete(res);
      res.end();
    }
  }
}

/** @param {string|undefined} host */
function isLoopbackHost(host) {
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** @param {string} root @param {any} daemon */
function state(root, daemon) {
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
      panel: config.review.panel.map((/** @type {any} */ r) => r.name),
      pipeline: config.pipeline,
      models: config.runtime.models,
      daemon: { enabled: config.daemon?.enabled === true },
    },
    daemon,
    jobs,
    requests: listRequests(root).filter((r) => r.status === 'pending' || r.status === 'in-progress'),
    now: new Date().toISOString(),
  };
}

/** @param {string} root @param {string} id */
function jobDetail(root, id) {
  const job = loadJob(root, id);
  const dir = jobDir(root, id);
  /** @type {string[]} */
  const files = [];
  const walk = (/** @type {string} */ d, /** @type {number} */ depth) => {
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
  const rank = (/** @type {string} */ f) => {
    const i = order.findIndex((o) => (o.endsWith('/') ? f.startsWith(o) : f === o));
    return i === -1 ? (f.startsWith('logs/') ? 1000 : 500) : i;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, undefined, { numeric: true }));
  return { job: { ...job, progress: progress(root, id) }, events: readEvents(root, id).slice(-400), files, screenshots: listScreenshots(dir) };
}

/**
 * Images under the job's `screenshots/` dir, as paths relative to the job dir. Symlinks are
 * skipped (`isFile()` is false for them), so the list never points outside the job.
 * @param {string} dir
 */
function listScreenshots(dir) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {string} */ d, /** @type {number} */ depth) => {
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
 * @param {http.ServerResponse} res @param {string} base @param {string} file
 */
function sendImage(res, base, file) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  // The Host check can't stop another site from embedding an <img> of this URL; CORP makes the
  // browser refuse cross-origin loads, so screenshots of real data never reach a foreign page.
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (path.relative(base, file).split(path.sep)[0] !== 'screenshots') return send(res, 404, 'text/plain', 'not found');
  /** @type {[number, string, string|Buffer]} */
  let reply = [404, 'text/plain', 'not found'];
  /** @type {number|undefined} */
  let fd;
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

/** @param {string} base @param {string} rel */
function safeJoin(base, rel) {
  if (!rel || rel.includes('\0')) return null;
  const full = path.resolve(base, rel);
  return full.startsWith(base + path.sep) ? full : null;
}

/** @param {string} file @param {number} bytes */
function readTail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  const size = fs.fstatSync(fd).size;
  const buf = Buffer.alloc(Math.min(bytes, size));
  fs.readSync(fd, buf, 0, buf.length, size - buf.length);
  fs.closeSync(fd);
  return buf.toString('utf8');
}

/** @param {http.IncomingMessage} req */
function readBody(req) {
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

/** @param {http.ServerResponse} res @param {string} token */
function page(res, token) {
  const html = fs.readFileSync(path.join(PLUGIN_ROOT, 'dashboard', 'index.html'), 'utf8').replace('__FORGE_TOKEN__', token);
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'text/html; charset=utf-8', html);
}

/** @param {http.ServerResponse} res @param {string} name @param {string} type */
function asset(res, name, type) {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, `${type}; charset=utf-8`, fs.readFileSync(path.join(PLUGIN_ROOT, 'dashboard', name)));
}

/** @param {http.ServerResponse} res @param {string} file @param {string} type */
function sendFile(res, file, type) {
  res.setHeader('Cache-Control', 'max-age=86400');
  send(res, 200, type, fs.readFileSync(file));
}

/** @param {http.ServerResponse} res @param {any} data */
function json(res, data) {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));
}

/** @param {http.ServerResponse} res @param {number} status @param {any} data */
function jsonStatus(res, status, data) {
  res.setHeader('Cache-Control', 'no-store');
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
}

/** @param {http.ServerResponse} res @param {number} status @param {string} type @param {string|Buffer} body */
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
