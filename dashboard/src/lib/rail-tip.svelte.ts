// The compact rail's one tooltip: a rail control shows its name on hover or focus, and RailTip.svelte draws it.
import type { Attachment } from 'svelte/attachments';
import { railTipPlace } from './sidebar.ts';

export type RailTipShown = { text: string; top: number; left: number };

export const railTip = $state<{ shown: RailTipShown | null }>({ shown: null });

export function showTip(el: Element, text: string): void {
  railTip.shown = { text, ...railTipPlace(el.getBoundingClientRect()) };
}

export function hideTip(): void {
  railTip.shown = null;
}

/**
 * A rail control's tooltip (`{@attach railTipOn(name)}`): pointer hover and keyboard focus show `text`; leave, blur and
 * Escape hide it. An attachment rather than spread handlers, so the markup guards still see every attribute.
 */
export function railTipOn(text: string): Attachment<HTMLElement> {
  return (el) => {
    const show = (): void => showTip(el, text);
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hideTip();
    };
    el.addEventListener('pointerenter', show);
    el.addEventListener('pointerleave', hideTip);
    el.addEventListener('focus', show);
    el.addEventListener('blur', hideTip);
    el.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('pointerenter', show);
      el.removeEventListener('pointerleave', hideTip);
      el.removeEventListener('focus', show);
      el.removeEventListener('blur', hideTip);
      el.removeEventListener('keydown', key);
    };
  };
}
