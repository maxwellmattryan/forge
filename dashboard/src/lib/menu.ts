// Where a small menu popover (components/MenuButton.svelte) opens, and where focus waits while a choice in it saves, as
// plain functions node:test can pin.

export interface MenuPlaceInput {
  /** The trigger's rect edges, in viewport px. */
  top: number;
  bottom: number;
  right: number;
  /** The viewport's size. */
  vw: number;
  vh: number;
  /** The panel's measured size. */
  width: number;
  height: number;
  /** The space between the trigger and the panel. */
  gap?: number;
  /** The least space between the panel and each viewport edge. */
  gutter?: number;
}

/**
 * A choice in a menu panel disables its own radios while it saves, and a focused control that becomes disabled drops focus
 * to <body>. There arrow keys do nothing and Escape reaches App's window handler (closing the drawer or a status bar
 * popover) instead of the panel's. So park focus on the panel (tabindex="-1") meanwhile, and call the returned function
 * once the radios are enabled again: it puts focus back on the checked radio, unless focus moved on in between.
 */
export function parkFocus(control: Element | null, doc: { readonly activeElement: Element | null } = document): () => void {
  const panel = control?.closest<HTMLElement>('[role="dialog"]') ?? null;
  if (!panel) return () => {};
  panel.focus();
  return () => {
    if (doc.activeElement !== panel) return;
    panel.querySelector<HTMLElement>('input[type="radio"]:checked:not(:disabled)')?.focus();
  };
}

/**
 * The same for a button that disables itself while its action runs (the session log's Start/Stop): the returned function
 * refocuses it if it had focus and nothing else took focus meanwhile.
 */
export function keepFocus(el: HTMLElement | null, doc: { readonly activeElement: Element | null; readonly body: Element | null } = document): () => void {
  const had = el !== null && doc.activeElement === el;
  return () => {
    if (had && (doc.activeElement === null || doc.activeElement === doc.body)) el?.focus();
  };
}

const clamp =(v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/**
 * The panel's fixed position: right edges aligned, `gap` below the trigger, or above it when the panel doesn't fit below
 * and above has more room, kept `gutter` inside the viewport on both axes. A panel taller than the viewport sits at the
 * top gutter (its own max-height makes it scroll).
 */
export function placeMenu({ top, bottom, right, vw, vh, width, height, gap = 4, gutter = 8 }: MenuPlaceInput): { left: number; top: number } {
  const w = Math.min(width, vw - 2 * gutter);
  const left = clamp(right - w, gutter, vw - gutter - w);
  const below = vh - bottom - gap - gutter;
  const above = top - gap - gutter;
  const y = height > below && above > below ? top - gap - height : bottom + gap;
  const y2 = height > vh - 2 * gutter ? gutter : clamp(y, gutter, vh - gutter - height);
  return { left, top: y2 };
}
