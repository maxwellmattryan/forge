// The other read routes and focus: /api/state, stats, evals, roster, project graph, backlog, about,
// doctor and its bundle, GitHub previews, and POST /api/focus.
import type http from 'node:http';
import path from 'node:path';
import { loadConfig, resolveEffort } from '#core/config/load.ts';
import { allKnownValues, redactDeep } from '#engine/guard/known-secrets.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { buildBundle, bundleFileName } from '#engine/ops/bundle.ts';
import { doctor } from '#engine/ops/doctor.ts';
import { readSmallJson } from '#core/job/focus.ts';
import { CheckoutError } from '#engine/workspace/checkout.ts';
import { InactiveJobError, currentFocus, focusJob } from '#engine/workspace/focus-actions.ts';
import { parseGitHubUrl } from '#integrations/github/preview.ts';
import { isActive, leaseStatus, listJobs, progress, readEvents, jobDir } from '#core/job/store.ts';
import { paths, exists, PLUGIN_ROOT } from '#core/paths.ts';
import { API_VERSION, CONFIG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from '#core/job/schema.ts';
import { computeStats } from '#engine/metrics/stats.ts';
import { projectGraph } from '#engine/project/graph.ts';
import { jobBudgetOf } from '#engine/metrics/budget.ts';
import { billingOf } from '#integrations/claude/argv.ts';
import { listRuns, listTasks, compareRuns, forgeVersion } from '#engine/evals/run.ts';
import { listRequests, validJobId } from '#core/job/requests.ts';
import { foremanHandoff, gateOwner } from '#office/foreman/policy.ts';
import { draftGates } from '#office/mandates/gate.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { roster } from '#engine/pipeline/roster.ts';
import { readTriageCache } from '#engine/trackers/triage.ts';
import { redactContext, redactText } from '#engine/guard/redact.ts';
import { isMap } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import { pidAlive } from '#core/os/process.ts';
import { readJson } from '#core/os/fs.ts';
import { commandTemplate } from '#engine/workspace/run.ts';
import { jobEndpoints } from '#engine/environment/endpoints.ts';
import { zip } from '#core/format/zip.ts';
import type {
  AboutResponse,
  ApiState,
  BacklogResponse,
  Config,
  DaemonPoolState,
  DoctorResponse,
  Endpoint,
  EvalsResponse,
  FocusResponse,
  GitHubPreviewResponse,
  JobEvent,
  LastHuman,
  LoadedJob,
  ProjectResponse,
  RepoBudgetStatus,
} from '#core/types.ts';
import type { VersionInfo } from '#engine/ops/types.ts';
import { json, jsonStatus, readJsonBody, tokenMatches } from '../http.ts';
import type { MachineCtx, RouteMatch, ServerCtx } from '../types.ts';
import { jobActivity } from './transcripts.ts';

/** GET /api/state: the jobs, the pool, the open requests and the budget. */
export function getState(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root, projects } = ctx;
  return json(res, state(root, ctx.poolState(), projects, ctx.budget()));
}

/** GET /api/stats: the repo's run statistics. */
export function getStats(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root } = ctx;
  return json(res, computeStats(root, { since: match.url.searchParams.get('since') ?? undefined, config: loadConfig(root).config }));
}

/** GET /api/evals: the eval tasks and runs. */
export function getEvals(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root } = ctx;
  return json(res, { tasks: listTasks(root).map(({ dir: _d, request: _r, ...t }) => t), runs: listRuns(root) } satisfies EvalsResponse);
}

/** GET /api/evals/compare: two eval runs side by side. */
export function getEvalsCompare(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root } = ctx;
  return json(res, compareRuns(root, match.url.searchParams.get('a') ?? '', match.url.searchParams.get('b') ?? ''));
}

/** GET /api/roster: the agent roster. */
export function getRoster(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root } = ctx;
  return json(res, roster(root, loadConfig(root).config));
}

// Read-only and a subset of /api/config (no commands, owners or notes), so it needs no token.
export function getProject(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root } = ctx;
  return json(res, projectGraph(loadConfig(root).config) satisfies ProjectResponse);
}

/** GET /api/backlog: the tracker's items, reused for a minute, with each one's triage verdict. */
export async function getBacklog(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  // A refetch spends the tracker's rate limit: without the page's token, `refresh` is ignored, so a
  // no-cors GET from another site can't loop it (and it still gets no reply to read).
  const header = req.headers['x-forge-token'];
  const refresh = match.url.searchParams.has('refresh') && tokenMatches(typeof header === 'string' ? header : null, ctx.token);
  if (!ctx.backlogCache || Date.now() - ctx.backlogCache.at > 60_000 || refresh) {
    const { config } = loadConfig(root);
    try {
      const tracker = await loadTracker(root, config);
      ctx.backlogCache = { at: Date.now(), data: { tracker: tracker.name, items: tracker.list({ root, config }, { limit: 200 }) } };
    } catch (e) {
      ctx.backlogCache = { at: Date.now(), data: { tracker: config.tracker.kind, items: [], error: (e as Error).message } };
    }
  }
  // Read per request, unlike the item list: a triage run shows on the next load, not a minute later.
  const triage = readTriageCache(root);
  const { tracker } = ctx.backlogCache.data;
  const items = ctx.backlogCache.data.items.map((item) => {
    const e = triage[`${tracker}:${item.ref}`];
    return e ? { ...item, triage: { ready: e.ready, missing: e.missing, at: e.at } } : item;
  });
  return json(res, { ...ctx.backlogCache.data, items } satisfies BacklogResponse);
}

/** GET /api/about: versions and links. */
export function getAbout(ctx: MachineCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { provenance } = ctx;
  return json(res, about(provenance));
}

/** GET /api/doctor: forge doctor's checks. */
export async function getDoctor(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  const { config, initialized } = loadConfig(root);
  return json(res, { ...(await doctor(root, config, initialized)), at: new Date().toISOString() } satisfies DoctorResponse);
}

/**
 * GET /api/doctor/bundle: the support bundle `forge doctor --bundle` writes, as a download. It
 * spawns git and gh and reads job logs, so it takes the token header (never a query parameter)
 * on top of the read guard. The job id is validated before any path is built, and the dashboard
 * never gets agent text: any other parameter, include-text among them, is ignored.
 */
export async function getSupportBundle(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const job = match.url.searchParams.get('job');
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

/** GET /api/github/preview: a GitHub repository, pull request, issue or commit, read through gh. */
export async function getGitHubPreview(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { previewGitHub } = ctx;
  const target = parseGitHubUrl(match.url.searchParams.get('url') ?? '');
  if (!target) return jsonStatus(res, 400, { error: 'not a GitHub repository, pull request, issue or commit URL' });
  return json(res, (await previewGitHub(target)) satisfies GitHubPreviewResponse);
}

/** POST /api/focus: check a job's branch out in the main checkout, or give the focus back. */
export async function postFocus(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
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
      // Sessions inherit forge dash's environment (sessionOptions defaults env to process.env), so that is the one to check.
      daemon: { enabled: config.daemon?.enabled === true, jobBudget: jobBudgetOf(config), billing: billingOf(process.env, config.daemon?.auth ?? 'subscription') },
      // Validated, so an invalid runtime.effort reads as none here while validate and doctor report it.
      effort: resolveEffort(config).level,
    },
    // `enabled` and the cap from this read of config.yml, so they are current even while the pool is stopped.
    daemons: { ...daemons, enabled: config.daemon?.enabled === true, foreman: config.foreman?.enabled === true, maxConcurrent: validCap(config.daemon?.maxConcurrent) ?? daemons.maxConcurrent },
    jobs,
    drafts: draftGates(root, config, requests),
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

function validCap(n: unknown): number | null {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 16 ? n : null;
}
