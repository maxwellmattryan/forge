// The sidebar's width, its icon-only rail and the separator's keyboard rules, as plain functions node:test can pin.

/** The narrowest the expanded sidebar gets, px: a drag or key below it snaps to the rail. */
export const SIDEBAR_MIN = 184;
/** The widest the sidebar gets, px. */
export const SIDEBAR_MAX = 360;
/** The sidebar's width until the viewer resizes it: `--size-sidebar` in style.css and `PANE_GUTTER` in drawer.ts. */
export const SIDEBAR_DEFAULT = 236;
/** The icon-only rail's width, px. */
export const SIDEBAR_RAIL = 64;
/** An arrow key's step, and Shift's. */
export const SIDEBAR_STEP = 16;
export const SIDEBAR_STEP_BIG = 64;

/** `width` is the last expanded width, kept while compact so Enter can restore it. */
export type SidebarState = { width: number; compact: boolean };
export type SidebarDrag = { compact: true } | { compact: false; width: number };

/** `w` within [SIDEBAR_MIN, SIDEBAR_MAX], whole px; a value that is not a finite number takes the default. */
export function clampSidebarWidth(w: number): number {
  if (!Number.isFinite(w)) return SIDEBAR_DEFAULT;
  return Math.round(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w)));
}

/** Where a drag to `raw` px lands: below the minimum it snaps to the rail, so the width never sits between rail and minimum. */
export const sidebarDrag = (raw: number): SidebarDrag => (raw < SIDEBAR_MIN ? { compact: true } : { compact: false, width: clampSidebarWidth(raw) });

/** The width the sidebar takes on screen: the rail, or the expanded width. */
export const sidebarShown = (s: SidebarState): number => (s.compact ? SIDEBAR_RAIL : clampSidebarWidth(s.width));

/**
 * The sidebar after a key on its separator, or null for other keys. The separator is the sidebar's right edge, so Right
 * widens it and Left narrows it: 16px a press, 64px with Shift. Home is the rail, End the maximum, Enter toggles.
 */
export function sidebarKey(s: SidebarState, key: string, shift: boolean): SidebarState | null {
  const width = clampSidebarWidth(s.width);
  const step = shift ? SIDEBAR_STEP_BIG : SIDEBAR_STEP;
  if (key === 'ArrowRight') return s.compact ? { width: SIDEBAR_MIN, compact: false } : { width: clampSidebarWidth(width + step), compact: false };
  if (key === 'ArrowLeft') return s.compact || width - step < SIDEBAR_MIN ? { width, compact: true } : { width: width - step, compact: false };
  if (key === 'Home') return { width, compact: true };
  if (key === 'End') return { width: SIDEBAR_MAX, compact: false };
  if (key === 'Enter') return { width, compact: !s.compact };
  return null;
}

/**
 * The saved sidebar (prefs `sidebarWidth`, `sidebarCompact`) through `get`. Each read is guarded even though `pref.get`
 * already is: a getter that throws, or a value that is missing or garbage, gives the defaults.
 */
export function readSidebar(get: (k: string, d: string) => string): SidebarState {
  const read = (k: string, d: string): string => {
    try {
      return String(get(k, d));
    } catch {
      return d;
    }
  };
  const raw = read('sidebarWidth', String(SIDEBAR_DEFAULT)).trim();
  return { width: clampSidebarWidth(raw === '' ? NaN : Number(raw)), compact: read('sidebarCompact', '0') === '1' };
}

/** A rail tooltip's anchor: 8px right of the control, at its vertical centre (the tip translates itself up by half). */
export const railTipPlace = (r: { top: number; right: number; height: number }): { top: number; left: number } => ({ top: r.top + r.height / 2, left: r.right + 8 });
