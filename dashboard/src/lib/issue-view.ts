// The issue panel's model, kept here so it is tested without the Svelte compiler: the jobs that name an Issues item,
// which of them holds it, and whether Start is offered.
import { isOpen } from './job-state.ts';
import type { BacklogItem, JobIssue, StateJob } from './types.ts';

/** A ref as the Issues page shows it: `#568` for a GitHub issue number, the ref itself otherwise. */
export const refLabel = (ref: string): string => (/^\d+$/.test(ref) ? `#${ref}` : ref);

/** `owner/repo` from a GitHub issue URL's path, or null. */
function urlRepo(url: string | null | undefined): string | null {
  if (typeof url !== 'string') return null;
  try {
    return /^\/([^/]+\/[^/]+)\/issues\/\d+\/?$/.exec(new URL(url).pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether a job's issue entry names the item: same tracker kind, then the tracker's own ref rule. */
function names(issue: JobIssue, tracker: string, item: Pick<BacklogItem, 'ref' | 'url'>): boolean {
  if (!issue || issue.tracker !== tracker) return false;
  if (tracker !== 'github') return issue.ref === item.ref;
  if (item.url && issue.url === item.url) return true;
  const ref = issue.ref;
  if (typeof ref !== 'string') return false;
  // A bare number is a legacy job's: it can only mean this repo.
  if (/^#?\d+$/.test(ref)) return ref.replace(/^#/, '') === item.ref;
  const q = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(ref);
  if (!q || q[2] !== item.ref) return false;
  const repo = urlRepo(item.url);
  return repo !== null && repo.toLowerCase() === q[1]!.toLowerCase();
}

/** The jobs whose issues name `item` in tracker `tracker` (the kind job issues record), newest first. */
export function issueJobs(jobs: readonly StateJob[], tracker: string, item: Pick<BacklogItem, 'ref' | 'url'>): StateJob[] {
  return jobs
    .filter((j) => (j.issues ?? []).some((i) => names(i, tracker, item)))
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
}

/** The panel's Forge section: the job holding the item, a claim no local job explains, and every other related job. */
export interface IssuePanel {
  held: StateJob | null;
  elsewhere: string | null;
  earlier: StateJob[];
}

/** The `claimedBy` job when it is among `related`, else the first open one; `related` comes from issueJobs. */
export function issuePanel(item: Pick<BacklogItem, 'claimedBy'>, related: StateJob[]): IssuePanel {
  const held = related.find((j) => j.id === item.claimedBy) ?? related.find((j) => isOpen(j)) ?? null;
  return { held, elsewhere: held ? null : (item.claimedBy ?? null), earlier: related.filter((j) => j !== held) };
}

/** Start is offered when nothing holds the item and it is neither done nor dropped (needs-info included: Start overrides triage). */
export const canStart = (item: Pick<BacklogItem, 'claimedBy' | 'status'>, held: unknown): boolean => !held && !item.claimedBy && !['done', 'dropped'].includes(item.status ?? '');
