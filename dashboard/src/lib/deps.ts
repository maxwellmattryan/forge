// Dependency links between jobs (`dependsOn`), derived from /api/state jobs. Done is green,
// missing or cancelled red, anything else amber, matching lib/deps.mjs where only `done` counts.
// No DOM access, so node:test can import it.
import { esc, toneChip, TONE_CLASS } from './util.ts';
import type { Job } from './types.ts';

/** job.json can be hand-edited, so fields are checked before use despite the type. */
type JobLike = Partial<Job> | null | undefined;

export interface DepLink {
  id: string;
  title: string | null;
  stage: string | null;
  state: string;
  tone: 'ok' | 'bad' | 'warn';
}

const ids = (job: JobLike): string[] => (Array.isArray(job?.dependsOn) ? job.dependsOn.filter((d: unknown) => typeof d === 'string' && d) : []);

const toneOf = (state: string): DepLink['tone'] => (state === 'done' ? 'ok' : state === 'missing' || state === 'cancelled' ? 'bad' : 'warn');

export function depLinks(job: JobLike, jobs: JobLike[] | null | undefined): DepLink[] {
  return ids(job).map((id) => {
    const dep = (jobs ?? []).find((j) => j?.id === id);
    const state = dep ? String(dep.state) : 'missing';
    return { id, title: dep?.title ?? null, stage: dep?.stage ?? null, state, tone: toneOf(state) };
  });
}

/** Jobs that list this one in their dependsOn. */
export function dependents(job: JobLike, jobs: JobLike[] | null | undefined): Partial<Job>[] {
  return (jobs ?? []).filter((j) => j && ids(j).includes(job?.id as string)) as Partial<Job>[];
}

const hint = (l: { title: string | null; stage: string | null; state: string }) => (l.state === 'missing' ? 'missing' : `${l.title ?? ''} · ${l.stage}/${l.state}`);

/** One `after <id>` chip per dependency for a board card, or '' without dependencies. */
export function depChips(job: JobLike, jobs: JobLike[] | null | undefined): string {
  const links = depLinks(job, jobs);
  if (!links.length) return '';
  // A span, not a button: cards are buttons already. The board's click handler opens the closest [data-action].
  const chip = (l: DepLink) =>
    `<span data-action="open" data-id="${esc(l.id)}" title="${esc(hint(l))}" class="chip ${TONE_CLASS[l.tone]} cursor-pointer hover:underline">after ${esc(l.id)}</span>`;
  return `<div class="flex flex-wrap gap-1">${links.map(chip).join('')}</div>`;
}

/** Drawer section with "Depends on" and "Blocks" rows, or '' when the job has neither. */
export function depSection(job: JobLike, jobs: JobLike[] | null | undefined): string {
  const deps = depLinks(job, jobs);
  const blocks = dependents(job, jobs).map((j) => ({ id: String(j.id), title: j.title ?? null, stage: j.stage ?? null, state: String(j.state), tone: toneOf(String(j.state)) }));
  if (!deps.length && !blocks.length) return '';
  const link = (l: DepLink) =>
    `<button data-action="open" data-id="${esc(l.id)}" title="${esc(hint(l))}" class="btn font-mono text-xs">${esc(l.id)} ${toneChip(l.tone, l.state)}</button>`;
  const row = (label: string, links: DepLink[]) =>
    links.length ? `<div class="flex items-start gap-2"><div class="text-[11px] text-muted w-20 shrink-0 pt-2">${label}</div><div class="flex flex-wrap gap-2 min-w-0">${links.map(link).join('')}</div></div>` : '';
  return `<div class="card p-4 flex flex-col gap-2"><h3 class="text-sm font-semibold">Dependencies</h3>${row('Depends on', deps)}${row('Blocks', blocks)}</div>`;
}
