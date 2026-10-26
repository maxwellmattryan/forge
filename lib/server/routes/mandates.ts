// A goal mandate's milestone draft over the dashboard: GET /api/mandates/:id/draft renders it, and POST
// decides it as a person through the same decideDraft the CLI calls, pinned to the request and digest the
// card read. The POST's token, Origin and JSON guard runs before this handler (start.ts).
import type http from 'node:http';
import { loadConfig } from '#core/config/load.ts';
import { ForgeError } from '#core/errors.ts';
import { isMap } from '#core/shape.ts';
import { dashboardActor } from '#integrations/github/actor.ts';
import { allKnownValues, redactDeep } from '#engine/guard/known-secrets.ts';
import { loadTracker } from '#engine/trackers/load.ts';
import { isMandateId, isReadable } from '#office/mandates/contract.ts';
import { decideDraft, gateView } from '#office/mandates/gate.ts';
import { readMandate } from '#office/mandates/store.ts';
import type { MandateDraftResponse, PostMandateDraftResponse } from '#core/types.ts';
import { json, jsonStatus, readJsonBody } from '../http.ts';
import type { RouteMatch, ServerCtx } from '../types.ts';

const BODY_KEYS = ['decision', 'request', 'digest', 'note'];
const DECISIONS = ['approve', 'revise', 'reject'];
const REQUEST_ID = /^\d+-[A-Za-z0-9]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
// Twice the note rule's 2000: a longer note is still the right shape, and decideDraft refuses it with the rule.
const NOTE_BODY_MAX = 4000;
const SHAPE = 'body must be exactly {"decision": "approve"|"revise"|"reject", "request": <request id>, "digest": <64 hex>, "note"?: string|null}';

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
  if (!shaped) return jsonStatus(res, 400, { error: SHAPE });
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
