// The Drafting icon set (24x24 viewBox), rendered by components/Icon.svelte.
// design/icons/*.svg is the source: each entry mirrors its file element for element, with the dashed
// construction elements (stroke-dasharray 2 2, opacity .6) kept apart in `cx` so the renderer can group them.
// Geometry stays as the files' attribute strings so test/dashboard-icons.test.ts can compare them exactly.
export type IconShape =
  | { readonly el: 'path'; readonly d: string }
  | { readonly el: 'circle'; readonly cx: string; readonly cy: string; readonly r: string; readonly fill?: 'current' | 'ground' }
  | { readonly el: 'rect'; readonly x: string; readonly y: string; readonly width: string; readonly height: string };

/** `main` draws in the full line; `cx` is construction geometry, drawn dashed at 60%. */
export interface IconDef {
  readonly main: readonly IconShape[];
  readonly cx: readonly IconShape[];
}

export const ICONS = {
  about: {
    main: [{ el: 'circle', cx: '12', cy: '12', r: '9' }, { el: 'path', d: 'M12 11v6' }, { el: 'circle', cx: '12', cy: '7.5', r: '.7', fill: 'current' }],
    cx: [{ el: 'circle', cx: '12', cy: '12', r: '10.5' }],
  },
  agents: {
    main: [{ el: 'circle', cx: '12', cy: '7.5', r: '3.5' }, { el: 'path', d: 'M4 21a8 8 0 0 1 16 0' }],
    cx: [{ el: 'circle', cx: '12', cy: '7.5', r: '6' }],
  },
  analytics: {
    main: [{ el: 'path', d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }],
    cx: [{ el: 'path', d: 'M2 4h20M2 12h20' }],
  },
  backlog: {
    main: [{ el: 'path', d: 'M6 6h14M6 12h14M6 18h9' }],
    cx: [{ el: 'path', d: 'M3 3v18' }],
  },
  board: {
    main: [{ el: 'path', d: 'M3 4h7v16H3zM14 4h7v10h-7z' }],
    cx: [],
  },
  close: {
    main: [{ el: 'path', d: 'M6 6l12 12M18 6 6 18' }],
    cx: [{ el: 'circle', cx: '12', cy: '12', r: '9' }],
  },
  command: {
    main: [{ el: 'path', d: 'M12 5v14M5 12h14' }],
    cx: [{ el: 'circle', cx: '12', cy: '12', r: '8' }],
  },
  copy: {
    main: [{ el: 'rect', x: '9', y: '9', width: '11', height: '11' }, { el: 'path', d: 'M5 15V4h11' }],
    cx: [],
  },
  daemon: {
    main: [{ el: 'rect', x: '7', y: '7', width: '10', height: '10' }, { el: 'path', d: 'M4 10h3M4 14h3M17 10h3M17 14h3M10 4v3M14 4v3M10 17v3M14 17v3' }],
    cx: [{ el: 'circle', cx: '12', cy: '12', r: '2' }],
  },
  dashboard: {
    main: [{ el: 'path', d: 'M3 3h8v8H3zM13 3h8v5h-8zM13 11h8v10h-8zM3 14h8v7H3z' }],
    cx: [],
  },
  diagnostics: {
    main: [{ el: 'path', d: 'M2 12h4l2.5-7 4 14 2.5-7h7' }],
    cx: [{ el: 'path', d: 'M2 19h20' }],
  },
  evals: {
    main: [{ el: 'path', d: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3' }],
    cx: [{ el: 'path', d: 'M7 15h10' }],
  },
  general: {
    main: [{ el: 'path', d: 'M4 7h16M4 12h16M4 17h16' }, { el: 'circle', cx: '15', cy: '7', r: '2', fill: 'ground' }, { el: 'circle', cx: '9', cy: '12', r: '2', fill: 'ground' }, { el: 'circle', cx: '13', cy: '17', r: '2', fill: 'ground' }],
    cx: [],
  },
  inbox: {
    main: [{ el: 'path', d: 'M3 13l2.5-8h13L21 13v7H3z' }, { el: 'path', d: 'M3 13h5l2 3h4l2-3h5' }],
    cx: [{ el: 'path', d: 'M12 2v3' }],
  },
  pipeline: {
    main: [{ el: 'path', d: 'M4 20V10h4v10zM10 20V4h4v16zM16 20v-6h4v6z' }],
    cx: [{ el: 'path', d: 'M2 20h20' }],
  },
  play: {
    main: [{ el: 'path', d: 'M7 4l13 8-13 8z' }],
    cx: [{ el: 'path', d: 'M7 12h13' }],
  },
  refresh: {
    main: [{ el: 'path', d: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' }],
    cx: [{ el: 'circle', cx: '12', cy: '12', r: '1' }],
  },
  review: {
    main: [{ el: 'path', d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z' }, { el: 'circle', cx: '12', cy: '12', r: '3' }],
    cx: [{ el: 'path', d: 'M12 2v20' }],
  },
  search: {
    main: [{ el: 'circle', cx: '10.5', cy: '10.5', r: '6.5' }, { el: 'path', d: 'M15.5 15.5 21 21' }],
    cx: [{ el: 'path', d: 'M10.5 4v13M4 10.5h13' }],
  },
  settings: {
    main: [{ el: 'path', d: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z' }, { el: 'path', d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' }],
    cx: [{ el: 'circle', cx: '12', cy: '12', r: '7' }],
  },
  stop: {
    main: [{ el: 'rect', x: '6', y: '6', width: '12', height: '12' }],
    cx: [{ el: 'path', d: 'M6 6l12 12M18 6 6 18' }],
  },
  table: {
    main: [{ el: 'rect', x: '3', y: '5', width: '18', height: '14' }, { el: 'path', d: 'M3 10h18M3 15h18M9 5v14' }],
    cx: [],
  },
  tracker: {
    main: [{ el: 'path', d: 'M3 4h10l8 8-8 8H3z' }, { el: 'circle', cx: '7', cy: '12', r: '1.5' }],
    cx: [{ el: 'path', d: 'M3 12h18' }],
  },
} as const satisfies Record<string, IconDef>;

export type IconName = keyof typeof ICONS;
