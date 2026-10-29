// The status bar's one open popover and its focus return, like palette.svelte.ts for the palette: StatusBar's indicators
// open it, Popover.svelte and App.svelte close it, and popover.ts decides when it closes and where focus goes.
import { tick } from 'svelte';
import { dismissal, togglePopover, type DismissCtx, type DismissReason, type PopoverId } from './popover.ts';

class PopoverState {
  open = $state<PopoverId | null>(null);
  /** The indicator that opened it: the popover anchors to it, and focus goes back to it. */
  anchor = $state.raw<HTMLElement | null>(null);
}

export const popover = new PopoverState();

const shown = (el: HTMLElement | null): el is HTMLElement => el !== null && el !== document.body && el.isConnected && el.getClientRects().length > 0;
const heading = (): HTMLElement | null => document.querySelector<HTMLElement>('#view h1');

/** A click on an indicator: opens its popover, switches from another one, or closes its own (`toggle`). */
export function openPopover(id: PopoverId, trigger: HTMLElement): void {
  if (togglePopover(popover.open, id) === null) return closePopover('toggle');
  popover.anchor = trigger;
  popover.open = id;
}

/**
 * Closes the open popover when `dismissal` says so. Focus goes back to its indicator (or the view's heading when that
 * is gone or hidden) when `refocus` is set; for `gone`, to the heading only when focus was inside the popover.
 */
export function closePopover(reason: DismissReason, ctx: DismissCtx = {}): void {
  if (popover.open === null) return;
  const d = dismissal(reason, ctx);
  if (!d.close) return;
  const inside = document.getElementById(`popover-${popover.open}`)?.contains(document.activeElement) ?? false;
  const back = popover.anchor;
  popover.open = null;
  popover.anchor = null;
  if (reason === 'gone') {
    if (inside) tick().then(() => heading()?.focus());
    return;
  }
  if (!d.refocus) return;
  // After the press that closed it: a mousedown on plain text would otherwise blur the indicator again.
  tick().then(() => setTimeout(() => (shown(back) ? back : heading())?.focus()));
}

/** Hands the open popover to another indicator of the same id (the Workers button, when the held one it opened from goes). */
export function reanchor(trigger: HTMLElement): void {
  if (popover.open !== null) popover.anchor = trigger;
}

/**
 * A control inside the open popover that disables itself (Start, Stop) or goes away (an answered prompt) drops focus to
 * the body while the dialog stays open: put it back on the dialog, so the keyboard keeps its place.
 */
export function keepFocus(): void {
  tick().then(() => {
    if (popover.open !== null && (document.activeElement === null || document.activeElement === document.body)) document.getElementById(`popover-${popover.open}`)?.focus();
  });
}

/** Whether focus sits inside the open popover: a drawer opened from in there sends focus back to its indicator. */
export function focusInPopover(): boolean {
  return popover.open !== null && (document.getElementById(`popover-${popover.open}`)?.contains(document.activeElement) ?? false);
}
