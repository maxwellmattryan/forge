// The machine's registered projects as the project switcher, the Overview, the Machine page and the command bar show them.
import type { ProjectsResponse } from './types.ts';
import { PROJECT_NAME_SOURCE } from './types.ts';

const PROJECT_NAME = new RegExp(PROJECT_NAME_SOURCE);

export interface SwitcherEntry {
  name: string;
  path: string;
  /** `missing`: its directory is gone; `unavailable`: registered but not loaded (not initialised, or failed to load). */
  state: 'ok' | 'missing' | 'unavailable';
  /** Its pages can be opened: the server serves it. */
  openable: boolean;
  /** Jobs waiting on anything but `external`; 0 while not loaded. */
  waiting: number;
  active: number;
  /** The project's pool, while loaded. */
  daemon: { live: number; maxConcurrent: number } | null;
}

/** One entry per registered project, sorted by name; [] before the list loads. */
export function switcherEntries(r: ProjectsResponse | null): SwitcherEntry[] {
  if (!r) return [];
  return [...r.projects]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((p) => {
      // A name the router would refuse can't be opened, whatever the server says about it.
      const state = p.status === 'missing' ? 'missing' : p.loaded && PROJECT_NAME.test(p.name) ? 'ok' : 'unavailable';
      return {
        name: p.name,
        path: p.path,
        state,
        openable: state === 'ok',
        waiting: p.jobs?.waiting ?? 0,
        active: p.jobs?.active ?? 0,
        daemon: p.daemon ? { live: p.daemon.live, maxConcurrent: p.daemon.maxConcurrent } : null,
      };
    });
}
