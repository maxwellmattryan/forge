// One tracker item's display detail for the dashboard's issue panel: the one caller of an adapter's view,
// whose reply it normalises so a custom adapter's junk can't reach the page. The text stays unfenced and goes
// only to GET /api/backlog/item, never to an agent.
import { oneLineTitle } from '#core/text.ts';
import type { BacklogItemResponse, Tracker, TrackerComment, TrackerCtx, TrackerItemView } from '#core/types.ts';

const text = (v: unknown): string => String(v ?? '');
const nullable = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const date = (v: unknown): string | null => (typeof v === 'string' ? v.slice(0, 40) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const httpUrl = (v: unknown): string | null => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : null);

function comments(v: unknown): TrackerComment[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object' && typeof (c as { body?: unknown }).body === 'string')
    .map((c) => ({ author: nullable(c.author), at: date(c.at), body: c.body as string }));
}

/** The adapter's view of `ref`, normalised; `view: null` with no error when the tracker has no view(). */
export function itemView(tracker: Tracker, ctx: TrackerCtx, ref: string): BacklogItemResponse {
  if (typeof tracker.view !== 'function') return { tracker: tracker.name, view: null };
  let raw: unknown;
  try {
    raw = tracker.view.call(tracker, ctx, ref);
  } catch (e) {
    return { tracker: tracker.name, view: null, error: (e as Error)?.message ?? String(e) };
  }
  if (raw === null || typeof raw !== 'object') return { tracker: tracker.name, view: null, error: 'no such item in the tracker' };
  const v = raw as Record<string, unknown>;
  const hidden = v.hiddenComments;
  const view: TrackerItemView = {
    ref: typeof v.ref === 'string' && v.ref ? v.ref : ref,
    title: oneLineTitle(text(v.title)),
    url: httpUrl(v.url),
    state: nullable(v.state),
    body: text(v.body),
    comments: comments(v.comments),
    hiddenComments: typeof hidden === 'number' && Number.isSafeInteger(hidden) && hidden > 0 ? hidden : 0,
    labels: strings(v.labels),
    assignees: strings(v.assignees),
    milestone: nullable(v.milestone),
    author: nullable(v.author),
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt),
  };
  return { tracker: tracker.name, view };
}
