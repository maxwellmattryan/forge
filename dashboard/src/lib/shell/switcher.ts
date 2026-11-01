// The machine's registered projects as the project switcher, the Overview, the Machine page, the command bar and the
// Add project dialog show them, and the Cmd/Ctrl+O shortcut that opens the switcher.
import type { MachineProjectSummary, ProjectsResponse } from '../core/types.ts';
import { PROJECT_NAME_SOURCE } from '../core/types.ts';
import type { SelectOption } from '../ui/select.ts';
import { isMac } from './command.ts';
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

/** One registered project's entry. */
export function entryOf(p: MachineProjectSummary): SwitcherEntry {
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
}

/** One entry per registered project, sorted by name; [] before the list loads. */
export function switcherEntries(r: ProjectsResponse | null): SwitcherEntry[] {
  if (!r) return [];
  return [...r.projects].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map(entryOf);
}

/** The Add project entry's value: fails PROJECT_NAME, so no registered project can share it. */
export const ADD_PROJECT = '+add';

/** Jobs waiting on you in the openable projects other than `current` (every openable project when nothing is selected). */
export function othersWaiting(entries: SwitcherEntry[], current: string | null): number {
  return entries.filter((e) => e.openable && e.name !== current).reduce((n, e) => n + e.waiting, 0);
}

/**
 * The switcher's Select options: the projects, then Add project ruled off below them (no rule when it stands alone). An
 * openable project other than `current` with jobs waiting on you gets the option badge.
 */
export function switcherOptions(entries: SwitcherEntry[], labels: { add: string; hint: (e: SwitcherEntry) => string | undefined }, current: string | null): SelectOption[] {
  const projects: SelectOption[] = entries.map((e) => ({
    value: e.name,
    label: e.name,
    disabled: !e.openable,
    hint: labels.hint(e),
    badge: e.openable && e.waiting > 0 && e.name !== current,
  }));
  return [...projects, { value: ADD_PROJECT, label: labels.add, icon: 'command', action: true, separator: projects.length > 0 }];
}

/**
 * What choosing `value` does: Add project opens the Add project dialog wherever it is chosen (`add`), a project opens its
 * view (`hash`, switchHash), and the current project stays (null).
 */
export function switcherChoice(value: string, current: string | null, route: Route): { add: true } | { hash: string } | null {
  if (value === ADD_PROJECT) return { add: true };
  if (value === current) return null;
  return { hash: switchHash(value, route) };
}

/** Whether `name` can stay selected: it is registered and its pages can be opened. */
export const selectionOpenable = (entries: SwitcherEntry[], name: string): boolean => entries.some((e) => e.name === name && e.openable);

export interface SwitcherKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** Apple platforms take Cmd+O, the rest Ctrl+O. */
  mac: boolean;
  /** The palette is open: it owns the keyboard. */
  palette?: boolean;
  /** Settings is open. */
  settings?: boolean;
  /** The Add project dialog is open. */
  addProject?: boolean;
  /** A job or issue drawer is open: the sidebar and the phone strip are inert under it. */
  drawer?: boolean;
  /** A held key's auto-repeat. */
  repeat?: boolean;
  /** Part of an IME composition. */
  composing?: boolean;
}

/**
 * `toggle` for Cmd+O (mac) or Ctrl+O (elsewhere): it opens or closes the visible switcher. `block` is the chord in a state
 * where it does nothing but must still preventDefault (the browser's Open file): the palette, Settings, the Add project
 * dialog or a drawer is open, or the key repeats. null is not the chord, and a composing key never is. A modified key types
 * nothing, so it works from inside a form field too.
 */
export function switcherKey(e: SwitcherKeyInput): 'toggle' | 'block' | null {
  if (e.composing) return null;
  if (e.key.toLowerCase() !== 'o' || e.altKey || e.shiftKey) return null;
  const chord = e.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!chord) return null;
  if (e.palette || e.settings || e.addProject || e.drawer || e.repeat) return 'block';
  return 'toggle';
}

/** The switcher shortcut as its title and the rail tooltip show it. */
export const switcherShortcutLabel = (platform: string): string => (isMac(platform) ? '⌘O' : 'Ctrl O');

/** The switcher shortcut for `aria-keyshortcuts`. */
export const switcherKeyShortcuts = (platform: string): string => (isMac(platform) ? 'Meta+O' : 'Control+O');
