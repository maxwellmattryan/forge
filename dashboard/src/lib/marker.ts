// The sliding selected marker (style.css `slide-marker`): where it sits for the selected item, and the attachment that
// keeps it there. DOM-free at import: the DOM is touched only inside the function slideMarker returns.

/** bar-left: the nav's 3px bar; bar-bottom: a tab strip's 2px baseline; fill: a seg's slug, the item's whole box. */
export type MarkerKind = 'bar-left' | 'bar-bottom' | 'fill';

export interface MarkerItem {
  offsetLeft: number;
  offsetTop: number;
  offsetWidth: number;
  offsetHeight: number;
}

const BAR = 3;
const BASELINE = 2;

/** The marker's box in the container, from the selected item's offset box. */
export function markerBox(kind: MarkerKind, { offsetLeft: x, offsetTop: y, offsetWidth: w, offsetHeight: h }: MarkerItem): { x: number; y: number; width: number; height: number } {
  if (kind === 'bar-left') return { x, y, width: BAR, height: h };
  if (kind === 'bar-bottom') return { x, y: y + h - BASELINE, width: w, height: BASELINE };
  return { x, y, width: w, height: h };
}

/**
 * An attachment (`{@attach slideMarker('.active', 'bar-left')}`) on a `slide-marker` container: it measures the item
 * matching `selector` into --mk-*, places it without a slide on first sight (data-marker="set", then "on" a frame later),
 * re-measures when classes or selection change or anything resizes, and drops data-marker when nothing matches.
 */
export function slideMarker(selector: string, kind: MarkerKind): (node: HTMLElement) => () => void {
  return (node) => {
    let frame = 0;
    const place = (): void => {
      const item = node.querySelector<HTMLElement>(selector);
      if (!item) {
        node.removeAttribute('data-marker');
        return;
      }
      const b = markerBox(kind, item);
      node.style.setProperty('--mk-x', `${b.x}px`);
      node.style.setProperty('--mk-y', `${b.y}px`);
      node.style.setProperty('--mk-w', `${b.width}px`);
      node.style.setProperty('--mk-h', `${b.height}px`);
      if (kind === 'fill') node.style.setProperty('--mk-r', getComputedStyle(item).borderRadius);
      if (node.dataset.marker) return;
      node.dataset.marker = 'set';
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (node.dataset.marker === 'set') node.dataset.marker = 'on';
      });
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(node, { attributes: true, attributeFilter: ['class', 'aria-selected', 'aria-pressed'], subtree: true, childList: true });
    const ro = new ResizeObserver(place);
    ro.observe(node);
    for (const child of node.children) ro.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      ro.disconnect();
    };
  };
}
