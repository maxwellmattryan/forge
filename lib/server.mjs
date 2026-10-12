// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { loadConfig } from './config.mjs';
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

/**
 * Read-mostly, localhost-only server. POSTs need the per-process token embedded in the page,
 * so another site in the same browser cannot enqueue work.
 * @param {string} root @param {{port?:number, host?:string}} opts
 */
export function startServer(root, opts = {}) {
  const token = crypto.randomBytes(16).toString('hex');
  const host = opts.host ?? '127.0.0.1';
  /** @type {{at:number, data:any}|null} */
  let backlogCache = null;

  const server = http.createServer(async (req, res) => {
    try {
      if (!isLoopbackHost(req.headers.host)) return send(res, 421, 'text/plain', 'misdirected request');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page(res, token);
      if (req.method === 'GET' && p === '/app.js') return asset(res, 'app.js', 'text/javascript');
      if (req.method === 'GET' && p === '/api/state') return json(res, state(root));
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
        if (req.headers['x-forge-token'] !== token) return send(res, 403, 'text/plain', 'bad token');
        const origin = req.headers.origin;
        if (!origin || new URL(origin).host !== req.headers.host) return send(res, 403, 'text/plain', 'bad origin');
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return send(res, 415, 'text/plain', 'json only');
        const body = JSON.parse((await readBody(req)) || '{}');
        const { config } = loadConfig(root);
        return json(res, enqueue(root, config, { type: body.type, job: body.job, text: body.text, args: body.args, from: 'dashboard' }));
      }
      send(res, 404, 'text/plain', 'not found');
    } catch (e) {
      send(res, 500, 'application/json', JSON.stringify({ error: /** @type {Error} */ (e).message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 7400, host, () => resolve({ server, url: `http://${host}:${/** @type {any} */ (server.address()).port}` }));
  });
}

/** @param {string|undefined} host */
function isLoopbackHost(host) {
  const name = String(host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

/** @param {string} root */
function state(root) {
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
      launcher: Boolean(config.dashboard?.launcher),
    },
    jobs,
    requests: listRequests(root, { status: 'pending' }),
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
  return { job: { ...job, progress: progress(root, id) }, events: readEvents(root, id).slice(-400), files };
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

/** @param {http.ServerResponse} res @param {any} data */
function json(res, data) {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, 'application/json; charset=utf-8', JSON.stringify(data));
}

/** @param {http.ServerResponse} res @param {number} status @param {string} type @param {string|Buffer} body */
function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
