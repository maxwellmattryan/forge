// The machine routes: GET /api/projects, the registered projects with their job counts, latest job, pools and the
// machine cap; POST /api/projects, the dashboard's Add project, which registers a repo as `forge project add` does
// and never approves its trusted files; its event stream, which sends that body on connect and again whenever it
// changes; and GET /api/projects/stats, each loaded project's shipped jobs and cost per UTC day for the Overview's graphs.
import type http from 'node:http';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { dailyTotals, windowDays } from '#engine/metrics/daily.ts';
import { PROJECT_NAME, addProject, resolveProjectRoot } from '#engine/project/machine-index.ts';
import { json, jsonStatus, readJsonBody, send } from '../http.ts';
import { MAX_SSE_CLIENTS, SSE_MAX_AGE_MS, SSE_SLOW_CLIENT_BYTES, sseHead, startPing } from '../sse.ts';
import type { MachineProjectSummary, PostProjectResponse, ProjectStatsSeries, ProjectsResponse, ProjectsStatsResponse } from '#core/types.ts';
import type { MachineCtx, RouteMatch } from '../types.ts';

const PROJECTS_POLL_MS = 5000;

/** GET /api/projects: the index is re-read first, so a registration shows at once. */
export function getProjects(m: MachineCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  m.entries.refresh(true);
  return json(res, m.entries.summaries() satisfies ProjectsResponse);
}

/** The longest `path` POST /api/projects takes: PATH_MAX on Linux. */
const PROJECT_PATH_MAX = 4096;
const PROJECT_BODY_KEYS = ['name', 'path'];
const PROJECT_BODY_SHAPE = 'body must be {"path": string, "name"?: string}';

/**
 * Why `p` can't be registered before anything touches the disk, or null. A relative path would resolve against the
 * server's cwd and `~user` against another account, so only an absolute path, `~` or `~/…` passes; NUL, CR and LF
 * never reach the index's JSON-lines readers.
 */
function projectPathProblem(p: string): string | null {
  if (!p) return 'path is empty';
  if (p.length > PROJECT_PATH_MAX) return `path is longer than ${PROJECT_PATH_MAX} characters`;
  if (/[\0\r\n]/.test(p)) return 'path has a NUL or a line break';
  if (!path.isAbsolute(p) && p !== '~' && !p.startsWith('~/')) return 'path must be absolute, or start with ~/';
  return null;
}

/**
 * POST /api/projects: the dashboard's Add project, registering the repo at `path` (its main checkout's realpath, as
 * `forge project add <path>`) under `name` or its default. It never approves the project's trusted files, so a
 * project with daemon.enabled waits for a human's Start (docs/architecture/daemon-security.md). The same path again
 * is `added: false` and writes nothing.
 */
export async function postProject(m: MachineCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const body = parsed.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonStatus(res, 400, { error: PROJECT_BODY_SHAPE });
  const b = body as Record<string, unknown>;
  if (!Object.keys(b).every((k) => PROJECT_BODY_KEYS.includes(k)) || typeof b.path !== 'string' || (b.name !== undefined && typeof b.name !== 'string'))
    return jsonStatus(res, 400, { error: PROJECT_BODY_SHAPE });
  const problem = projectPathProblem(b.path);
  if (problem) return jsonStatus(res, 400, { error: problem });
  const name = typeof b.name === 'string' && b.name !== '' ? b.name : undefined;
  if (name !== undefined && !PROJECT_NAME.test(name))
    return jsonStatus(res, 400, { error: 'name must be lowercase letters, digits, dots, dashes and underscores, starting with a letter or digit, at most 64 characters' });
  let root: string;
  try {
    // Relative paths were refused above, so the cwd never decides what is registered.
    root = resolveProjectRoot(b.path, '/');
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, 400, { error: e.message });
    throw e;
  }
  let result: ReturnType<typeof addProject>;
  try {
    result = addProject(m.home, root, name === undefined ? {} : { name });
  } catch (e) {
    // A taken name, or an index this Forge can't read or must not rewrite: a conflict with the index, not a bad request.
    if (e instanceof ForgeError) return jsonStatus(res, e.code === 'usage' ? 400 : 409, { error: e.message });
    throw e;
  }
  m.entries.refresh(true);
  const { name: added, path: at } = result.project;
  const project: MachineProjectSummary = m.entries.summaries().projects.find((p) => p.name === added && p.path === at) ?? {
    name: added,
    path: at,
    status: 'ok',
    loaded: false,
    jobs: null,
    latest: null,
    daemon: null,
  };
  return json(res, { added: result.added, project } satisfies PostProjectResponse);
}

/** The windows GET /api/projects/stats takes: an allowlist, so a crafted query can't widen the ledger work. */
const STATS_DAYS: Record<string, number> = { '7': 7, '30': 30, '90': 90 };

/**
 * GET /api/projects/stats?days=7|30|90 (default 30): each loaded project's shipped jobs and cost per UTC day,
 * with today's and this month's spend. One project's unreadable state is its own `error`, with zeros.
 */
export function getProjectsStats(m: MachineCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const raw = match.url.searchParams.get('days');
  const days = raw === null ? 30 : Object.hasOwn(STATS_DAYS, raw) ? STATS_DAYS[raw] : null;
  if (days === null) return jsonStatus(res, 400, { error: 'days must be 7, 30 or 90' });
  m.entries.refresh(false);
  const at = Date.now();
  const projects = m.entries.list().map((e): ProjectStatsSeries => {
    try {
      const t = dailyTotals(e.root, loadConfig(e.root).config, { days, at });
      return { name: e.name, shipped: t.shipped, costUsd: t.costUsd, dayUsd: t.dayUsd, monthUsd: t.monthUsd, error: null };
    } catch (err) {
      const zeros = Array.from({ length: days }, () => 0);
      return { name: e.name, shipped: zeros, costUsd: [...zeros], dayUsd: 0, monthUsd: 0, error: (err as Error).message };
    }
  });
  return json(res, { generatedAt: new Date(at).toISOString(), days: windowDays(days, at), projects } satisfies ProjectsStatsResponse);
}

const projectsFrame = (body: string): string => `event: projects\ndata: ${body}\n\n`;

/**
 * GET /api/projects/events: a `projects` frame on connect, then one whenever the body changes, checked
 * every 5 s while the client stays. It counts against MAX_SSE_CLIENTS and is recycled like /api/events.
 */
export function getProjectsEvents(m: MachineCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  if (m.clients.size >= MAX_SSE_CLIENTS) return send(res, 503, 'text/plain', 'too many event streams');
  m.entries.refresh(true);
  let last = JSON.stringify(m.entries.summaries());
  sseHead(res);
  res.write('retry: 3000\n\n');
  m.clients.set(res, 'projects');
  res.write(projectsFrame(last));
  const poll = setInterval(() => {
    m.entries.refresh(false);
    const next = JSON.stringify(m.entries.summaries());
    if (next === last) return;
    last = next;
    res.write(projectsFrame(next));
    if (res.writableLength > SSE_SLOW_CLIENT_BYTES) res.end();
  }, m.opts.projectsPollMs ?? PROJECTS_POLL_MS);
  poll.unref();
  const recycle = setTimeout(() => res.end(), m.opts.sseMaxAgeMs ?? SSE_MAX_AGE_MS);
  recycle.unref();
  res.on('close', () => {
    clearInterval(poll);
    clearTimeout(recycle);
    m.clients.delete(res);
  });
  startPing(m);
}
