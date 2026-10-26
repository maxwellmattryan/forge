// The settings modal's keyboard and focus rules, as plain functions node:test can pin.
import type { ConfigSection } from './types.ts';
import type { IconName } from './icons.ts';
import { isMac } from './command.ts';

/** The tab rail, in order; config tabs name the ConfigSection their fields come from. */
export const SETTINGS_TABS = [
  { id: 'general', icon: 'general', section: null },
  { id: 'pipeline', icon: 'pipeline', section: 'pipeline' },
  { id: 'review', icon: 'review', section: 'review' },
  { id: 'agents', icon: 'agents', section: 'agents' },
  { id: 'tracker', icon: 'tracker', section: 'tracker' },
  { id: 'dashboard', icon: 'dashboard', section: 'dashboard' },
  { id: 'daemon', icon: 'daemon', section: 'daemon' },
  { id: 'diagnostics', icon: 'diagnostics', section: null },
  { id: 'about', icon: 'about', section: null },
] as const satisfies readonly { id: string; icon: IconName; section: ConfigSection | null }[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]['id'];

export const isSettingsTab = (v: string): v is SettingsTabId => SETTINGS_TABS.some((t) => t.id === v);

export const sectionOf = (id: SettingsTabId): ConfigSection | null => SETTINGS_TABS.find((t) => t.id === id)?.section ?? null;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** The tabs Settings offers: a project's config tabs and Diagnostics need one, so with none only General and About. */
export const settingsTabsFor = (hasProject: boolean): readonly SettingsTab[] => (hasProject ? SETTINGS_TABS : SETTINGS_TABS.filter((t) => t.id === 'general' || t.id === 'about'));

/** The tab Settings opens on: `start` when offered, else the saved tab when offered, else General. */
export function openingTab(tabs: readonly SettingsTab[], start: string | undefined, saved: string): SettingsTabId {
  const offered = (id: string | undefined): id is SettingsTabId => id !== undefined && tabs.some((t) => t.id === id);
  if (offered(start)) return start;
  return offered(saved) ? saved : 'general';
}

/** What a keydown on the window should do with the modal. */
export interface SettingsKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  open: boolean;
  /** Apple platforms take Cmd+, (the system's own settings key), the rest Ctrl+,. */
  mac: boolean;
  /** The palette is open: it owns the keyboard. */
  palette?: boolean;
  /** A held key's auto-repeat. */
  repeat?: boolean;
  /** Part of an IME composition. */
  composing?: boolean;
}

/**
 * `open` for Cmd+, (mac) or Ctrl+, (elsewhere) while Settings and the palette are closed, `close` for Escape while open,
 * else null. A modified key types nothing, so it opens from inside a form field too; a bare `,` never does.
 */
export function settingsKey(e: SettingsKeyInput): 'open' | 'close' | null {
  if (e.open) return e.key === 'Escape' ? 'close' : null;
  if (e.key !== ',' || e.palette || e.altKey || e.repeat || e.composing) return null;
  const chord = e.mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return chord ? 'open' : null;
}

/** The Settings shortcut as the sidebar and Settings › General show it. */
export const settingsShortcutLabel = (platform: string): string => (isMac(platform) ? '⌘,' : 'Ctrl ,');

/** The Settings shortcut for `aria-keyshortcuts`. */
export const settingsKeyShortcuts = (platform: string): string => (isMac(platform) ? 'Meta+,' : 'Control+,');

/** The tab an arrow, Home or End key moves to from `current` among `tabs` (wrapping), or null for other keys. */
export function moveTab(current: SettingsTabId, key: string, tabs: readonly SettingsTab[] = SETTINGS_TABS): SettingsTabId | null {
  const ids = tabs.map((t) => t.id);
  const i = Math.max(0, ids.indexOf(current));
  if (key === 'ArrowUp' || key === 'ArrowLeft') return ids[(i - 1 + ids.length) % ids.length];
  if (key === 'ArrowDown' || key === 'ArrowRight') return ids[(i + 1) % ids.length];
  if (key === 'Home') return ids[0];
  if (key === 'End') return ids[ids.length - 1];
  return null;
}

/** What Tab stops on: the palette's trap and a popover's Tab handling walk these. */
export const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab (or Shift+Tab with `shift`) must send focus to stay inside the dialog: the index to
 * focus among its `count` tabbable elements, or null when the browser's own move stays inside.
 * `index` is the focused element's position, -1 when focus is outside the list.
 */
export function wrapFocus(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return null;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return null;
}
