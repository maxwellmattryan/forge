// The status bar popovers' rules, pure like shellEscape: which one is open, when one closes and where focus goes, and
// where it sits. popover.svelte.ts holds the open state; Popover.svelte and StatusBar.svelte apply these.

import { TABBABLE } from './settings.ts';

export const POPOVERS = ['daemon', 'inbox', 'office', 'model', 'connection'] as const;
/**
 * What a press can focus: whether a press outside a popover landed on something that takes focus itself (a select, the
 * view's heading, a summary), so focus stays there rather than going back to the indicator. Wider than TABBABLE.
 */
export const FOCUSABLE = `${TABBABLE}, select:not([disabled]), [tabindex], [contenteditable]:not([contenteditable="false"]), summary`;
/**
 * Where Tab stops, for a popover's own Tab handling: TABBABLE plus the stops it leaves out (a select, a summary such as the
 * Inbox log's tool rows, contenteditable). Unlike FOCUSABLE it skips tabindex="-1", which Tab never reaches.
 */
export const TAB_STOPS = `${TABBABLE}, select:not([disabled]), summary, [contenteditable]:not([contenteditable="false"])`;
export type PopoverId = (typeof POPOVERS)[number];

/** A click on an indicator: its own popover closes, any other one replaces whatever is open. */
export const togglePopover = (open: PopoverId | null, id: PopoverId): PopoverId | null => (open === id ? null : id);

/**
 * Why a popover is asked to close: Escape, its close button, a click on its own indicator, a pointer press outside,
 * focus leaving it, a job opened from inside it, another dialog or drawer taking over, or its indicator disappearing.
 */
export type DismissReason = 'escape' | 'close' | 'toggle' | 'outside' | 'focusout' | 'navigate' | 'external' | 'gone';

export interface DismissCtx {
  /** outside: the press landed on something that takes focus itself. */
  targetFocusable?: boolean;
  /** focusout: focus went inside the popover or to its indicator (true), elsewhere (false), or nowhere known (null). */
  relatedInside?: boolean | null;
}

/**
 * Whether the popover closes, and whether focus goes back to its indicator. A focusout with no relatedTarget closes
 * nothing: Safari does not focus clicked buttons, so a click inside would otherwise read as leaving.
 */
export function dismissal(reason: DismissReason, ctx: DismissCtx = {}): { close: boolean; refocus: boolean } {
  switch (reason) {
    case 'escape':
    case 'close':
    case 'toggle':
    case 'navigate':
      return { close: true, refocus: true };
    case 'outside':
      return { close: true, refocus: !ctx.targetFocusable };
    case 'focusout':
      return ctx.relatedInside === false ? { close: true, refocus: false } : { close: false, refocus: false };
    case 'external':
    case 'gone':
      return { close: true, refocus: false };
  }
}

export interface PlaceInput {
  triggerLeft: number;
  triggerRight: number;
  viewport: number;
  /** The popover's preferred width. */
  width: number;
  /** start: left edges meet (the left cluster); end: right edges meet (the right cluster). */
  align: 'start' | 'end';
  /** Below md: the popover spans the viewport less the gutters. */
  narrow: boolean;
  gutter?: number;
}

/** The popover's left edge and width: anchored to its indicator at md and up, kept `gutter` px inside the viewport. */
export function placePopover({ triggerLeft, triggerRight, viewport, width, align, narrow, gutter = 16 }: PlaceInput): { left: number; width: number } {
  const room = Math.max(0, viewport - 2 * gutter);
  if (narrow) return { left: gutter, width: room };
  const w = Math.min(width, room);
  const want = align === 'start' ? triggerLeft : triggerRight - w;
  return { left: Math.min(Math.max(want, gutter), gutter + room - w), width: w };
}
