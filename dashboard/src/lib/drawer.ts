// The job drawer's tabs and their keyboard and scroll rules, as plain functions node:test can pin.

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

/**
 * The body's scrollTop after switching tabs. Past the header, the strip is stuck, so the new tab starts right under
 * it (at the header's height); above that point the position stays.
 */
export const tabScrollTop = (scrollTop: number, headHeight: number): number => Math.max(0, Math.min(scrollTop, headHeight));

// ---------- the job pane beside the view ----------

/** The narrowest the job pane gets in split mode, px. */
export const PANE_MIN = 360;
/** The narrowest the view beside it gets, px: one board column and its padding. */
export const BOARD_MIN = 320;
/** The pane's width until the viewer drags it. */
export const PANE_DEFAULT = 640;

/** split: the view and the pane side by side, with a separator; full: the pane fills the main column. */
export type PaneMode = 'split' | 'full';

/** Split at md and up when the main column (`available`, px) holds the pane's and the view's minimums; else full. */
export const paneMode = (available: number, md: boolean): PaneMode => (md && available >= PANE_MIN + BOARD_MIN ? 'split' : 'full');

/** The widest the pane gets in a main column `available` px wide: the view keeps BOARD_MIN. */
export const paneMax = (available: number): number => Math.max(PANE_MIN, Math.floor(available - BOARD_MIN));

/** `w` within [PANE_MIN, paneMax(available)], whole px; a stored value that is not a number takes the default. */
export function clampPaneWidth(w: number, available: number): number {
  const width = Number.isFinite(w) ? w : PANE_DEFAULT;
  return Math.round(Math.min(paneMax(available), Math.max(PANE_MIN, width)));
}

/**
 * The pane width after a key on the separator, or null for other keys. The separator is the pane's left edge, so Left
 * widens the pane and Right narrows it: 16px a press, 64px with Shift. Home is the minimum, End the maximum.
 */
export function paneKey(w: number, key: string, shift: boolean, available: number): number | null {
  const step = shift ? 64 : 16;
  if (key === 'ArrowLeft') return clampPaneWidth(w + step, available);
  if (key === 'ArrowRight') return clampPaneWidth(w - step, available);
  if (key === 'Home') return clampPaneWidth(PANE_MIN, available);
  if (key === 'End') return paneMax(available);
  return null;
}
