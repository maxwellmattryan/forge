// @ts-check
// Per-job budget use, derived client-side from fields /api/state already serves. Mirrors
// effectiveLimits/measureBudget/exceededKeys in lib/budget.mjs (the dashboard cannot import lib/).
// No DOM access, so node:test can import it.
import { esc, num, usd, ago, toneChip } from './util.js';

export const BUDGET_KEYS = /** @type {const} */ (['tokens', 'usd', 'minutes', 'changedLines', 'verifyRetries']);
export const BUDGET_LABELS = { tokens: 'Tokens', usd: 'Est. cost', minutes: 'Agent minutes', changedLines: 'Changed lines', verifyRetries: 'Verify retries' };
const WARN_AT = 0.8;
const BAR = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad' };

/** Hand-edited job.json can hold anything; only finite numbers are rendered. @param {unknown} v */
const fin = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** @param {unknown} v @returns {Record<string, any>} */
const obj = (v) => (v && typeof v === 'object' ? /** @type {Record<string, any>} */ (v) : {});

/** @param {string} key @param {number|null} v */
export function fmt(key, v) {
  if (v === null) return '—';
  if (key === 'usd') return usd(v);
  if (key === 'minutes') return `${v.toFixed(1)} min`;
  if (key === 'verifyRetries') return String(Math.round(v));
  return num(v);
}

/**
 * @typedef {{key:string, label:string, used:number|null, limit:number|null, ackBase:number,
 *   counted:number|null, fraction:number|null, tone:'ok'|'warn'|'bad'|null}} BudgetRow
 * @param {any} job @param {any} configBudget @returns {BudgetRow[]}
 */
export function budgetRows(job, configBudget) {
  const j = obj(job);
  const b = obj(j.budget);
  const usage = obj(j.usage);
  const overrides = obj(b.limits);
  const cfg = obj(configBudget);
  const ack = obj(b.ack);
  // byModel holds the same runs as byRole, so only byRole is summed.
  const ms = Object.values(obj(usage.byRole)).reduce((n, r) => n + (fin(obj(r).durationMs) ?? 0), 0);
  /** @type {Record<string, number|null>} */
  const used = {
    tokens: fin(usage.totalTokens ?? 0),
    usd: fin(usage.estCostUsd ?? 0),
    minutes: ms / 60000,
    changedLines: fin(obj(obj(b.lastCheck).used).changedLines),
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

/** @param {BudgetRow[]} rows @returns {BudgetRow|null} */
export function budgetWorst(rows) {
  let worst = null;
  for (const r of rows) if (r.tone && r.fraction !== null && (!worst || r.fraction > /** @type {number} */ (worst.fraction))) worst = r;
  return worst;
}

/** @param {any} job */
const quiet = (job) => ['done', 'cancelled'].includes(job?.state) || (job?.state === 'waiting' && job?.waitingOn === 'budget');

/** @param {any} job @param {any} configBudget */
export function budgetChip(job, configBudget) {
  if (quiet(job)) return '';
  const w = budgetWorst(budgetRows(job, configBudget));
  if (!w || (w.tone !== 'warn' && w.tone !== 'bad')) return '';
  const text = w.tone === 'bad' ? 'over budget' : `budget ${Math.round(/** @type {number} */ (w.fraction) * 100)}%`;
  return `<span title="${esc(`${w.label} ${fmt(w.key, w.counted)}/${fmt(w.key, w.limit)}`)}">${toneChip(w.tone, text)}</span>`;
}

/** @param {any} job @param {any} configBudget */
export function budgetCell(job, configBudget) {
  const chip = budgetChip(job, configBudget);
  if (chip) return chip;
  const w = budgetWorst(budgetRows(job, configBudget));
  if (!w) return '—';
  const f = /** @type {number} */ (w.fraction);
  return `<span class="text-muted tabular-nums">${esc(Number.isFinite(f) ? `${Math.round(f * 100)}%` : 'over')}</span>`;
}

/** @param {BudgetRow} r */
function rowHtml(r) {
  const muted = (t) => ` <span class="text-muted">${esc(t)}</span>`;
  let value;
  if (r.limit === null) value = `${esc(fmt(r.key, r.used))}${muted('· unlimited')}`;
  else if (r.counted === null) value = `— / ${esc(fmt(r.key, r.limit))}${muted('not measured yet')}`;
  else value = `${esc(fmt(r.key, r.counted))} / ${esc(fmt(r.key, r.limit))}${r.ackBase > 0 ? muted(`· ${fmt(r.key, r.ackBase)} acknowledged`) : ''}`;
  const width = r.tone && r.fraction !== null ? Math.round(Math.min(Math.max(r.fraction, 0), 1) * 100) : null;
  const bar = r.tone && width !== null
    ? `<div class="col-span-2 md:col-span-1 h-1.5 rounded-full bg-raised overflow-hidden"><div class="h-full ${BAR[r.tone]}" style="width:${width}%"></div></div>`
    : '<div class="hidden md:block"></div>';
  return `<div class="grid grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 gap-y-1 py-1"><div class="text-xs text-muted">${esc(r.label)}</div><div class="text-sm tabular-nums text-right md:text-left break-words ${r.tone === 'bad' ? 'text-bad' : ''}">${value}</div>${bar}</div>`;
}

/** @param {any} job @param {any} configBudget @param {{compact?: boolean}} [opts] */
export function budgetPanel(job, configBudget, { compact = false } = {}) {
  const rows = `<div class="flex flex-col">${budgetRows(job, configBudget).map(rowHtml).join('')}</div>`;
  if (compact) return rows;
  const lc = obj(obj(obj(job).budget).lastCheck);
  const checked = Object.keys(lc).length
    ? `checked ${Number.isFinite(Date.parse(lc.at)) ? ago(lc.at) : '—'} · ${lc.checkpoint ?? '—'}`
    : 'not checked yet';
  return `<div class="card p-4 flex flex-col gap-2"><div class="flex flex-wrap items-center justify-between gap-2"><h3 class="text-sm font-semibold">Budget</h3><span class="text-[11px] text-muted">${esc(checked)}</span></div>${rows}</div>`;
}
