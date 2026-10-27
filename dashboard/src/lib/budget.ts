// Per-job budget use, derived client-side from fields /api/state already serves. Mirrors
// effectiveLimits/measureJob/exceededKeys in lib/engine/metrics/budget.ts (the dashboard cannot import lib/).
// No DOM access, so node:test can import it. The view models return raw strings: BudgetChip, BudgetCell and
// BudgetPanel render them, and Svelte escapes them. The budget gate's Approve builds its POST /api/jobs/:id/budget
// body from the note, and decides whether to queue its approve request, here.
import { num, usd, ago } from './util.ts';
import { projectApi } from './project.ts';
import type { BudgetKey, BudgetLimits, DaemonJobBudget, Job, PostJobBudgetBody, PostJobBudgetResponse } from './types.ts';

export const BUDGET_KEYS = ['tokens', 'usd', 'minutes', 'changedLines', 'verifyRetries'] as const satisfies readonly BudgetKey[];
export const BUDGET_LABELS = { tokens: 'Tokens', usd: 'Est. cost', minutes: 'Agent minutes', changedLines: 'Changed lines', verifyRetries: 'Verify retries' };
const WARN_AT = 0.8;

/** Hand-edited job.json can hold anything; only finite numbers are rendered. */
const fin = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {});

export function fmt(key: string, v: number | null): string {
  if (v === null) return '—';
  if (key === 'usd') return usd(v);
  if (key === 'minutes') return `${v.toFixed(1)} min`;
  if (key === 'verifyRetries') return String(Math.round(v));
  return num(v);
}

export interface BudgetRow {
  key: string;
  label: string;
  used: number | null;
  limit: number | null;
  ackBase: number;
  counted: number | null;
  fraction: number | null;
  tone: 'ok' | 'warn' | 'bad' | null;
}

/** job.json can be hand-edited, so despite the type every field is read through obj()/fin(). */
type JobInput = Job | null | undefined;

/** The keys daemon.jobBudget fills: lib/engine/metrics/budget.ts SPEND_KEYS. */
const SPEND_KEYS = ['tokens', 'usd', 'minutes'] as const;

/** /api/state's daemon.jobBudget when the daemon is on, else null: what budgetRows fills a job with no spend limit from. */
export function unattendedDefault(config: { daemon?: { enabled?: boolean; jobBudget?: DaemonJobBudget } } | null | undefined): DaemonJobBudget {
  const d = config?.daemon;
  return d?.enabled === true && d.jobBudget && typeof d.jobBudget === 'object' ? d.jobBudget : null;
}

export function budgetRows(job: JobInput, configBudget: BudgetLimits | null | undefined, jobDefault: DaemonJobBudget = null): BudgetRow[] {
  const j = obj(job);
  const b = obj(j.budget);
  const usage = obj(j.usage);
  const overrides = obj(b.limits);
  const ack = obj(b.ack);
  // effectiveLimits' rule: each spend key unset in config and absent from the job's overrides gets
  // the unattended default's value for it.
  const fill = obj(jobDefault);
  const cfg: Record<string, unknown> = { ...obj(configBudget) };
  for (const k of SPEND_KEYS) cfg[k] = fin(cfg[k]) ?? (jobDefault && !Object.hasOwn(overrides, k) ? fin(fill[k]) : null);
  // byModel holds the same runs as byRole, so only byRole is summed.
  const ms = Object.values(obj(usage.byRole)).reduce((n: number, r) => n + (fin(obj(r).durationMs) ?? 0), 0);
  // The metered spend the last check saw can be above the reported total (measureJob): show the larger, so the
  // drawer agrees with what parked the job.
  const checked = obj(obj(b.lastCheck).used);
  const larger = (reported: unknown, seen: unknown): number | null => {
    const r = fin(reported ?? 0);
    const s = fin(seen);
    return r === null ? s : s === null ? r : Math.max(r, s);
  };
  const used: Record<string, number | null> = {
    tokens: larger(usage.totalTokens, checked.tokens),
    usd: larger(usage.estCostUsd, checked.usd),
    minutes: ms / 60000,
    changedLines: fin(checked.changedLines),
    verifyRetries: fin(obj(j.verifyRetries)[String(j.round)] ?? 0),
  };
  return BUDGET_KEYS.map((key) => {
    // An explicit null override means unlimited, so presence (not value) decides.
    const limit = fin(Object.hasOwn(overrides, key) ? overrides[key] : cfg[key]);
    const a = obj(ack[key]);
    const ackBase = ack[key] && (key !== 'verifyRetries' || a.round === j.round) ? fin(a.used) ?? 0 : 0;
    const u = used[key];
    const counted = u === null ? null : u - ackBase;
    const fraction = limit === null || counted === null ? null : limit === 0 ? (counted > 0 ? Infinity : 0) : counted / limit;
    const tone = fraction === null || counted === null || limit === null ? null : counted > limit ? 'bad' : fraction >= WARN_AT ? 'warn' : 'ok';
    const label = key === 'verifyRetries' && fin(j.round) !== null ? `${BUDGET_LABELS[key]} (round ${j.round})` : BUDGET_LABELS[key];
    return { key, label, used: u, limit, ackBase, counted, fraction, tone };
  });
}

export function budgetWorst(rows: BudgetRow[]): BudgetRow | null {
  let worst: BudgetRow | null = null;
  for (const r of rows) if (r.tone && r.fraction !== null && (!worst || r.fraction > (worst.fraction as number))) worst = r;
  return worst;
}

const quiet = (job: JobInput) => ['done', 'cancelled'].includes(job?.state as string) || (job?.state === 'waiting' && job?.waitingOn === 'budget');

/** The board card's budget chip: warn at 80% of a limit, bad over it. */
export interface BudgetChipModel {
  tone: 'warn' | 'bad';
  text: string;
  title: string;
}

/** Null below 80%, and for a finished job or one already waiting on its budget (its gate says so). */
export function budgetChipModel(job: JobInput, configBudget: BudgetLimits | null | undefined, jobDefault: DaemonJobBudget = null): BudgetChipModel | null {
  if (quiet(job)) return null;
  const w = budgetWorst(budgetRows(job, configBudget, jobDefault));
  if (!w || (w.tone !== 'warn' && w.tone !== 'bad')) return null;
  const text = w.tone === 'bad' ? 'over budget' : `budget ${Math.round((w.fraction as number) * 100)}%`;
  return { tone: w.tone, text, title: `${w.label} ${fmt(w.key, w.counted)}/${fmt(w.key, w.limit)}` };
}

/** The jobs table's Budget cell: the chip when there is one, else the worst row's percent, else nothing measured. */
export type BudgetCellModel = { kind: 'chip'; chip: BudgetChipModel } | { kind: 'text'; text: string } | { kind: 'none' };

export function budgetCellModel(job: JobInput, configBudget: BudgetLimits | null | undefined, jobDefault: DaemonJobBudget = null): BudgetCellModel {
  const chip = budgetChipModel(job, configBudget, jobDefault);
  if (chip) return { kind: 'chip', chip };
  const w = budgetWorst(budgetRows(job, configBudget, jobDefault));
  if (!w) return { kind: 'none' };
  const f = w.fraction as number;
  return { kind: 'text', text: Number.isFinite(f) ? `${Math.round(f * 100)}%` : 'over' };
}

/** One row of the budget panel: `value` then the muted `note`, and the bar only for a toned row. */
export interface BudgetRowView {
  key: string;
  label: string;
  value: string;
  note: string | null;
  bad: boolean;
  bar: { tone: 'ok' | 'warn' | 'bad'; width: number } | null;
}

function rowView(r: BudgetRow): BudgetRowView {
  let value: string;
  let note: string | null = null;
  if (r.limit === null) {
    value = fmt(r.key, r.used);
    note = '· unlimited';
  } else if (r.counted === null) {
    value = `— / ${fmt(r.key, r.limit)}`;
    note = 'not measured yet';
  } else {
    value = `${fmt(r.key, r.counted)} / ${fmt(r.key, r.limit)}`;
    if (r.ackBase > 0) note = `· ${fmt(r.key, r.ackBase)} acknowledged`;
  }
  const bar = r.tone && r.fraction !== null ? { tone: r.tone, width: Math.round(Math.min(Math.max(r.fraction, 0), 1) * 100) } : null;
  return { key: r.key, label: r.label, value, note, bad: r.tone === 'bad', bar };
}

const NOTE_SET = /^(tokens|usd|minutes|changedLines|verifyRetries)=\S+$/;

/** The budget gate note's `key=value` words for budget keys, the last one per key, in first-seen key order. */
export function budgetNoteSets(note: string): string[] {
  const byKey = new Map<string, string>();
  for (const word of String(note ?? '').split(/[\s,]+/)) {
    const m = NOTE_SET.exec(word);
    if (m) byKey.set(m[1], word);
  }
  return [...byKey.values()];
}

/** What the budget gate's Approve POSTs: the limits its note names, else an acknowledgement. */
export function budgetApproveBody(note: string): PostJobBudgetBody {
  const set = budgetNoteSets(note);
  return set.length ? { set } : { ack: true };
}

/** POST /api/jobs/:id/budget. Throws with the server's `error` field, else its text, else the status text. */
export async function postJobBudget(id: string, body: PostJobBudgetBody, fetchImpl: typeof fetch = fetch): Promise<PostJobBudgetResponse> {
  const res = await fetchImpl(projectApi(`/api/jobs/${encodeURIComponent(id)}/budget`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {}
  const error = parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string' ? (parsed as { error: string }).error : '';
  if (!res.ok) throw new Error(error || text || res.statusText);
  return parsed as PostJobBudgetResponse;
}

/** Whether the budget gate's Approve goes on to queue the approve request, or toasts this (bad) text and keeps the note. */
export type BudgetApproveOutcome = { proceed: true } | { toast: string };

/** The toast texts budgetApprove picks from; the caller translates them (inbox.budgetStillOver, inbox.budgetFailed). */
export interface BudgetApproveMessages {
  stillOver: (keys: string) => string;
  failed: (error: string) => string;
}

/**
 * The budget gate's Approve, before its approve request: raise (the note's key=value limits) or acknowledge the budget
 * through the budget route. It proceeds only when that worked and no key is still over.
 */
export async function budgetApprove(id: string, note: string, msg: BudgetApproveMessages, fetchImpl: typeof fetch = fetch): Promise<BudgetApproveOutcome> {
  try {
    const r = await postJobBudget(id, budgetApproveBody(note), fetchImpl);
    return r.stillExceeded.length ? { toast: msg.stillOver(r.stillExceeded.join(', ')) } : { proceed: true };
  } catch (err) {
    return { toast: msg.failed(err instanceof Error ? err.message : String(err)) };
  }
}

/** The drawer's Budget card (and, compact, the budget gate's rows): one row per BUDGET_KEYS entry and the checked line, null when compact. */
export function budgetPanelModel(job: JobInput, configBudget: BudgetLimits | null | undefined, { compact = false, jobDefault = null }: { compact?: boolean; jobDefault?: DaemonJobBudget } = {}): { rows: BudgetRowView[]; checked: string | null } {
  const rows = budgetRows(job, configBudget, jobDefault).map(rowView);
  if (compact) return { rows, checked: null };
  const lc = obj(obj(obj(job).budget).lastCheck);
  const checked = Object.keys(lc).length
    ? `checked ${Number.isFinite(Date.parse(lc.at)) ? ago(lc.at) : '—'} · ${lc.checkpoint ?? '—'}`
    : 'not checked yet';
  return { rows, checked };
}
