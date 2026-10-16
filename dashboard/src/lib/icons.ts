// The Smithy icon set (24x24 viewBox, machined: 1.5px strokes, round caps and joins), rendered by components/Icon.svelte.
// This file is the source of the set. Geometry is kept as SVG attribute strings.
export type IconShape =
  | { readonly el: 'path'; readonly d: string }
  | { readonly el: 'circle'; readonly cx: string; readonly cy: string; readonly r: string; readonly fill?: 'current' | 'ground' }
  | { readonly el: 'rect'; readonly x: string; readonly y: string; readonly width: string; readonly height: string; readonly rx?: string };

/** One icon: its shapes, every one drawn in the same line. */
export type IconDef = readonly IconShape[];

export const ICONS = {
  about: [{ el: 'circle', cx: '12', cy: '12', r: '9' }, { el: 'path', d: 'M12 11v6' }, { el: 'circle', cx: '12', cy: '7.5', r: '.7', fill: 'current' }],
  agents: [{ el: 'circle', cx: '12', cy: '7.5', r: '3.5' }, { el: 'path', d: 'M4 21a8 8 0 0 1 16 0' }],
  analytics: [{ el: 'path', d: 'M4 20V10M10 20V4M16 20v-7M3 20h18' }],
  backlog: [{ el: 'path', d: 'M6 6h14M6 12h14M6 18h9M3 6h.01M3 12h.01M3 18h.01' }],
  board: [{ el: 'rect', x: '3', y: '4', width: '7', height: '16', rx: '1' }, { el: 'rect', x: '14', y: '4', width: '7', height: '10', rx: '1' }],
  close: [{ el: 'path', d: 'M6 6l12 12M18 6 6 18' }],
  command: [{ el: 'path', d: 'M12 5v14M5 12h14' }],
  copy: [{ el: 'rect', x: '9', y: '9', width: '11', height: '11', rx: '1' }, { el: 'path', d: 'M5 15V4h11' }],
  daemon: [{ el: 'rect', x: '7', y: '7', width: '10', height: '10', rx: '1' }, { el: 'path', d: 'M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3' }],
  dashboard: [{ el: 'rect', x: '3', y: '3', width: '8', height: '8', rx: '1' }, { el: 'rect', x: '13', y: '3', width: '8', height: '5', rx: '1' }, { el: 'rect', x: '13', y: '11', width: '8', height: '10', rx: '1' }, { el: 'rect', x: '3', y: '14', width: '8', height: '7', rx: '1' }],
  diagnostics: [{ el: 'path', d: 'M2 12h4l2.5-7 4 14 2.5-7h7' }],
  evals: [{ el: 'path', d: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3' }, { el: 'path', d: 'M7.5 15h9' }],
  general: [{ el: 'path', d: 'M4 7h16M4 12h16M4 17h16' }, { el: 'circle', cx: '15', cy: '7', r: '2', fill: 'ground' }, { el: 'circle', cx: '9', cy: '12', r: '2', fill: 'ground' }, { el: 'circle', cx: '13', cy: '17', r: '2', fill: 'ground' }],
  inbox: [{ el: 'path', d: 'M4 13l2-7h12l2 7v7H4z' }, { el: 'path', d: 'M4 13h5l1.5 3h3L15 13h5' }],
  pipeline: [{ el: 'path', d: 'M4 20v-9M10 20V4M16 20v-6M3 20h18' }],
  play: [{ el: 'path', d: 'M7 4l13 8-13 8z' }],
  refresh: [{ el: 'path', d: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' }],
  review: [{ el: 'path', d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z' }, { el: 'circle', cx: '12', cy: '12', r: '3' }],
  search: [{ el: 'circle', cx: '10.5', cy: '10.5', r: '6.5' }, { el: 'path', d: 'M15.5 15.5 21 21' }],
  settings: [{ el: 'circle', cx: '12', cy: '12', r: '3.5' }, { el: 'path', d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' }],
  stop: [{ el: 'rect', x: '6', y: '6', width: '12', height: '12', rx: '1' }],
  table: [{ el: 'rect', x: '3', y: '5', width: '18', height: '14', rx: '1' }, { el: 'path', d: 'M3 10h18M3 15h18M9 5v14' }],
  tracker: [{ el: 'path', d: 'M3 4h10l8 8-8 8H3z' }, { el: 'circle', cx: '7', cy: '12', r: '1.5' }],
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;
