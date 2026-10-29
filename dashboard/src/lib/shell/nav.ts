// The sidebar's pages (the machine's global pages and each project's views), their order and the nav's badge counts. No DOM access.
import { isOpen, needsHuman } from '../jobs/state.ts';
import type { JobLike } from '../jobs/state.ts';

// Labels come from messages/en/app.json (nav.<id>), through Nav.svelte.
/** The machine's own pages, which keep the selected project: `#/overview` and `#/machine`. */
export const GLOBAL_VIEWS = [
  { id: 'overview', icon: 'dashboard' },
  { id: 'machine', icon: 'gauge' },
] as const;
export type GlobalViewId = (typeof GLOBAL_VIEWS)[number]['id'];

/** One project's pages, at `#/p/<project>/<view>`, in sidebar order: the Office and the Foreman first (GENERAL_NAV). */
export const VIEWS = [
  { id: 'office', icon: 'office' },
  { id: 'foreman', icon: 'foreman' },
  { id: 'project', icon: 'graph' },
  { id: 'pipeline', icon: 'pipeline' },
  { id: 'issues', icon: 'issues' },
  { id: 'agents', icon: 'agents' },
  { id: 'analytics', icon: 'analytics' },
  { id: 'evals', icon: 'evals' },
] as const;
export type ViewId = (typeof VIEWS)[number]['id'];

/**
 * The General section, in order: the Overview, the selected project's Office and Foreman (project pages, listed here so
 * they sit beside the machine's own), then the Machine page.
 */
export const GENERAL_NAV = [
  { scope: 'global', id: 'overview', icon: 'dashboard' },
  { scope: 'project', id: 'office', icon: 'office' },
  { scope: 'project', id: 'foreman', icon: 'foreman' },
  { scope: 'global', id: 'machine', icon: 'gauge' },
] as const satisfies readonly ({ scope: 'global'; id: GlobalViewId; icon: string } | { scope: 'project'; id: ViewId; icon: string })[];

/** The project views listed under the project switcher: every view GENERAL_NAV does not hold. */
export const PROJECT_NAV = VIEWS.filter((v) => !GENERAL_NAV.some((g) => g.scope === 'project' && g.id === v.id));

/** The view's 1-based position in the sidebar, for the status bar's SHEET fact; unknown ids read as the first view. */
export const viewIndex = (view: string): number => Math.max(0, VIEWS.findIndex((v) => v.id === view)) + 1;

export function navCounts(jobs: JobLike[]): { active: number; needs: number } {
  return { active: jobs.filter(isOpen).length, needs: jobs.filter((j) => needsHuman(j) || j.state === 'failed').length };
}
