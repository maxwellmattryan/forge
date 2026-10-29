// Dependency links between jobs (`dependsOn`), derived from /api/state jobs. Done is green,
// missing or cancelled red, anything else amber, matching lib/engine/pipeline/deps.ts where only `done` counts.
// No DOM access, so node:test can import it; DepChips.svelte and DepSection.svelte render the links.
// depLabel and depChipTitle shape the board card's chips; depHint stays as the drawer's title text.
import type { Job } from '../core/types.ts';
import { cardRef } from './board.ts';

/** job.json can be hand-edited, so fields are checked before use despite the type. */
type JobLike = Partial<Job> | null | undefined;

export interface DepLink {
  id: string;
  title: string | null;
  /** The dependency's tracker ref as the card shows it (`#66`), or null for a missing or untracked job. */
  ref: string | null;
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
    return { id, title: dep?.title ?? null, ref: dep ? cardRef(dep) : null, stage: dep?.stage ?? null, state, tone: toneOf(state) };
  });
}

/** Jobs that list this one in their dependsOn. */
export function dependents(job: JobLike, jobs: JobLike[] | null | undefined): Partial<Job>[] {
  return (jobs ?? []).filter((j) => j && ids(j).includes(job?.id as string)) as Partial<Job>[];
}

/** Jobs this one blocks, as links for the drawer's "Blocks" row. */
export function blockLinks(job: JobLike, jobs: JobLike[] | null | undefined): DepLink[] {
  return dependents(job, jobs).map((j) => ({ id: String(j.id), title: j.title ?? null, ref: cardRef(j), stage: j.stage ?? null, state: String(j.state), tone: toneOf(String(j.state)) }));
}

/** The link's title: `missing`, or `<title> · <stage>/<state>`. */
export const depHint = (l: Pick<DepLink, 'title' | 'stage' | 'state'>): string => (l.state === 'missing' ? 'missing' : `${l.title ?? ''} · ${l.stage}/${l.state}`);

/** The board chip's label: `<ref> <title>` for an issue-linked job with a title, else the id. CSS truncates it, so nothing is cut here. */
export const depLabel = (l: Pick<DepLink, 'id' | 'ref' | 'title'>): string => {
  const title = l.title?.trim();
  return l.ref && title ? `${l.ref} ${title}` : l.id;
};

/** The board chip's tooltip: the full id the label may hide, then the drawer's hint. */
export const depChipTitle = (l: Pick<DepLink, 'id' | 'title' | 'stage' | 'state'>): string => `${l.id} · ${depHint(l)}`;
