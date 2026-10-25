// The machine routes: GET /api/projects, the registered projects with their job counts, latest job, pools and the
// machine cap; its event stream, which sends that body on connect and again whenever it changes; and
// GET /api/projects/stats, each loaded project's shipped jobs and cost per UTC day for the Overview's graphs.
import type http from 'node:http';
import { loadConfig } from '#core/config/load.ts';
import { dailyTotals, windowDays } from '#engine/metrics/daily.ts';
import { json, jsonStatus, send } from '../http.ts';
import { MAX_SSE_CLIENTS, SSE_MAX_AGE_MS, SSE_SLOW_CLIENT_BYTES, sseHead, startPing } from '../sse.ts';
import type { ProjectStatsSeries, ProjectsResponse, ProjectsStatsResponse } from '#core/types.ts';
import type { MachineCtx, RouteMatch } from '../types.ts';

const PROJECTS_POLL_MS = 5000;

/** GET /api/projects: the index is re-read first, so a registration shows at once. */
export function getProjects(m: MachineCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  m.entries.refresh(true);
  return json(res, m.entries.summaries() satisfies ProjectsResponse);
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
