// The Needs-you popover's Shelved list: its rows, the batch body each action POSTs, and the toast that
// reports what happened to each job. No DOM access; ShelfSection.svelte renders it.
import { post } from './focus.ts';
import { WAIT_LABEL } from './labels.ts';
import { isShelved } from './job-state.ts';
import type { JobLike } from './job-state.ts';
import type { JobPr, PostShelfBody, PostShelfResponse, ShelfAction, ShelfResult, WaitingOn } from './types.ts';

/** One shelved job as its row shows it. Every string is the job's own and renders as text. */
export interface ShelfRow {
  id: string;
  title: string;
  reason: string;
  /** The gate it was shelved from (its WAIT_LABEL), or the state for a job that wasn't waiting. */
  from: string;
  /** `shelved.at`, which the batch body pins each entry to. */
  at: string;
  /** Who shelved it: a login, or null when none resolved. */
  by: string | null;
  pr: JobPr | null;
}

/**
 * The rows of the shelved jobs that carry a shelf record, in the order given. A hand-edited job with no
 * record has nothing to pin a batch entry to, so it is left to `forge job unshelve` in a terminal.
 */
export function shelfRows(jobs: JobLike[]): ShelfRow[] {
  return jobs.flatMap((j) => {
    const s = j.shelved;
    if (!isShelved(j) || !s || typeof s.at !== 'string') return [];
    const from = s.from?.waitingOn ? (WAIT_LABEL[s.from.waitingOn as WaitingOn] ?? s.from.waitingOn) : String(s.from?.state ?? '');
    return [{ id: String(j.id), title: String(j.title ?? j.id), reason: String(s.reason ?? ''), from, at: s.at, by: s.actor?.login ?? null, pr: j.pr ?? null }];
  });
}

/** The one body an action sends for the selected rows, each pinned to the time the list showed it shelved. */
export function shelfBody(action: ShelfAction, rows: Pick<ShelfRow, 'id' | 'at'>[], note: string): PostShelfBody {
  return { action, jobs: rows.map((r) => ({ id: r.id, shelvedAt: r.at })), note: note.trim() ? note : null };
}

/** Approve and Close ask for a second click that names the count; Rework needs its note; nothing goes with no rows. */
export const shelfNeedsConfirm = (action: ShelfAction): boolean => action === 'approve' || action === 'close';
export const shelfActionReady = (action: ShelfAction, selected: number, note: string): boolean => selected > 0 && (action !== 'rework' || note.trim() !== '');

/** POST /api/shelf. Throws with the server's `error` field, else its text, else the status text. */
export const postShelf = (body: PostShelfBody, token: string, fetchImpl: typeof fetch = fetch): Promise<PostShelfResponse> => post<PostShelfResponse>('/api/shelf', body, token, fetchImpl);

/** The toast's words, which the component translates. */
export interface ShelfSummaryMessages {
  outcome: (outcome: Exclude<ShelfResult['outcome'], 'skipped'>, count: number) => string;
  skipped: (id: string, reason: string) => string;
}

const OUTCOMES = ['approved', 'reworked', 'unshelved', 'closed'] as const;

/** The toast for a reply: the count per outcome, then each skipped job with its reason; bad when anything was skipped. */
export function shelfSummary(results: readonly ShelfResult[], msg: ShelfSummaryMessages): { text: string; bad: boolean } {
  const parts = OUTCOMES.flatMap((o) => {
    const n = results.filter((r) => r.outcome === o).length;
    return n ? [msg.outcome(o, n)] : [];
  });
  const skipped = results.filter((r) => r.outcome === 'skipped').map((r) => msg.skipped(r.id, r.reason ?? ''));
  return { text: [...parts, ...skipped].join(' · '), bad: skipped.length > 0 };
}
