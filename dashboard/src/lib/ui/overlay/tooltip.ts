// Where an icon button's tooltip (components/ui/overlay/Tooltip.svelte) opens, as a plain function node:test can pin. Modelled on
// placeMenu in menu.ts.

/** Hover waits this long before the tip shows; keyboard focus shows it at once. */
export const TIP_DELAY_MS = 400;
/** The space between the button and the tip. */
const GAP = 6;
/** The least space between the tip and each viewport edge. */
const MARGIN = 8;

export interface TipPlaceInput {
  /** The anchor's rect edges, in viewport px. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** The viewport's size. */
  vw: number;
  vh: number;
  /** The tip's measured size. */
  width: number;
  height: number;
}

// Math.max last, so a tip larger than the viewport sits at the margin rather than off the top or left edge.
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(v, hi));

/**
 * The tip's fixed position: centred under the anchor, GAP below it, or above it when below would end within MARGIN of
 * the viewport's bottom, then kept MARGIN inside the viewport on both axes.
 */
export function placeTip({ top, bottom, left, right, vw, vh, width, height }: TipPlaceInput): { left: number; top: number } {
  const x = (left + right) / 2 - width / 2;
  const below = bottom + GAP;
  const y = below + height > vh - MARGIN ? top - GAP - height : below;
  return { left: clamp(x, MARGIN, vw - width - MARGIN), top: clamp(y, MARGIN, vh - height - MARGIN) };
}
