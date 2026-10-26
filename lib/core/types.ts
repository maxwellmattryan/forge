// The transitional type-only barrel: the /api/* and SSE shapes (lib/api/types.ts), the job shapes
// (lib/core/job/types.ts) and the config shapes (lib/core/config/types.ts), re-exported so older
// `#core/types.ts` imports keep compiling, plus the tracker contract. Shapes a higher layer owns live
// in that module's own types.ts.
import type { Config } from './config/types.ts';
import type { Job, TrackerItem } from '#api/types.ts';

export type * from '#api/types.ts';
export type * from './job/types.ts';
export type * from './config/types.ts';

// ---------- tracker contract ----------

/** What every tracker method receives: loadTracker's callers (lib/engine/trackers/load.ts). */
export interface TrackerCtx {
  root: string;
  config: Config;
}

/**
 * The tracker contract. Every adapter (built-in or a repo's own `.forge/trackers/<name>.mjs` or `.ts`)
 * default-exports an object with these synchronous methods. docs/TRACKERS.md has the details.
 */
export interface Tracker {
  name: string;
  list: (ctx: TrackerCtx, opts: { ready?: boolean; limit?: number }) => TrackerItem[];
  get: (ctx: TrackerCtx, ref: string) => TrackerItem | null;
  claim: (ctx: TrackerCtx, ref: string, job: Job) => { ok: boolean; reason?: string };
  update: (ctx: TrackerCtx, ref: string, job: Job) => void;
  comment: (ctx: TrackerCtx, ref: string, body: string) => void;
  /** `milestone` is a milestone title the item is filed under (createMilestone made it first). */
  create: (ctx: TrackerCtx, item: { title: string; body?: string; labels?: string[]; parentRef?: string | null; milestone?: string | null }) => { ref: string; url?: string | null };
  close: (ctx: TrackerCtx, ref: string, opts?: { reason?: 'completed' | 'not-planned' }) => void;
  /**
   * Optional: open items matching a free-text query, best first, at most `opts.limit` of them
   * (bodies included, for local re-ranking). Without it, searchTracker in lib/engine/trackers/link.ts scores
   * a capped list() instead.
   */
  search?: (ctx: TrackerCtx, query: string, opts: { limit: number }) => TrackerItem[];
  /**
   * Optional: readiness triage's mark (lib/engine/trackers/triage.ts). A note (one line Forge renders from fixed
   * text) marks the item needs-info, so list({ready: true}) leaves it out; null clears the mark.
   */
  setNeedsInfo?: (ctx: TrackerCtx, ref: string, note: string | null) => void;
  /**
   * Optional: the open milestones, for a goal mandate's drafting survey (lib/office/mandates/intake.ts).
   * Titles are one line; `openIssues` and `dueOn` are null when the tracker doesn't say. Throws when it
   * can't list them.
   */
  milestones?: (ctx: TrackerCtx) => { title: string; openIssues: number | null; dueOn: string | null }[];
  /**
   * Optional: creates an open milestone, or returns the open one with exactly that title, for filing an
   * approved milestone draft (lib/office/mandates/filing.ts). Without it, a draft can't be filed there.
   */
  createMilestone?: (ctx: TrackerCtx, milestone: { title: string; description: string }) => { ref: string; url?: string | null };
  /** Optional: puts an existing item in a milestone, with the labels where the tracker supports them (a draft's `existing` issues). */
  milestoneAdd?: (ctx: TrackerCtx, ref: string, opts: { milestone: string; labels: string[] }) => void;
}
