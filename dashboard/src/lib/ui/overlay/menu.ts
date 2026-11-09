// Where a small menu popover (components/ui/overlay/MenuButton.svelte, components/ui/Select.svelte) opens, which item an
// arrow key moves a role="menu" panel's focus to (MenuButton's menu mode: a mandate plate's ⋯), and where focus waits
// while a button's action runs, as plain functions node:test can pin.

/** One item of MenuButton's menu mode: `hint` explains a disabled item, `separator` draws a rule above it. */
export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  separator?: boolean;
}

/**
 * The item index `key` moves focus to from `from` in a menu of `count` items: ArrowDown and ArrowUp wrap at the ends,
 * Home and End jump to them; any other key, or an empty menu, is -1 (not handled). Disabled items stay reachable, so
 * their hint is announced.
 */
export function menuMove(count: number, from: number, key: string): number {
  if (count <= 0) return -1;
  if (key === 'ArrowDown') return (from + 1) % count;
  if (key === 'ArrowUp') return (from - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return -1;
}

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
