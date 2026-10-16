// Where the toast sits, as a plain function node:test can pin: never over the board's primary controls, the job pane's
// action dock or the status bar.
import type { PaneMode } from './drawer.ts';

export interface ToastPlaceInput {
  /** Below md. */
  narrow: boolean;
  paneMode: PaneMode;
  paneOpen: boolean;
  /** The open pane's width, px. */
  paneWidth: number;
}

/** bottom-right: over the board's bottom right, `right` px from the viewport's right edge (the pane's width); top: top-centre. */
export type ToastPlacement = { edge: 'bottom-right'; right: number } | { edge: 'top' };

/** At md and up, at the board's bottom right, left of a split pane; below md, or over a full pane, top-centre. */
export function toastPlacement({ narrow, paneMode, paneOpen, paneWidth }: ToastPlaceInput): ToastPlacement {
  if (narrow || (paneOpen && paneMode === 'full')) return { edge: 'top' };
  return { edge: 'bottom-right', right: paneOpen ? Math.max(0, paneWidth) : 0 };
}
