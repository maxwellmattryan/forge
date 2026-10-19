// Where a small menu popover (components/MenuButton.svelte) opens, as a plain function node:test can pin.

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

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

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
