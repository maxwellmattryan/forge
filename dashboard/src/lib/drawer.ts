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
