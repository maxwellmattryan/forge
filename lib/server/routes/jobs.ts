// Job routes: create a job, its detail, files and raw mockups, requests, effort, delete, merge now,
// a person's CI re-run and Fix CI, repo proposals, the Shelved list's batch actions, and its dev server and editor.
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { loadConfig } from '#core/config/load.ts';
import { isPrivateJobFile, isPrivateName, knownValues, redactDeep, redactKnown } from '#engine/guard/known-secrets.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { containedWorktree, editorArgv, openEditor } from '#engine/workspace/editor.ts';
import { createJob, isActive, leaseStatus, listJobs, loadJob, progress, readEvents, jobDir, requestBody, setJob, setJobEffort } from '#core/job/store.ts';
import { deleteJob, deleteRefusal } from '#engine/ops/delete.ts';
import { mergePr } from '#engine/pr/merge.ts';
import { fixFailingChecks, rerunFailedChecks } from '#engine/pr/ci.ts';
import { budgetCmd } from '#engine/metrics/budget.ts';
import { decideRepoProposals, isRepoProposalPark } from '#engine/project/repo-proposals.ts';
import { isShelved, shelfAction, shelvedRefusal } from '#engine/pipeline/moves/shelve.ts';
import { SHELF_ACTIONS } from '#api/constants.ts';
import { REPO_NAME } from '#engine/project/member-repos.ts';
import { parseIssueRef } from '#core/job/issue-ref.ts';
import { exists } from '#core/paths.ts';
import { EFFORTS } from '#core/job/schema.ts';
import { withoutRunHistory } from '#engine/metrics/runs.ts';
import { isSessionUsageEvent } from '#engine/metrics/meter.ts';
import { enqueue, isMandateIdArg, listRequests, validJobId } from '#core/job/requests.ts';
import { deriveTitle, normalizeTitle } from '#engine/ops/title.ts';
import { isMap } from '#core/shape.ts';
import { ForgeError } from '#core/errors.ts';
import { startBackground } from '#engine/workspace/dev-server.ts';
import { openConfinedLog } from '#engine/environment/status.ts';
import type {
  Config,
  DeleteJobResult,
  JobDetail,
  LoadedJob,
  PostEditorResponse,
  PostJobBudgetResponse,
  PostJobCiBody,
  PostJobCiResponse,
  PostJobEffortResponse,
  PostJobMergeResponse,
  PostJobReposResponse,
  PostJobResponse,
  PostRequestResponse,
  PostRunResponse,
  PostShelfResponse,
  ShelfAction,
} from '#core/types.ts';
import { json, jsonStatus, readJsonBody, safeJoin, send } from '../http.ts';
import { IMAGE_TYPES, listScreenshots, sendImage } from '../static.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';
import { interactiveOwner, roundAgents } from './transcripts.ts';

const TEXT_EXT = new Set(['.md', '.log', '.patch', '.diff', '.json', '.jsonl', '.txt', '.yml', '.yaml', '.html']);
const MAX_FILE = 2 * 1024 * 1024;
/** POST /api/jobs/:id/repos: the longest note it records. */
const REPO_NOTE_MAX = 2000;
/** A decision lists at most this many repos: more than any project has members. */
const REPO_LIST_MAX = 100;
// A mockup is agent-written HTML that may hold secrets an agent was misled into writing. It runs with
// no script at all (a sandbox without allow-scripts), so it can't navigate itself, open WebRTC or
// prefetch through script, and the sandbox also blocks meta refresh, popups, forms and top
// navigation. It loads nothing but inline style and data: images and fonts, so no subresource or
// connection leaves the machine. A clicked link can still navigate the frame, which the page's
// `frame-src 'self'` blocks for any other origin. `frame-ancestors 'self'` rather than 'none',
// because the dashboard's own Files tab frames it.
const RAW_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-ancestors 'self'";
/** The newest requests a job's Thread shows. */
const MAX_JOB_REQUESTS = 50;
const MAX_REQUEST_EXCERPT = 2000;

/** POST /api/jobs: create a job from the dashboard's request text and queue its intake. */
export async function postJob(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
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
  ctx.pool?.poke();
  return json(res, { id: job.id, title: job.title, branch: job.branch, request, daemon: Boolean(ctx.pool?.state().wanted) } satisfies PostJobResponse);
}

/** GET /api/jobs/:id: the job's detail. */
export function getJob(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root, projects } = ctx;
  const id = match.params[0];
  // Ids resolve only inside this project: one that exists in another registered project is still none here.
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: `no job ${id}` });
  return json(res, jobDetail(root, id, projects, ctx.drive));
}

/**
 * GET /api/jobs/:id/file and /raw: a text file or screenshot in the job dir, or an HTML mockup in a
 * sandboxed frame. The job's agents write this dir, so every read goes through openConfinedLog: a
 * link, FIFO, device or hard link, or a symlinked job dir, is a 404, and the file is read through
 * the descriptor that check opened.
 */
export function getJobFile(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root } = ctx;
  const [id, kind] = match.params;
  if (!validJobId(id)) return send(res, 404, 'text/plain', 'not found');
  const base = jobDir(root, id);
  const file = safeJoin(base, match.url.searchParams.get('path') ?? '');
  // Private job files hold credentials: not served under any path that names them or links to them.
  if (!file || isPrivateJobFile(file)) return send(res, 404, 'text/plain', 'not found');
  const ext = path.extname(file);
  if (kind === 'file' && IMAGE_TYPES[ext.toLowerCase()]) return sendImage(res, root, base, file);
  // /raw serves mockups only: a log or JSON file served as text/html would run as a page.
  if (kind === 'raw' ? ext !== '.html' : !TEXT_EXT.has(ext)) return send(res, 404, 'text/plain', 'not found');
  const opened = openConfinedLog(root, base, file);
  if (typeof opened === 'string') return send(res, 404, 'text/plain', 'not found');
  const { fd, size } = opened;
  try {
    // Half an HTML file is no use, so a mockup over the cap is refused rather than cut.
    if (kind === 'raw' && size > MAX_FILE) return send(res, 413, 'text/plain', 'file too large');
    // Background logs are written by the child itself, so known values are taken out here.
    const known = knownValues(root, id, loadConfig(root).config);
    if (kind === 'raw') {
      const raw = readFdRange(fd, 0, size);
      res.setHeader('Content-Security-Policy', RAW_CSP);
      res.setHeader('X-DNS-Prefetch-Control', 'off');
      return send(res, 200, 'text/html; charset=utf-8', known.length ? redactKnown(raw.toString('utf8'), known) : raw);
    }
    const text = size > MAX_FILE ? `…truncated (${size} bytes); showing the last 2 MB…\n` + readFdRange(fd, size - MAX_FILE, MAX_FILE).toString('utf8') : readFdRange(fd, 0, size).toString('utf8');
    return send(res, 200, 'text/plain; charset=utf-8', redactKnown(text, known));
  } finally {
    fs.closeSync(fd);
  }
}

/** GET /api/requests: the request queue. */
export function getRequests(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root } = ctx;
  return json(res, listRequests(root));
}

/** POST /api/requests: queue a request from the dashboard. */
export async function postRequest(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const body: Record<string, any> = parsed.body && typeof parsed.body === 'object' && !Array.isArray(parsed.body) ? parsed.body : {};
  // Only the CLI's park and sync paths write gate requests: they carry the reserved check's result.
  if (body.type === 'gate') return jsonStatus(res, 400, { error: 'gate requests are written only by forge job set and forge pr sync (and forge mandate draft record for a milestone draft)' });
  // A drafting run spends on the office session: only the owner's own forge mandate queues one.
  if (body.type === 'draft') return jsonStatus(res, 400, { error: 'draft requests are written only by forge mandate' });
  // A direct request turns the office session: only the Office pass writes one.
  if (body.type === 'direct') return jsonStatus(res, 400, { error: 'direct requests are written only by the Office pass' });
  const problem = requestArgsProblem(body, loadConfig(root).config.tracker.kind);
  if (problem) return jsonStatus(res, 400, { error: problem });
  const held = shelvedHeld(root, body) ?? resumeHeld(root, body, ctx.drive);
  if (held) return jsonStatus(res, 409, { error: held });
  const { config } = loadConfig(root);
  const rec = enqueue(root, config, { type: body.type, job: body.job, text: body.text, args: body.args, from: 'dashboard' });
  ctx.pool?.poke();
  return json(res, { ...rec, daemon: Boolean(ctx.pool?.state().wanted) } satisfies PostRequestResponse);
}

/** POST /api/jobs/:id/effort: the job's effort level, or null to inherit runtime.effort. */
export async function postJobEffort(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  // `_inbox` is not a job id, so it is a 404 like any unknown job.
  const id = match.params[0];
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
  const body = parsed.body;
  const effort = body && typeof body === 'object' && !Array.isArray(body) && Object.hasOwn(body, 'effort') ? (body as Record<string, unknown>).effort : undefined;
  if (effort !== null && !(EFFORTS as readonly unknown[]).includes(effort)) return jsonStatus(res, 400, { error: `effort must be one of ${EFFORTS.join(', ')}, or null` });
  // No DAEMON_LOCK: job.json is outside the trust digest, and a running session picks the level up at its next spawn.
  return json(res, setJobEffort(root, id, effort as PostJobEffortResponse['effort'], 'dashboard') satisfies PostJobEffortResponse);
}

/** POST /api/jobs/:id/budget: at most this many `set` entries, each at most this long. */
const BUDGET_SET_MAX = 5;
const BUDGET_ENTRY_MAX = 100;
const BUDGET_SHAPE = 'body must be {"ack": true} or {"set": ["key=value", …]} (or both)';

/**
 * POST /api/jobs/:id/budget: a person raising or acknowledging the job's budget, the dashboard's half
 * of the human channel for `forge job budget --set|--ack` (docs/architecture/daemon-security.md). Its
 * events carry the dashboard's actor.
 */
export async function postJobBudget(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const id = match.params[0];
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
  const body = parsed.body;
  if (!isMap(body)) return jsonStatus(res, 400, { error: BUDGET_SHAPE });
  const { ack, set } = body;
  const setOk = set === undefined || (Array.isArray(set) && set.length >= 1 && set.length <= BUDGET_SET_MAX && set.every((s) => typeof s === 'string' && s.length <= BUDGET_ENTRY_MAX));
  if ((ack !== undefined && typeof ack !== 'boolean') || !setOk || !(ack === true || Array.isArray(set))) return jsonStatus(res, 400, { error: BUDGET_SHAPE });
  let r: PostJobBudgetResponse;
  try {
    // No DAEMON_LOCK: job.json is outside the trust digest, as for /effort.
    r = budgetCmd(root, loadConfig(root).config, id, { set: set as string[] | undefined, ack: ack === true, grant: { channel: 'dashboard', actor: dashboardActor() } });
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, 400, { error: e.message });
    throw e;
  }
  ctx.pool?.poke();
  return json(res, r satisfies PostJobBudgetResponse);
}

/** POST /api/jobs/:id/delete: delete the job the body names back. */
export async function postJobDelete(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const id = match.params[0];
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
  // The id typed back: a stray or replayed click never deletes a job the human did not name.
  if (!isMap(parsed.body) || parsed.body.confirm !== id) return jsonStatus(res, 400, { error: 'body must be {"confirm": "<the job id>"}' });
  const { config } = loadConfig(root);
  // The job's own dashboard session is the one thing the delete may stop, and only once nothing else refuses it.
  const refusal = deleteRefusal(root, loadJob(root, id), listJobs(root), { stopsDaemon: true });
  if (refusal) return jsonStatus(res, 409, { error: `cannot delete ${id}: ${refusal}` });
  await ctx.pool?.dropSession(id);
  try {
    return json(res, (await deleteJob(root, config, id, { trigger: 'dashboard', actor: dashboardActor() })) satisfies DeleteJobResult);
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
    throw e;
  }
}

/**
 * POST /api/jobs/:id/merge: a person's merge-now, the dashboard's half of the human channel for
 * `forge pr merge --now` (docs/architecture/daemon-security.md). It skips what --now skips, never the
 * merge order or a release gate, and its events carry the dashboard's actor.
 */
export async function postJobMerge(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const id = match.params[0];
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
  // The id typed back, like delete: a stray or replayed click never merges past CI.
  const body = parsed.body;
  if (!isMap(body) || body.now !== true || body.confirm !== id) return jsonStatus(res, 400, { error: 'body must be {"now": true, "confirm": "<the job id>"}' });
  let r: Awaited<ReturnType<typeof mergePr>>;
  try {
    r = await mergePr(root, loadConfig(root).config, ctx.github, id, { now: { channel: 'dashboard', actor: dashboardActor() } });
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
    throw e;
  }
  if (r.action === 'merged') ctx.pool?.poke();
  return json(res, r satisfies PostJobMergeResponse);
}

const CI_BODY = 'body must be {"action": "rerun"|"fix-ci", "head": "<the PR head sha>"}';

/**
 * POST /api/jobs/:id/ci: the Needs you PR row's Re-run failed checks (`rerun`: rerunFailedChecks, through
 * the server's GitHub) or Fix CI (`fix-ci`: fixFailingChecks, a person's rework), as the dashboard. The
 * body pins the head the row showed, so a stale or replayed click never acts on a newer head.
 */
export async function postJobCi(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const id = match.params[0];
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
  const body = parsed.body;
  if (!isMap(body) || Object.keys(body).length !== 2 || (body.action !== 'rerun' && body.action !== 'fix-ci') || typeof body.head !== 'string' || !/^[0-9a-f]{40}$/.test(body.head))
    return jsonStatus(res, 400, { error: CI_BODY });
  const { action, head } = body as unknown as PostJobCiBody;
  const config = loadConfig(root).config;
  let r: PostJobCiResponse;
  try {
    r = action === 'rerun' ? rerunFailedChecks(root, config, ctx.github, id, { actor: dashboardActor(), head }) : await fixFailingChecks(root, config, id, { actor: dashboardActor(), head });
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, 409, { error: e.message });
    throw e;
  }
  if (r.action === 'fix-ci') ctx.pool?.poke();
  return json(res, r satisfies PostJobCiResponse);
}

/** POST /api/jobs/:id/repos: approve or reject the job's repo proposals. */
export async function postJobRepos(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const id = match.params[0];
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
    if (resumeHeld(root, { type: 'resume', job: id }, ctx.drive) === null) {
      enqueue(root, null, { type: 'resume', job: id, from: 'dashboard' });
      ctx.pool?.poke();
      resumed = true;
    }
  }
  return json(res, { ...decided, resumed } satisfies PostJobReposResponse);
}

/** POST /api/shelf: the most jobs one batch acts on, and the longest note. */
const SHELF_MAX = 50;
const SHELF_NOTE_MAX = 2000;
const SHELF_SHAPE = 'body must be {"action": "approve"|"rework"|"unshelve"|"close", "jobs": [{"id", "shelvedAt"}, …] (1 to 50), "note"?: string}';

/** A Shelved list row as the body names it: exactly a valid job id and the `shelved.at` the list showed. */
const isShelfEntry = (e: unknown): e is { id: string; shelvedAt: string } =>
  isMap(e) && Object.keys(e).length === 2 && validJobId(e.id) && typeof e.shelvedAt === 'string' && e.shelvedAt.length > 0 && e.shelvedAt.length <= 64;

/**
 * POST /api/shelf: the Shelved list's batch action, the dashboard's half of the human channel for
 * `forge job unshelve` (docs/architecture/daemon-security.md). Each entry is pinned to the `shelved.at`
 * the list showed, so a stale or replayed click never acts on a job shelved since; each job's outcome
 * is reported, a skip with its reason. Its events carry the dashboard's actor.
 */
export async function postShelf(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const body = parsed.body;
  if (!isMap(body) || !Object.keys(body).every((k) => k === 'action' || k === 'jobs' || k === 'note')) return jsonStatus(res, 400, { error: SHELF_SHAPE });
  const { action, jobs, note } = body;
  if (!(SHELF_ACTIONS as readonly unknown[]).includes(action) || !Array.isArray(jobs) || jobs.length < 1 || jobs.length > SHELF_MAX || !jobs.every(isShelfEntry)) return jsonStatus(res, 400, { error: SHELF_SHAPE });
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > SHELF_NOTE_MAX)) return jsonStatus(res, 400, { error: SHELF_SHAPE });
  const text = typeof note === 'string' && note.trim() ? note : null;
  if (action === 'rework' && !text) return jsonStatus(res, 400, { error: 'rework needs a note' });
  const results = await shelfAction(root, loadConfig(root).config, action as ShelfAction, jobs, { note: text, grant: { channel: 'dashboard', actor: dashboardActor() } });
  // The approve and rework requests go to each job's own session.
  if (results.some((r) => r.outcome === 'approved' || r.outcome === 'reworked')) ctx.pool?.poke();
  return json(res, { results } satisfies PostShelfResponse);
}

/** POST /api/jobs/:id/run and /editor: start the job's dev server, or open its worktree in an editor. */
export async function postRunOrEditor(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const id = match.params[0];
  if (!validJobId(id) || !exists(path.join(jobDir(root, id), 'job.json'))) return jsonStatus(res, 404, { error: validJobId(id) ? `no job ${id}` : 'no such job' });
  if (!isMap(parsed.body)) return jsonStatus(res, 400, { error: 'body must be a JSON object' });
  const job = loadJob(root, id);
  const { config } = loadConfig(root);
  return match.params[1] === 'run' ? runDev(ctx, res, config, job, parsed.body) : editor(ctx, res, config, job);
}

/**
 * Starts the job's dev command, or reports the live one: the only command the dashboard may run,
 * and only in the job's own worktree (containedWorktree), since job.json is agent-writable.
 */
async function runDev(ctx: ServerCtx, res: http.ServerResponse, config: Config, job: LoadedJob, body: Record<string, unknown>): Promise<void> {
  const { root } = ctx;
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
async function editor(ctx: ServerCtx, res: http.ServerResponse, config: Config, job: LoadedJob): Promise<void> {
  const { root } = ctx;
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
 * POST /api/requests: why a resume would only bounce off a live lease that is not the job's own
 * running pool session's (Drive.held), or null. Advisory: the job session's own claim (inside the
 * job lock) decides. Any `args` are ignored here, so `force` or `intake` cannot switch it off. A bad
 * or unknown id is left to enqueue and the inbox.
 */
function resumeHeld(root: string, body: Record<string, any>, drive: ServerCtx['drive']): string | null {
  if (body.type !== 'resume' || !validJobId(body.job) || !exists(path.join(jobDir(root, body.job), 'job.json'))) return null;
  let job: LoadedJob;
  try {
    job = loadJob(root, body.job);
  } catch {
    // A job.json from a newer Forge or a broken one: the inbox reports it, as for an unknown id.
    return null;
  }
  if (!drive(job).held) return null;
  const o = leaseStatus(job);
  return `job ${job.id} is held by session ${o.session} (claimed ${o.since}, lease renewed ${o.renewedAt}, until ${o.expiresAt}); resume it from that session or wait until its lease expires`;
}

/** The requests that would restart or decide a job; a cancel stops it, so it still goes through. */
const RESTARTING = ['resume', 'approve', 'revise-spec', 'rework', 'answer'];

/**
 * POST /api/requests: why a request would restart a shelved job, or null. Only a person takes a job
 * off the shelf, through the Shelved list or `forge job unshelve`, so the request is refused rather
 * than queued. A bad or unknown id is left to enqueue and the inbox, as in resumeHeld.
 */
function shelvedHeld(root: string, body: Record<string, any>): string | null {
  if (!RESTARTING.includes(body.type) || !validJobId(body.job) || !exists(path.join(jobDir(root, body.job), 'job.json'))) return null;
  try {
    if (!isShelved(loadJob(root, body.job))) return null;
  } catch {
    return null;
  }
  return shelvedRefusal(body.job);
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
  // The inbox puts it on `forge retro prepare --mandate`; enqueue checks it again.
  if (body.type === 'retro' && Object.prototype.hasOwnProperty.call(args, 'mandate') && !isMandateIdArg(args.mandate)) return 'args.mandate must be a mandate id';
  return null;
}

function jobDetail(root: string, id: string, projects: string, drive: ServerCtx['drive']): JobDetail {
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
  const order = ['request.md', 'plan.md', 'spec.md', 'design.md', 'mockup.html', 'approval-notes.md', 'questions.md', 'tasks.md', 'build.md', 'verify/', 'review/', 'decision.md', 'runbook.md', 'pr.md', 'pr-feedback.md', 'feedback.md', 'eval-judge.md'];
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
    // Runs reach the dashboard only through `agents[].runs`.
    job: { ...job, agents: withoutRunHistory(job.agents), progress: progress(root, id), ownerStatus: { ...leaseStatus(job), jobSession: drive(job).jobSession } },
    // Session-usage events are accounting records, one per session turn: they would crowd the activity out of the last 400.
    events: events.filter((e) => !isSessionUsageEvent(e)).slice(-400),
    files,
    screenshots: listScreenshots(dir),
    requests: listRequests(root).filter((r) => r.job === id).slice(-MAX_JOB_REQUESTS),
    ...requestExcerpt(root, id),
    requestFromTracker: fromTracker,
    agents: roundAgents(root, job, events, projects),
    ownerTranscript: ((o) => (o ? { session: o.session } : null))(interactiveOwner(root, job, projects)),
  }, knownValues(root, id, loadConfig(root).config));
}

/** request.md without its `# title` line, for the Thread's opening message (null when empty); the polled detail cuts a long one. */
function requestExcerpt(root: string, id: string): Pick<JobDetail, 'request' | 'requestTruncated'> {
  const body = requestBody(root, id);
  const cut = body.length > MAX_REQUEST_EXCERPT;
  return { request: !body ? null : cut ? `${body.slice(0, MAX_REQUEST_EXCERPT)}…` : body, requestTruncated: cut };
}

/** Up to `length` bytes from `start` through an open descriptor, shorter when the file ends first. */
function readFdRange(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let got = 0;
  while (got < length) {
    const n = fs.readSync(fd, buf, got, length - got, start + got);
    if (n === 0) break;
    got += n;
  }
  return buf.subarray(0, got);
}
