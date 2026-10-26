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
  // Forge itself: an anvil, its horn to the left.
  anvil: [{ el: 'path', d: 'M3 7h17.5v3.5H16v3h2.5V17h-12v-3.5H9v-3H8C5.5 10.5 3.8 9.2 3 7z' }],
  issues: [{ el: 'path', d: 'M6 6h14M6 12h14M6 18h9M3 6h.01M3 12h.01M3 18h.01' }],
  bell: [{ el: 'path', d: 'M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z' }, { el: 'path', d: 'M10 20.5a2 2 0 0 0 4 0M12 3v2' }],
  board: [{ el: 'rect', x: '3', y: '4', width: '7', height: '16', rx: '1' }, { el: 'rect', x: '14', y: '4', width: '7', height: '10', rx: '1' }],
  branch: [{ el: 'circle', cx: '6', cy: '5', r: '2' }, { el: 'circle', cx: '6', cy: '19', r: '2' }, { el: 'circle', cx: '18', cy: '7', r: '2' }, { el: 'path', d: 'M6 7v10M18 9a5 5 0 0 1-5 5H9a3 3 0 0 0-3 3' }],
  // A tick: the chosen option in a Select's list.
  check: [{ el: 'path', d: 'M5 12.5l4.5 4.5L19 7' }],
  // A caret: a Select's trigger opens a list.
  'chevron-down': [{ el: 'path', d: 'M6 9l6 6 6-6' }],
  close: [{ el: 'path', d: 'M6 6l12 12M18 6 6 18' }],
  command: [{ el: 'path', d: 'M12 5v14M5 12h14' }],
  copy: [{ el: 'rect', x: '9', y: '9', width: '11', height: '11', rx: '1' }, { el: 'path', d: 'M5 15V4h11' }],
  daemon: [{ el: 'rect', x: '7', y: '7', width: '10', height: '10', rx: '1' }, { el: 'path', d: 'M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3' }],
  dashboard: [{ el: 'rect', x: '3', y: '3', width: '8', height: '8', rx: '1' }, { el: 'rect', x: '13', y: '3', width: '8', height: '5', rx: '1' }, { el: 'rect', x: '13', y: '11', width: '8', height: '10', rx: '1' }, { el: 'rect', x: '3', y: '14', width: '8', height: '7', rx: '1' }],
  diagnostics: [{ el: 'path', d: 'M2 12h4l2.5-7 4 14 2.5-7h7' }],
  evals: [{ el: 'path', d: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3' }, { el: 'path', d: 'M7.5 15h9' }],
  // A funnel: what the log keeps.
  filter: [{ el: 'path', d: 'M3 5h18l-7 8v6l-4 2v-8z' }],
  // Three nodes and two links: a dependency graph.
  graph: [{ el: 'circle', cx: '6', cy: '6', r: '2.5' }, { el: 'circle', cx: '18', cy: '12', r: '2.5' }, { el: 'circle', cx: '6', cy: '18', r: '2.5' }, { el: 'path', d: 'M8.3 7.1l7.4 3.8M8.3 16.9l7.4-3.8' }],
  github: [{ el: 'path', d: 'M10 20v-2.5c-3.5 0-5.5-2-5.5-5.5 0-1.3.4-2.4 1.1-3.3-.2-1-.1-2.2.4-3.2 1.2 0 2.4.6 3.3 1.4a10 10 0 0 1 5.4 0c.9-.8 2.1-1.4 3.3-1.4.5 1 .6 2.2.4 3.2.7.9 1.1 2 1.1 3.3 0 3.5-2 5.5-5.5 5.5V20M10 18.5c-2.5.5-3.5-.5-4.5-2' }],
  // A rank insignia: two chevrons, the supervisor above the pool.
  foreman: [{ el: 'path', d: 'M5 11l7-5 7 5' }, { el: 'path', d: 'M5 17l7-5 7 5' }],
  // A dial's arc and its needle: how hard a session thinks.
  gauge: [{ el: 'path', d: 'M4.5 17a8.5 8.5 0 1 1 15 0' }, { el: 'path', d: 'M12 13.5l4-4.5' }, { el: 'circle', cx: '12', cy: '14', r: '1.2' }],
  general: [{ el: 'path', d: 'M4 7h16M4 12h16M4 17h16' }, { el: 'circle', cx: '15', cy: '7', r: '2', fill: 'ground' }, { el: 'circle', cx: '9', cy: '12', r: '2', fill: 'ground' }, { el: 'circle', cx: '13', cy: '17', r: '2', fill: 'ground' }],
  inbox: [{ el: 'path', d: 'M4 13l2-7h12l2 7v7H4z' }, { el: 'path', d: 'M4 13h5l1.5 3h3L15 13h5' }],
  // The markdown mark: a frame, an M and a down arrow.
  markdown: [{ el: 'rect', x: '2.5', y: '5.5', width: '19', height: '13', rx: '1' }, { el: 'path', d: 'M6 15V9l2.5 3L11 9v6M16.5 9v6M14 12.5l2.5 2.5 2.5-2.5' }],
  // Three stages on one line: work flowing through. Not bars, which Analytics already draws.
  pipeline: [{ el: 'circle', cx: '5', cy: '12', r: '2' }, { el: 'circle', cx: '12', cy: '12', r: '2' }, { el: 'circle', cx: '19', cy: '12', r: '2' }, { el: 'path', d: 'M7 12h3M14 12h3' }],
  play: [{ el: 'path', d: 'M7 4l13 8-13 8z' }],
  'pull-request': [{ el: 'circle', cx: '6', cy: '5', r: '2' }, { el: 'circle', cx: '6', cy: '19', r: '2' }, { el: 'circle', cx: '18', cy: '19', r: '2' }, { el: 'path', d: 'M6 7v10M18 17V9a3 3 0 0 0-3-3h-4M13 3.5 10.5 6 13 8.5' }],
  refresh: [{ el: 'path', d: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' }],
  review: [{ el: 'path', d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z' }, { el: 'circle', cx: '12', cy: '12', r: '3' }],
  search: [{ el: 'circle', cx: '10.5', cy: '10.5', r: '6.5' }, { el: 'path', d: 'M15.5 15.5 21 21' }],
  // A gear: the eight-toothed wheel around a hub.
  settings: [{ el: 'circle', cx: '12', cy: '12', r: '3' }, { el: 'path', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }],
  // A shield: what a session may do without asking.
  shield: [{ el: 'path', d: 'M12 3l7.5 3v5.5c0 4.5-3.2 8-7.5 9.5-4.3-1.5-7.5-5-7.5-9.5V6z' }],
  stop: [{ el: 'rect', x: '6', y: '6', width: '12', height: '12', rx: '1' }],
  table: [{ el: 'rect', x: '3', y: '5', width: '18', height: '14', rx: '1' }, { el: 'path', d: 'M3 10h18M3 15h18M9 5v14' }],
  // A console and its prompt: a process's or container's log.
  terminal: [{ el: 'rect', x: '3', y: '4', width: '18', height: '16', rx: '1' }, { el: 'path', d: 'M7 9l3 3-3 3M12.5 15H17' }],
  tracker: [{ el: 'path', d: 'M3 4h10l8 8-8 8H3z' }, { el: 'circle', cx: '7', cy: '12', r: '1.5' }],
  // A triangle with a stem and a dot: a reach you chose that is wider than usual (a session in Auto).
  warning: [{ el: 'path', d: 'M12 3.5 21.5 20h-19z' }, { el: 'path', d: 'M12 10v4.5' }, { el: 'circle', cx: '12', cy: '17.3', r: '.7', fill: 'current' }],
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;
