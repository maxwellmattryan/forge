// Where a small menu popover (components/ui/overlay/MenuButton.svelte, components/ui/Select.svelte) opens, and where focus waits while
// a button's action runs, as plain functions node:test can pin.

export interface MenuPlaceInput {
  /** The trigger's rect edges, in viewport px. */
  top: number;
  bottom: number;
  right: number;
  /** The trigger's left edge, used when `align` is 'start'. */
  left?: number;
  /** end (the default): right edges meet, as MenuButton's panels; start: left edges meet, as a Select's list. */
  align?: 'start' | 'end';
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
 * A focused button that disables itself while its action runs (the session log's Start/Stop) drops focus to <body>: the
 * returned function refocuses it if it had focus and nothing else took focus meanwhile.
 */
export function keepFocus(el: HTMLElement | null, doc: { readonly activeElement: Element | null; readonly body: Element | null } = document): () => void {
  const had = el !== null && doc.activeElement === el;
  return () => {
    if (had && (doc.activeElement === null || doc.activeElement === doc.body)) el?.focus();
  };
}

const clamp =(v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/**
 * The panel's fixed position: right edges aligned (left edges with `align: 'start'`), `gap` below the trigger, or above it when the panel doesn't fit below
 * and above has more room, kept `gutter` inside the viewport on both axes. A panel taller than the viewport sits at the
 * top gutter (its own max-height makes it scroll).
 */
export function placeMenu({ top, bottom, right, left: edge, align = 'end', vw, vh, width, height, gap = 4, gutter = 8 }: MenuPlaceInput): { left: number; top: number } {
  const w = Math.min(width, vw - 2 * gutter);
  const left = clamp(align === 'start' ? (edge ?? right - w) : right - w, gutter, vw - gutter - w);
  const below = vh - bottom - gap - gutter;
  const above = top - gap - gutter;
  const y = height > below && above > below ? top - gap - height : bottom + gap;
  const y2 = height > vh - 2 * gutter ? gutter : clamp(y, gutter, vh - gutter - height);
  return { left, top: y2 };
}
