// The settings modal's keyboard and focus rules, as plain functions node:test can pin.
import type { ConfigSection } from './types.ts';
import type { IconName } from './icons.ts';

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

/** What a keydown on the window should do with the modal. */
export interface SettingsKeyInput {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** The focused element's tag name. */
  targetTag: string;
  /** The focused element is contenteditable. */
  editable: boolean;
  open: boolean;
  /** The `,` shortcut is on (pref `settingsShortcut`); a character-key shortcut must be possible to turn off. */
  shortcut?: boolean;
  /** A held key's auto-repeat. */
  repeat?: boolean;
  /** Part of an IME composition. */
  composing?: boolean;
}

const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** `open` for a bare `,` outside form fields while closed, `close` for Escape while open, else null. */
export function settingsKey(e: SettingsKeyInput): 'open' | 'close' | null {
  if (e.open) return e.key === 'Escape' ? 'close' : null;
  if (e.key !== ',' || e.ctrlKey || e.metaKey || e.altKey || e.shortcut === false || e.repeat || e.composing) return null;
  if (FIELD_TAGS.has(e.targetTag.toUpperCase()) || e.editable) return null;
  return 'open';
}

/** The tab an arrow, Home or End key moves to from `current` (wrapping), or null for other keys. */
export function moveTab(current: SettingsTabId, key: string): SettingsTabId | null {
  const ids = SETTINGS_TABS.map((t) => t.id);
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
