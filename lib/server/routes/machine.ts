// The machine routes: GET /api/projects, the registered projects with their job counts, pools and the
// machine cap, and its event stream, which sends that body on connect and again whenever it changes.
import type http from 'node:http';
import { json, send } from '../http.ts';
import { MAX_SSE_CLIENTS, SSE_MAX_AGE_MS, SSE_SLOW_CLIENT_BYTES, sseHead, startPing } from '../sse.ts';
import type { ProjectsResponse } from '#core/types.ts';
import type { MachineCtx } from '../types.ts';

const PROJECTS_POLL_MS = 5000;

/** GET /api/projects: the index is re-read first, so a registration shows at once. */
export function getProjects(m: MachineCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  m.entries.refresh(true);
  return json(res, m.entries.summaries() satisfies ProjectsResponse);
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
