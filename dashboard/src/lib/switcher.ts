// The machine's registered projects as the project switcher, the Overview, the Machine page and the command bar show them.
import type { ProjectsResponse } from './types.ts';
import { PROJECT_NAME_SOURCE } from './types.ts';
import type { SelectOption } from './select.ts';
import { switchHash, type Route } from './routes.ts';

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

/** The Add project entry's value: fails PROJECT_NAME, so no registered project can share it. */
export const ADD_PROJECT = '+add';

/** The switcher's Select options: the projects, then Add project ruled off below them (no rule when it stands alone). */
export function switcherOptions(entries: SwitcherEntry[], labels: { add: string; hint: (e: SwitcherEntry) => string | undefined }): SelectOption[] {
  const projects: SelectOption[] = entries.map((e) => ({ value: e.name, label: e.name, disabled: !e.openable, hint: labels.hint(e) }));
  return [...projects, { value: ADD_PROJECT, label: labels.add, icon: 'command', action: true, separator: projects.length > 0 }];
}

/** The hash choosing `value` leads to, or null to stay: Add project opens the Machine page, a project its view (switchHash). */
export function switcherChoice(value: string, current: string | null, route: Route): string | null {
  if (value === ADD_PROJECT) return route.scope === 'global' && route.view === 'machine' ? null : '#/machine';
  if (value === current) return null;
  return switchHash(value, route);
}

/** Whether `name` can stay selected: it is registered and its pages can be opened. */
export const selectionOpenable = (entries: SwitcherEntry[], name: string): boolean => entries.some((e) => e.name === name && e.openable);
