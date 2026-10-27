// Mandates over the dashboard's Office page: GET /api/mandates lists them, each with its live report card and,
// once closed, its closing summary's card (closingCard rebuilds it, or it is null), with the latest directives, the
// classes a mandate may be given and a new mandate's defaults; GET /api/mandates/:id adds the owner's
// guidance and goal (token: they are the owner's own words); POST /api/mandates (which picks the id when
// none is sent, as `forge mandate new` does) and /api/mandates/:id/edit|pause|resume|close write as a
// person through the same mandateWrite `forge mandate` calls, so the dashboard gets the CLI's exact
// refusals. A goal mandate's milestone draft: GET /api/mandates/:id/draft
// renders it, and POST decides it through the same decideDraft the CLI calls, pinned to the request and
// digest the card read. Every POST's token, Origin and JSON guard runs before these handlers (start.ts).
import type http from 'node:http';
import { listArchived } from '#core/job/archive.ts';
import { listRequests } from '#core/job/requests.ts';
import { listJobs } from '#core/job/store.ts';
import { loadConfig } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { isMap } from '#core/shape.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { allKnownValues, redactDeep } from '#engine/guard/known-secrets.ts';
import { buildReportCard, closingCard } from '#engine/metrics/report-card.ts';
import { spendLedger } from '#engine/metrics/spend.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { BODY_MAX, effectiveContract, fillDefaults, grantable, isMandateId, isReadable, mandateChain, mandateSummary } from '#office/mandates/contract.ts';
import { readDirectives } from '#office/mandates/directives.ts';
import { decideDraft, draftGate, gateView } from '#office/mandates/gate.ts';
import { readSummary } from '#office/mandates/pass.ts';
import { jobFigures } from '#office/mandates/progress.ts';
import { listMandates, mandateWrite, readMandate } from '#office/mandates/store.ts';
import type { MandateOp } from '#office/mandates/store.ts';
import type { Mandate, MandateInput, ReadMandate } from '#office/mandates/types.ts';
import type {
  Config,
  DraftStatus,
  MandateClosingCard,
  MandateContract,
  MandateDetailResponse,
  MandateDraftResponse,
  MandateRow,
  MandatesResponse,
  PostMandateDraftResponse,
  PostMandateResponse,
} from '#core/types.ts';
import { json, jsonStatus, readJsonBody } from '../http.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';

/** What one request's rows share: the jobs, archive, spend ledger and requests, each read once. */
interface RowCtx {
  jobs: ReturnType<typeof listJobs>;
  archived: ReturnType<typeof listArchived>;
  ledger: ReturnType<typeof spendLedger>;
  requests: ReturnType<typeof listRequests>;
  at: number;
}

const rowCtx = (root: string, config: Config): RowCtx => ({
  // No tracker call: the jobs, spend and starts from the CLI's records, as `forge mandate show` reads them.
  jobs: listJobs(root),
  archived: listArchived(root),
  ledger: spendLedger(root, config, { write: false }),
  requests: listRequests(root),
  at: Date.now(),
});

/** A closed mandate's closing summary card, or null for no summary, an unreadable one or a card closingCard refuses. */
function closingOf(root: string, id: string): MandateClosingCard | null {
  const s = readSummary(root, id);
  return s === null || 'problem' in s ? null : closingCard(s, id);
}

/** One readable mandate as the Office page shows it: never its body or goal. */
export function mandateRow(root: string, config: Config, m: Mandate, all: ReadMandate[], ctx: RowCtx): MandateRow {
  const { effective, capped } = effectiveContract(config, m);
  const f = jobFigures(root, config, m, all, ctx);
  const gate = m.goal === null ? null : draftGate(root, config, m, ctx.requests);
  return {
    ...mandateSummary(m, all),
    effective,
    capped,
    ...mandateChain(m, all),
    progress: {
      jobs: { ...f.counts },
      spend: { usd: f.spentUsd, budget: m.budget.usd },
      started: { jobs: f.started, budget: m.budget.jobs },
      lastActivity: f.lastActivity,
    },
    draft: gate === null ? null : { status: gate.draftStatus as DraftStatus, gate: gate.status },
    // Live, closed mandates too: numbers, 'pending', null, WAITING_ON keys and ISO times only, so the tokenless list may carry it.
    card: buildReportCard(m, f, config, ctx.at),
    // Rebuilt from summary.json by closingCard, the same values only, so the tokenless list may carry it too.
    closing: m.status === 'closed' ? closingOf(root, m.id) : null,
  };
}

/** The contract a new mandate takes when no term is sent: foreman.mandate, its decides cut to the grantable classes, scoring all and no quality floor. */
function newDefaults(config: Config): MandateContract {
  const d = fillDefaults(config, {});
  return {
    until: d.until as MandateContract['until'],
    maxJobs: d.maxJobs!,
    order: d.order as MandateContract['order'],
    decides: d.decides as MandateContract['decides'],
    budget: { usd: d.budgetUsd!, jobs: d.budgetJobs! },
    stall: { cadences: d.stallCadences!, bounces: d.stallBounces! },
    onUnfinishable: d.onUnfinishable as MandateContract['onUnfinishable'],
    scoring: d.scoring as MandateContract['scoring'],
    quality: { pauseBelow: d.pauseBelow ?? null, minScored: d.minScored! },
  };
}

/** GET /api/mandates: every mandate in listMandates order (unreadable ones as {id, problem}), redacted. */
export function getMandates(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const { root } = ctx;
  const { config } = loadConfig(root);
  const all = listMandates(root);
  const rc = rowCtx(root, config);
  const out: MandatesResponse = {
    mandates: all.map((m) => (isReadable(m) ? mandateRow(root, config, m, all, rc) : { id: m.id, problem: m.problem })),
    directives: readDirectives(root, { limit: 50 }),
    grantable: grantable(config),
    defaults: newDefaults(config),
  };
  json(res, redactDeep(out, allKnownValues(root, config)));
}

/** GET /api/mandates/:id: the row, the owner's guidance and goal as written, and its latest 20 directives. */
export function getMandate(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): void {
  const { root } = ctx;
  const id = match.params[0];
  // Checked before any path is built from it.
  if (!isMandateId(id)) return jsonStatus(res, 404, { error: 'no such mandate' });
  const all = listMandates(root);
  const m = all.find((x) => x.id === id);
  if (!m) return jsonStatus(res, 404, { error: `no mandate ${id}` });
  if (!isReadable(m)) return jsonStatus(res, 409, { error: `mandate ${id} can't be read (${m.problem})` });
  const { config } = loadConfig(root);
  const out: MandateDetailResponse = {
    ...mandateRow(root, config, m, all, rowCtx(root, config)),
    body: m.body,
    goal: m.goal,
    directives: readDirectives(root, { mandate: id, limit: 20 }),
  };
  json(res, redactDeep(out, allKnownValues(root, config)));
}

// The body's shape, checked before anything is read: the contract judges the values, as for the CLI.
const STRING_MAX: Record<string, number> = { title: 1000, until: 40, order: 40, onUnfinishable: 40, scoring: 40, body: BODY_MAX, updatedAt: 64 };
const LISTS = ['milestones', 'labels', 'issues', 'decides'];
const NUMBERS = ['maxJobs', 'budgetUsd', 'budgetJobs', 'stallCadences', 'stallBounces', 'minScored'];
const TERMS = ['title', ...LISTS, 'until', ...NUMBERS, 'order', 'onUnfinishable', 'scoring', 'pauseBelow', 'after', 'body'];
const LIST_MAX = 100;
const ENTRY_MAX = 200;
const AFTER_MAX = 60;
const REASON_BODY_MAX = 1000;

const TERMS_SHAPE =
  `title (at most 1000 characters), milestones, labels, issues and decides (lists of at most ${LIST_MAX} strings of at most ${ENTRY_MAX}), ` +
  `until, order, onUnfinishable and scoring (strings), maxJobs, budgetUsd, budgetJobs, stallCadences, stallBounces and minScored (numbers), pauseBelow (a number or null), after (a mandate id or null), body (at most ${BODY_MAX} characters)`;
const SHAPE = {
  new: `body must be {"id"?: <mandate id>, "title": string, ...terms}, terms: ${TERMS_SHAPE}`,
  edit: `body must be {"updatedAt": string, ...terms}, terms: ${TERMS_SHAPE}`,
  status: `body must be {"reason"?: string of at most ${REASON_BODY_MAX} characters | null}`,
  resume: 'body must be {}',
};

/** Whether `v` fits the cap its key has: a string, list, number or after of the right size. */
function termOk(k: string, v: unknown): boolean {
  if (k in STRING_MAX) return typeof v === 'string' && v.length <= STRING_MAX[k]!;
  if (LISTS.includes(k)) return Array.isArray(v) && v.length <= LIST_MAX && v.every((e) => typeof e === 'string' && e.length <= ENTRY_MAX);
  if (NUMBERS.includes(k)) return typeof v === 'number' && Number.isFinite(v);
  if (k === 'after') return v === null || (typeof v === 'string' && v.length <= AFTER_MAX);
  if (k === 'pauseBelow') return v === null || (typeof v === 'number' && Number.isFinite(v));
  return false;
}

/** A new or edit body as MandateInput, or null when its shape is wrong: an unknown key, a missing required one or a value over its cap. */
function termsInput(b: unknown, op: 'new' | 'edit'): MandateInput | null {
  if (!isMap(b)) return null;
  const allowed = op === 'new' ? ['id', ...TERMS] : ['updatedAt', ...TERMS];
  if (!Object.keys(b).every((k) => allowed.includes(k))) return null;
  // An absent id is picked by mandateWrite; one sent must be a mandate id (so null is refused).
  if (op === 'new' && (typeof b.title !== 'string' || (Object.hasOwn(b, 'id') && !isMandateId(b.id)))) return null;
  if (op === 'edit' && typeof b.updatedAt !== 'string') return null;
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (k === 'id') continue;
    if (!termOk(k, v)) return null;
    if (k !== 'updatedAt') input[k] = k === 'after' && v === '' ? null : v;
  }
  return input as MandateInput;
}

/** A pause or close body's reason, undefined for none, or false when its shape is wrong. */
function statusReason(b: unknown): string | null | undefined | false {
  if (!isMap(b) || !Object.keys(b).every((k) => k === 'reason')) return false;
  if (b.reason === undefined || b.reason === null) return b.reason as null | undefined;
  return typeof b.reason === 'string' && b.reason.length <= REASON_BODY_MAX ? b.reason : false;
}

/** One write through mandateWrite, as a person on the dashboard; a refusal is 404 (no such mandate) or 409, and writes nothing. */
function write(ctx: ServerCtx, res: http.ServerResponse, op: MandateOp, given: string | null, o: { input?: MandateInput; reason?: string | null; updatedAt?: string }): void {
  const { root } = ctx;
  const { config } = loadConfig(root);
  let changed: boolean;
  let id: string;
  try {
    ({ changed, id } = mandateWrite(root, config, op, given, { ...o, actor: dashboardActor() }));
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, e.code === 'not_found' ? 404 : 409, { error: e.message });
    throw e;
  }
  const all = listMandates(root);
  const m = all.find((x) => x.id === id);
  if (!isReadable(m)) return jsonStatus(res, 409, { error: `mandate ${id} can't be read` });
  const out: PostMandateResponse = { ok: true, changed, mandate: mandateRow(root, config, m, all, rowCtx(root, config)) };
  json(res, redactDeep(out, allKnownValues(root, config)));
}

/** POST /api/mandates: a new active mandate, under a picked id when none is sent; every term not sent comes from foreman.mandate. */
export async function postMandate(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const input = termsInput(parsed.body, 'new');
  if (!input) return jsonStatus(res, 400, { error: SHAPE.new });
  const body = parsed.body as { id?: string };
  write(ctx, res, 'new', Object.hasOwn(body, 'id') ? body.id! : null, { input });
}

/** POST /api/mandates/:id/edit|pause|resume|close: one handler, switching on the action. */
export async function postMandateAction(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const b = parsed.body;
  const op = match.params[1] as Exclude<MandateOp, 'new'>;
  let o: { input?: MandateInput; reason?: string | null; updatedAt?: string };
  if (op === 'edit') {
    const input = termsInput(b, 'edit');
    if (!input) return jsonStatus(res, 400, { error: SHAPE.edit });
    o = { input, updatedAt: (b as { updatedAt: string }).updatedAt };
  } else if (op === 'resume') {
    if (!isMap(b) || Object.keys(b).length) return jsonStatus(res, 400, { error: SHAPE.resume });
    o = {};
  } else {
    const reason = statusReason(b);
    if (reason === false) return jsonStatus(res, 400, { error: SHAPE.status });
    o = { reason };
  }
  const id = match.params[0];
  if (!isMandateId(id)) return jsonStatus(res, 404, { error: 'no such mandate' });
  write(ctx, res, op, id, o);
}

/** GET /api/mandates/:id/draft: the draft, the goal as written, the gate's status, digest and owner, and a filing record's view. */
export async function getMandateDraft(ctx: ServerCtx, _req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const id = match.params[0];
  // Checked before any path is built from it.
  if (!isMandateId(id)) return jsonStatus(res, 404, { error: 'no such mandate' });
  const m = readMandate(root, id);
  if (!isReadable(m)) return m.problem === 'no such mandate' ? jsonStatus(res, 404, { error: `no mandate ${id}` }) : jsonStatus(res, 409, { error: `mandate ${id} can't be read (${m.problem})` });
  if (m.goal === null) return jsonStatus(res, 404, { error: `mandate ${id} has no goal` });
  const { config } = loadConfig(root);
  const { read, gate, leftForHuman } = gateView(root, config, m);
  const draft = read.draft ? (({ schemaVersion: _v, mandate: _m, digest: _d, ...body }) => body)(read.draft) : null;
  const out: MandateDraftResponse = {
    mandate: m.id,
    title: m.title,
    goal: m.goal,
    status: gate.status,
    request: read.draft?.request ?? null,
    digest: read.draft?.digest ?? null,
    owner: gate.owner,
    leftForHuman,
    draft,
    filing: gate.filing,
  };
  return json(res, redactDeep(out, allKnownValues(root, config)));
}

const BODY_KEYS = ['decision', 'request', 'digest', 'note'];
const DECISIONS = ['approve', 'revise', 'reject'];
const REQUEST_ID = /^\d+-[A-Za-z0-9]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
// Twice the note rule's 2000: a longer note is still the right shape, and decideDraft refuses it with the rule.
const NOTE_BODY_MAX = 4000;
const DRAFT_SHAPE = 'body must be exactly {"decision": "approve"|"revise"|"reject", "request": <request id>, "digest": <64 hex>, "note"?: string|null}';

/**
 * POST /api/mandates/:id/draft: a person's decision on the draft the card rendered. The body's shape is
 * checked before anything is read (400); every refusal decideDraft raises (a stale request or digest, a
 * missing note on revise, a secret found, a decision already running, a tracker failure) is a 409.
 */
export async function postMandateDraft(ctx: ServerCtx, req: http.IncomingMessage, res: http.ServerResponse, match: RouteMatch): Promise<void> {
  const { root } = ctx;
  const parsed = await readJsonBody(req);
  if ('error' in parsed) return jsonStatus(res, 400, { error: parsed.error });
  const b = parsed.body;
  const shaped =
    isMap(b) &&
    Object.keys(b).every((k) => BODY_KEYS.includes(k)) &&
    DECISIONS.includes(b.decision as string) &&
    typeof b.request === 'string' &&
    REQUEST_ID.test(b.request) &&
    typeof b.digest === 'string' &&
    DIGEST.test(b.digest) &&
    (b.note === undefined || b.note === null || (typeof b.note === 'string' && b.note.length <= NOTE_BODY_MAX));
  if (!shaped) return jsonStatus(res, 400, { error: DRAFT_SHAPE });
  const body = b as { decision: 'approve' | 'revise' | 'reject'; request: string; digest: string; note?: string | null };
  const id = match.params[0];
  if (!isMandateId(id)) return jsonStatus(res, 404, { error: 'no such mandate' });
  const { config } = loadConfig(root);
  let out: PostMandateDraftResponse;
  try {
    // An empty note is no note: revise refuses it, approve and reject take none.
    const note = typeof body.note === 'string' && body.note.trim() ? body.note : null;
    out = await decideDraft(root, config, id, body.decision, {
      request: body.request,
      digest: body.digest,
      note,
      foreman: false,
      actor: dashboardActor(),
      tracker: () => loadTracker(root, config),
      env: { ...process.env, FORGE_DAEMON: undefined },
    });
  } catch (e) {
    if (e instanceof ForgeError) return jsonStatus(res, e.code === 'not_found' ? 404 : 409, { error: e.message });
    throw e;
  }
  return json(res, redactDeep(out, allKnownValues(root, config)));
}
