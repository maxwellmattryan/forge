// @ts-check
// Dependency links between jobs (`dependsOn`), derived from /api/state jobs. Done is green,
// missing or cancelled red, anything else amber, matching lib/deps.mjs where only `done` counts.
// No DOM access, so node:test can import it.
import { esc, toneChip, TONE_CLASS } from './util.js';

/** @param {any} job @returns {string[]} */
const ids = (job) => (Array.isArray(job?.dependsOn) ? job.dependsOn.filter((/** @type {unknown} */ d) => typeof d === 'string' && d) : []);

/** @param {string} state */
const toneOf = (state) => (state === 'done' ? 'ok' : state === 'missing' || state === 'cancelled' ? 'bad' : 'warn');

/** @param {any} job @param {any[]} jobs */
export function depLinks(job, jobs) {
  return ids(job).map((id) => {
    const dep = (jobs ?? []).find((j) => j?.id === id);
    const state = dep ? String(dep.state) : 'missing';
    return { id, title: dep?.title ?? null, stage: dep?.stage ?? null, state, tone: toneOf(state) };
  });
}

/** Jobs that list this one in their dependsOn. @param {any} job @param {any[]} jobs */
export function dependents(job, jobs) {
  return (jobs ?? []).filter((j) => j && ids(j).includes(job?.id));
}

/** @param {{title:string|null, stage:string|null, state:string}} l */
const hint = (l) => (l.state === 'missing' ? 'missing' : `${l.title ?? ''} · ${l.stage}/${l.state}`);

/** One `after <id>` chip per dependency for a board card, or '' without dependencies. @param {any} job @param {any[]} jobs */
export function depChips(job, jobs) {
  const links = depLinks(job, jobs);
  if (!links.length) return '';
  // A span, not a button: cards are buttons already. The board's click handler opens the closest [data-action].
  const chip = (/** @type {ReturnType<typeof depLinks>[number]} */ l) =>
    `<span data-action="open" data-id="${esc(l.id)}" title="${esc(hint(l))}" class="chip ${TONE_CLASS[l.tone]} cursor-pointer hover:underline">after ${esc(l.id)}</span>`;
  return `<div class="flex flex-wrap gap-1">${links.map(chip).join('')}</div>`;
}

/** Drawer section with "Depends on" and "Blocks" rows, or '' when the job has neither. @param {any} job @param {any[]} jobs */
export function depSection(job, jobs) {
  const deps = depLinks(job, jobs);
  const blocks = dependents(job, jobs).map((j) => ({ id: String(j.id), title: j.title ?? null, stage: j.stage ?? null, state: String(j.state), tone: toneOf(String(j.state)) }));
  if (!deps.length && !blocks.length) return '';
  const link = (/** @type {ReturnType<typeof depLinks>[number]} */ l) =>
    `<button data-action="open" data-id="${esc(l.id)}" title="${esc(hint(l))}" class="btn font-mono text-xs">${esc(l.id)} ${toneChip(l.tone, l.state)}</button>`;
  const row = (/** @type {string} */ label, /** @type {ReturnType<typeof depLinks>} */ links) =>
    links.length ? `<div class="flex flex-wrap items-center gap-2"><div class="text-[11px] text-muted w-20 shrink-0">${label}</div>${links.map(link).join('')}</div>` : '';
  return `<div class="card p-4 flex flex-col gap-2"><h3 class="text-sm font-semibold">Dependencies</h3>${row('Depends on', deps)}${row('Blocks', blocks)}</div>`;
}
