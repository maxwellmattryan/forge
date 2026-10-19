// The job drawer's tabs and their keyboard rules, as plain functions node:test can pin.

/** The drawer's tabs, in strip order. */
export const DRAWER_TABS = ['thread', 'log', 'agents', 'files', 'timeline', 'details'] as const;

export type DrawerTab = (typeof DRAWER_TABS)[number];

/** Opening a job lands on its conversation. */
export const DEFAULT_DRAWER_TAB: DrawerTab = 'thread';

/** The tab Left/Right (wrapping), Home or End moves to from `current`, or null for other keys. The strip is horizontal, so Up/Down do nothing. */
export function moveDrawerTab(current: DrawerTab, key: string): DrawerTab | null {
  const n = DRAWER_TABS.length;
  const i = Math.max(0, DRAWER_TABS.indexOf(current));
  if (key === 'ArrowLeft') return DRAWER_TABS[(i - 1 + n) % n];
  if (key === 'ArrowRight') return DRAWER_TABS[(i + 1) % n];
  if (key === 'Home') return DRAWER_TABS[0];
  if (key === 'End') return DRAWER_TABS[n - 1];
  return null;
}

// ---------- the job drawer over the view ----------

/** The narrowest the job drawer gets, px. */
export const PANE_MIN = 360;
/** The drawer's width until the viewer drags it. */
export const PANE_DEFAULT = 640;
/** The sidebar's width, px: it mirrors `--size-sidebar` in style.css, so the drawer never covers the sidebar column. */
export const PANE_GUTTER = 236;

/** The widest the drawer gets in a window `viewport` px wide (innerWidth): it stops at the sidebar's edge. */
export const paneMax = (viewport: number): number => Math.max(PANE_MIN, Math.floor(viewport - PANE_GUTTER));

/** `w` within [PANE_MIN, paneMax(viewport)], whole px; a stored value that is not a number takes the default. */
export function clampPaneWidth(w: number, viewport: number): number {
  const width = Number.isFinite(w) ? w : PANE_DEFAULT;
  return Math.round(Math.min(paneMax(viewport), Math.max(PANE_MIN, width)));
}

/**
 * The drawer width after a key on the separator, or null for other keys. The separator is the drawer's left edge, so
 * Left widens it and Right narrows it: 16px a press, 64px with Shift. Home is the minimum, End the maximum.
 */
export function paneKey(w: number, key: string, shift: boolean, viewport: number): number | null {
  const step = shift ? 64 : 16;
  if (key === 'ArrowLeft') return clampPaneWidth(w + step, viewport);
  if (key === 'ArrowRight') return clampPaneWidth(w - step, viewport);
  if (key === 'Home') return clampPaneWidth(PANE_MIN, viewport);
  if (key === 'End') return paneMax(viewport);
  return null;
}
