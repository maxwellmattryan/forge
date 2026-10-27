// The Foreman page (#/p/<project>/foreman): its panels, the Office panel's mandates, assistant foremen and directives,
// the editor's POST bodies, the mandate badge on a job, and the GETs and POSTs of /api/mandates
// (lib/server/routes/mandates.ts). Every string from a mandate, a directive or a request is owner, session or tracker
// text: the components render it as text. Plain TS, so a test can pin it.
import { post } from './focus.ts';
import { api } from './util.ts';
import { MANDATE_ID_SOURCE, assistantNumber } from './types.ts';
import type {
  DaemonPoolState,
  DaemonStatus,
  Directive,
  ForgeRequest,
  MandateDetailResponse,
  MandateRow,
  MandatesResponse,
  PostMandateBody,
  PostMandateEditBody,
  PostMandateResponse,
  UnreadableMandateRow,
} from './types.ts';

// ---------- the page's panels ----------

/** The Foreman page's panels, in tab order; the first is the one the page opens on. A new panel is one entry here. */
export const FOREMAN_PANELS = ['office'] as const;
export type ForemanPanel = (typeof FOREMAN_PANELS)[number];
export const DEFAULT_FOREMAN_PANEL: ForemanPanel = FOREMAN_PANELS[0];

/** The panel Left/Right (wrapping), Home or End moves to from `current`, or null for other keys (as the drawer's tabs). */
export function panelKey(current: ForemanPanel, key: string, panels: readonly ForemanPanel[] = FOREMAN_PANELS): ForemanPanel | null {
  const n = panels.length;
  const i = Math.max(0, panels.indexOf(current));
  if (key === 'ArrowLeft') return panels[(i - 1 + n) % n]!;
  if (key === 'ArrowRight') return panels[(i + 1) % n]!;
  if (key === 'Home') return panels[0]!;
  if (key === 'End') return panels[n - 1]!;
  return null;
}

// ---------- the API ----------

const mandatePath = (id: string): string => `/api/mandates/${encodeURIComponent(id)}`;

/** GET /api/mandates: every mandate, the latest directives, the grantable classes and a new mandate's defaults. */
export const fetchMandates = (token: string): Promise<MandatesResponse> => api<MandatesResponse>('/api/mandates', { headers: { 'x-forge-token': token } });

/** GET /api/mandates/:id with the token: the row plus the owner's guidance and goal. */
export const fetchMandate = (id: string, token: string): Promise<MandateDetailResponse> => api<MandateDetailResponse>(mandatePath(id), { headers: { 'x-forge-token': token } });

/** POST /api/mandates; throws with the server's `error`. */
export const postMandate = (body: PostMandateBody, token: string, fetchImpl: typeof fetch = fetch): Promise<PostMandateResponse> => post<PostMandateResponse>('/api/mandates', body, token, fetchImpl);

/** POST /api/mandates/:id/edit; throws with the server's `error`. */
export const postMandateEdit = (id: string, body: PostMandateEditBody, token: string, fetchImpl: typeof fetch = fetch): Promise<PostMandateResponse> =>
  post<PostMandateResponse>(`${mandatePath(id)}/edit`, body, token, fetchImpl);

export type MandateStatusAction = 'pause' | 'resume' | 'close';

/** POST /api/mandates/:id/pause|resume|close; a pause or close sends its one-line reason, null when empty. */
export function postMandateStatus(id: string, action: MandateStatusAction, reason: string, token: string, fetchImpl: typeof fetch = fetch): Promise<PostMandateResponse> {
  const body = action === 'resume' ? {} : { reason: reason.trim() || null };
  return post<PostMandateResponse>(`${mandatePath(id)}/${action}`, body, token, fetchImpl);
}

// ---------- the editor ----------

/** The editor's fields as typed: lists as comma-separated text, numbers as text, `after` '' for none, `decides` null until touched. */
export interface MandateForm {
  title: string;
  milestones: string;
  labels: string;
  issues: string;
  until: string;
  maxJobs: string;
  order: string;
  /** null: not touched, so a new mandate takes the default classes. */
  decides: string[] | null;
  budgetUsd: string;
  budgetJobs: string;
  stallCadences: string;
  stallBounces: string;
  onUnfinishable: string;
  after: string;
  body: string;
}

/** An empty form: a new mandate's, before the defaults show as placeholders. */
export const blankForm = (): MandateForm => ({
  title: '',
  milestones: '',
  labels: '',
  issues: '',
  until: '',
  maxJobs: '',
  order: '',
  decides: null,
  budgetUsd: '',
  budgetJobs: '',
  stallCadences: '',
  stallBounces: '',
  onUnfinishable: '',
  after: '',
  body: '',
});

/** The form for editing `m`: every term as it stands, `body` its guidance. */
export function formOf(m: MandateRow, body: string): MandateForm {
  const c = m.contract;
  return {
    title: m.title,
    milestones: m.scope.milestones.join(', '),
    labels: m.scope.labels.join(', '),
    issues: m.scope.issues.join(', '),
    until: c.until,
    maxJobs: String(c.maxJobs),
    order: c.order,
    decides: [...c.decides],
    budgetUsd: String(c.budget.usd),
    budgetJobs: String(c.budget.jobs),
    stallCadences: String(c.stall.cadences),
    stallBounces: String(c.stall.bounces),
    onUnfinishable: c.onUnfinishable,
    after: m.after ?? '',
    body,
  };
}

/** A comma-separated list as entries: each trimmed, empty ones dropped. */
export const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** A goal mandate before its draft is filed: its scope stays empty, so the editor neither shows nor sends it. */
export const inIntake = (m: Pick<MandateRow, 'intake' | 'filedAt'>): boolean => m.intake && m.filedAt === null;

const NUMBER_KEYS = ['maxJobs', 'budgetUsd', 'budgetJobs', 'stallCadences', 'stallBounces'] as const;
const LIST_KEYS = ['milestones', 'labels', 'issues'] as const;
const CHOICE_KEYS = ['until', 'order', 'onUnfinishable'] as const;

/** A number field as sent: the server's contract judges its range, so anything typed is sent as Number reads it. */
const numberOf = (text: string): number => Number(text.trim());

/** POST /api/mandates's body: the title, then each filled term; the server picks the id and takes the rest from foreman.mandate. */
export function newMandateBody(form: MandateForm): PostMandateBody {
  const body: PostMandateBody = { title: form.title.trim() };
  for (const k of LIST_KEYS) {
    const list = splitList(form[k]);
    if (list.length) body[k] = list;
  }
  for (const k of CHOICE_KEYS) if (form[k]) body[k] = form[k];
  for (const k of NUMBER_KEYS) if (form[k].trim()) body[k] = numberOf(form[k]);
  if (form.decides !== null) body.decides = [...form.decides];
  body.after = form.after || null;
  if (form.body.trim()) body.body = form.body;
  return body;
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a: readonly string[], b: readonly string[]): boolean => sameList([...a].sort(), [...b].sort());

/**
 * POST /api/mandates/:id/edit's body: only the terms that differ from the loaded mandate `m` (and its guidance
 * `body`), plus the `updatedAt` it loaded, so an edit made elsewhere since is refused rather than overwritten. A
 * goal mandate in intake never sends its scope; a cleared number field is left as it was.
 */
export function editMandateBody(m: MandateRow, loaded: { body: string }, form: MandateForm): PostMandateEditBody {
  const out: PostMandateEditBody = { updatedAt: m.updatedAt };
  const c = m.contract;
  if (form.title.trim() !== m.title) out.title = form.title.trim();
  if (!inIntake(m)) {
    for (const k of LIST_KEYS) {
      const list = splitList(form[k]);
      if (!sameList(list, m.scope[k])) out[k] = list;
    }
  }
  if (form.until && form.until !== c.until) out.until = form.until;
  if (form.order && form.order !== c.order) out.order = form.order;
  if (form.onUnfinishable && form.onUnfinishable !== c.onUnfinishable) out.onUnfinishable = form.onUnfinishable;
  const was: Record<(typeof NUMBER_KEYS)[number], number> = { maxJobs: c.maxJobs, budgetUsd: c.budget.usd, budgetJobs: c.budget.jobs, stallCadences: c.stall.cadences, stallBounces: c.stall.bounces };
  for (const k of NUMBER_KEYS) if (form[k].trim() && numberOf(form[k]) !== was[k]) out[k] = numberOf(form[k]);
  if (form.decides !== null && !sameSet(form.decides, c.decides)) out.decides = [...form.decides];
  if ((form.after || null) !== m.after) out.after = form.after || null;
  if (form.body !== loaded.body) out.body = form.body;
  return out;
}

/** Whether `id` is a mandate id: MANDATE_ID_SOURCE, and never `none`. */
export const isMandateId = (id: string): boolean => new RegExp(MANDATE_ID_SOURCE).test(id) && id !== 'none';

// ---------- the mandates list ----------

export const isUnreadable = (m: MandateRow | UnreadableMandateRow): m is UnreadableMandateRow => 'problem' in m;

/** The open mandates in creation order (the unreadable ones among them), then the closed ones, folded under their count. */
export function mandateGroups(rows: readonly (MandateRow | UnreadableMandateRow)[]): { open: (MandateRow | UnreadableMandateRow)[]; closed: MandateRow[] } {
  const open: (MandateRow | UnreadableMandateRow)[] = [];
  const closed: MandateRow[] = [];
  for (const m of rows) {
    if (!isUnreadable(m) && m.state === 'closed') closed.push(m);
    else open.push(m);
  }
  return { open, closed };
}

/** A mandate state's chip tone: running work is ok, a chain link not yet started info, a pause warn, a closed one muted. */
export const STATE_TONE: Record<MandateRow['state'], string> = { active: 'ok', waiting: 'info', paused: 'warn', closed: 'muted' };

/** A directive action's chip tone: the office session's choices are neutral or live, the pass's enforcements warn or bad. */
export const DIRECTIVE_TONE: Record<Directive['action'], string> = { start: 'ok', resume: 'ok', note: 'muted', skip: 'muted', pause: 'warn', close: 'muted', stall: 'warn', park: 'warn', cancel: 'bad', release: 'info' };

export type MandateAction = 'edit' | 'pause' | 'resume' | 'close';

/** What a card offers: an active (or waiting) mandate is edited, paused or closed; a paused one edited, resumed or closed; a closed or unreadable one nothing. */
export function mandateActions(m: MandateRow | UnreadableMandateRow): MandateAction[] {
  if (isUnreadable(m)) return [];
  if (m.status === 'active') return ['edit', 'pause', 'close'];
  if (m.status === 'paused') return ['edit', 'resume', 'close'];
  return [];
}

// ---------- assistant foremen ----------

/** An assistant foreman's current gate: the job it decides, or a goal mandate's milestone-approval gate. */
export type AssistantGate = { job: string; gate: string } | { mandate: string; gate: string };

export interface AssistantRow {
  scope: string;
  n: number;
  status: DaemonStatus;
  gate: AssistantGate | null;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One row per assistant foreman in number order, with the in-progress gate request its session claimed, if any. */
export function assistantRows(daemons: Pick<DaemonPoolState, 'assistants'> | null | undefined, requests: readonly ForgeRequest[]): AssistantRow[] {
  const assistants = daemons?.assistants ?? {};
  return Object.entries(assistants)
    .map(([scope, s]) => {
      const r = s.sessionId ? requests.find((x) => x.type === 'gate' && x.status === 'in-progress' && x.session === s.sessionId) : undefined;
      const gate: AssistantGate | null = !r ? null : r.job ? { job: r.job, gate: text(r.args?.gate) } : { mandate: text(r.args?.mandate), gate: text(r.args?.gate) };
      return { scope, n: assistantNumber(scope), status: s.status, gate };
    })
    .sort((a, b) => a.n - b.n);
}

/** The gate requests no assistant foreman has claimed yet. */
export const pendingGates = (requests: readonly ForgeRequest[]): number => requests.filter((r) => r.type === 'gate' && r.status === 'pending').length;

// ---------- directives ----------

/** The directives newest first (the API sends them oldest first). */
export const directiveFeed = (directives: readonly Directive[]): Directive[] => [...directives].reverse().sort((a, b) => b.ts.localeCompare(a.ts));

/** Who a directive is from: the Foreman (`foreman`, the label the page passes), else the login, else the source. */
export const directiveActor = (d: Pick<Directive, 'actor'>, foreman = 'Foreman'): string => (d.actor?.source === 'foreman' ? foreman : (d.actor?.login ?? d.actor?.source ?? '—'));

// ---------- the badge ----------

/** A job's mandate chip: its id when `mandate` is a mandate id, else null (no chip, and the card keeps its shape). */
export function mandateBadge(job: { mandate?: unknown }): { id: string } | null {
  const m = job.mandate;
  return typeof m === 'string' && isMandateId(m) ? { id: m } : null;
}
