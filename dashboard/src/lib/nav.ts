// The sidebar's pages (the machine's global pages and each project's views), their order and the nav's badge counts. No DOM access.
import { isOpen, needsHuman } from './job-state.ts';
import type { JobLike } from './job-state.ts';

// Labels come from messages/en/app.json (nav.<id>), through Nav.svelte.
/** The machine's own pages, which keep the selected project: `#/overview` and `#/machine`. */
export const GLOBAL_VIEWS = [
  { id: 'overview', icon: 'dashboard' },
  { id: 'machine', icon: 'gauge' },
] as const;
export type GlobalViewId = (typeof GLOBAL_VIEWS)[number]['id'];

/** One project's pages, at `#/p/<project>/<view>`. */
export const VIEWS = [
  { id: 'pipeline', icon: 'pipeline' },
  { id: 'project', icon: 'graph' },
  { id: 'issues', icon: 'issues' },
  { id: 'agents', icon: 'agents' },
  { id: 'analytics', icon: 'analytics' },
  { id: 'evals', icon: 'evals' },
] as const;
export type ViewId = (typeof VIEWS)[number]['id'];

/** The view's 1-based position in the sidebar, for the status bar's SHEET fact; unknown ids read as the first view. */
export const viewIndex = (view: string): number => Math.max(0, VIEWS.findIndex((v) => v.id === view)) + 1;

export function navCounts(jobs: JobLike[]): { active: number; needs: number } {
  return { active: jobs.filter(isOpen).length, needs: jobs.filter((j) => needsHuman(j) || j.state === 'failed').length };
}
