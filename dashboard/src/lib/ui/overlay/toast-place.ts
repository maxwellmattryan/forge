// Where the toast sits, as a plain function node:test can pin: never over the board's primary controls, the job drawer's
// action dock or the status bar.

export interface ToastPlaceInput {
  /** Below md. */
  narrow: boolean;
  paneOpen: boolean;
  /** The open drawer's clamped width, px. */
  paneWidth: number;
}

/** bottom-right: `right` px from the viewport's right edge (the open drawer's width); top: top-centre. */
export type ToastPlacement = { edge: 'bottom-right'; right: number } | { edge: 'top' };

/** At md and up, at the bottom right, left of an open drawer; below md, top-centre. */
export function toastPlacement({ narrow, paneOpen, paneWidth }: ToastPlaceInput): ToastPlacement {
  if (narrow) return { edge: 'top' };
  return { edge: 'bottom-right', right: paneOpen ? Math.max(0, paneWidth) : 0 };
}
