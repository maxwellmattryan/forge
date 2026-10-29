// The Project view's graph logic (issue #175): a deterministic layered layout of GET /api/project, the
// highlight of a job's components and their downstream consumers, and the job selector's options with
// where each job's list came from (the diff or the spec) and why an unmatched one is empty.
// Plain functions and constants, no DOM access, so node:test can pin them.
import type { ProjectResponse, StateJob } from '../core/types.ts';

export const NODE_W = 168;
export const NODE_H = 44;
export const COL_GAP = 72;
export const ROW_GAP = 16;
export const BAND_PAD = 16;
export const BAND_HEAD = 28;
export const BAND_GAP = 24;
export const GRID_COLS = 4;
export const LABEL_MAX = 22;

/** The backing band's key: a NUL can never be a repo string from YAML config. */
export const BACKING_KEY = '\0backing';

type Kind = ProjectResponse['components'][number]['kind'];
type DepType = ProjectResponse['edges'][number]['type'];

export interface GraphBand {
  key: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GraphNode {
  id: string;
  kind: 'component' | 'backing';
  componentKind: Kind | null;
  label: string;
  full: string;
  band: string;
  col: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface GraphEdge {
  from: string;
  to: string;
  type: DepType;
  target: 'component' | 'backing';
  d: string;
}
export interface GraphLayout {
  width: number;
  height: number;
  bands: GraphBand[];
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `s` cut to `max` characters, the last one an ellipsis. */
export function fitLabel(s: string, max = LABEL_MAX): string {
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

/** Each component's column: 0 with no component dependency, else 1 + its deepest one's; an edge back onto the walk is ignored. */
function columns(g: ProjectResponse): Map<string, number> {
  const deps = new Map<string, string[]>(g.components.map((c) => [c.name, []]));
  for (const e of g.edges) if (e.target === 'component' && deps.has(e.from) && deps.has(e.to)) deps.get(e.from)!.push(e.to);
  const col = new Map<string, number>();
  const open = new Set<string>();
  const visit = (n: string): number => {
    const known = col.get(n);
    if (known !== undefined) return known;
    open.add(n);
    let c = 0;
    for (const m of [...deps.get(n)!].sort(cmp)) if (!open.has(m)) c = Math.max(c, visit(m) + 1);
    open.delete(n);
    col.set(n, c);
    return c;
  };
  for (const n of [...deps.keys()].sort(cmp)) visit(n);
  return col;
}

/** The graph laid out in bands (this repo, the other repos A-Z, backing services) and columns by dependency depth. */
export function layoutProject(g: ProjectResponse, rootLabel: string, backingLabel: string): GraphLayout {
  const components = [...g.components].sort((a, b) => cmp(a.name, b.name));
  const backing = [...new Set(g.backing)].sort(cmp);
  const grid = g.edges.length === 0;
  const depth = columns(g);
  const offset = backing.length ? 1 : 0;

  const others = [...new Set(components.flatMap((c) => (c.repo === null ? [] : [c.repo])))].sort(cmp);
  const keys = [...(components.some((c) => c.repo === null) ? [''] : []), ...others, ...(backing.length ? [BACKING_KEY] : [])];
  const members = new Map<string, { id: string; kind: 'component' | 'backing'; componentKind: Kind | null; full: string; col: number; row: number }[]>(keys.map((k) => [k, []]));
  for (const c of components) members.get(c.repo ?? '')!.push({ id: `c:${c.name}`, kind: 'component', componentKind: c.kind, full: c.name, col: depth.get(c.name)! + offset, row: 0 });
  for (const b of backing) members.get(BACKING_KEY)!.push({ id: `b:${b}`, kind: 'backing', componentKind: null, full: b, col: 0, row: 0 });
  // Rows run in name order within each (band, column); with no edges at all, each band is a grid instead.
  for (const list of members.values()) {
    if (grid) {
      const cols = Math.min(GRID_COLS, list.length);
      list.forEach((m, i) => {
        m.col = i % cols;
        m.row = Math.floor(i / cols);
      });
    } else {
      const used = new Map<number, number>();
      for (const m of list) {
        m.row = used.get(m.col) ?? 0;
        used.set(m.col, m.row + 1);
      }
    }
  }

  const maxCol = Math.max(0, ...[...members.values()].flat().map((m) => m.col));
  // Room on the right for an edge that bulges past the last column.
  const width = BAND_PAD + (maxCol + 1) * (NODE_W + COL_GAP) - COL_GAP + Math.max(BAND_PAD, COL_GAP / 2);
  const bands: GraphBand[] = [];
  const nodes: GraphNode[] = [];
  let y = 0;
  for (const key of keys) {
    const list = members.get(key)!;
    const rows = Math.max(1, ...list.map((m) => m.row + 1));
    const h = BAND_HEAD + rows * (NODE_H + ROW_GAP) - ROW_GAP + BAND_PAD;
    bands.push({ key, label: key === '' ? rootLabel : key === BACKING_KEY ? backingLabel : key, x: 0, y, w: width, h });
    for (const m of list)
      nodes.push({ id: m.id, kind: m.kind, componentKind: m.componentKind, label: fitLabel(m.full), full: m.full, band: key, col: m.col, x: BAND_PAD + m.col * (NODE_W + COL_GAP), y: y + BAND_HEAD + m.row * (NODE_H + ROW_GAP), w: NODE_W, h: NODE_H });
    y += h + BAND_GAP;
  }
  const height = bands.length ? y - BAND_GAP : 0;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const half = COL_GAP / 2;
  const edges: GraphEdge[] = [];
  for (const e of g.edges) {
    const s = byId.get(`c:${e.from}`);
    const t = byId.get(`${e.target === 'component' ? 'c' : 'b'}:${e.to}`);
    if (!s || !t) continue;
    const sy = s.y + s.h / 2;
    const ty = t.y + t.h / 2;
    const tx = t.x + t.w;
    const d = t.col < s.col ? `M${s.x} ${sy} C${s.x - half} ${sy} ${tx + half} ${ty} ${tx} ${ty}` : `M${s.x + s.w} ${sy} C${s.x + s.w + half} ${sy} ${tx + half} ${ty} ${tx} ${ty}`;
    edges.push({ from: e.from, to: e.to, type: e.type, target: e.target, d });
  }
  return { width: bands.length ? width : 0, height, bands, nodes, edges };
}

export interface Highlight {
  /** Whether the job names any component in the graph. */
  matched: boolean;
  /** Configured component names among the job's `components`. */
  touched: Set<string>;
  /** Component names that depend on a touched one, directly or transitively; never touched ones. */
  consumers: Set<string>;
  /** `from|to|type` keys of the component edges along the way. */
  edges: Set<string>;
}

export const edgeKey = (e: { from: string; to: string; type: string }): string => `${e.from}|${e.to}|${e.type}`;

/** What a job with `components` touches in `g`, and what consumes it downstream over build and runtime edges. */
export function highlight(g: ProjectResponse, components: readonly string[]): Highlight {
  const names = new Set(g.components.map((c) => c.name));
  const touched = new Set(components.filter((s) => names.has(s)));
  const dependents = new Map<string, string[]>();
  for (const e of g.edges) if (e.target === 'component') dependents.set(e.to, [...(dependents.get(e.to) ?? []), e.from]);
  const consumers = new Set<string>();
  const queue = [...touched];
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of dependents.get(n) ?? []) {
      if (touched.has(m) || consumers.has(m)) continue;
      consumers.add(m);
      queue.push(m);
    }
  }
  const edges = new Set<string>();
  for (const e of g.edges) if (e.target === 'component' && consumers.has(e.from) && (touched.has(e.to) || consumers.has(e.to))) edges.add(edgeKey(e));
  return { matched: touched.size > 0, touched, consumers, edges };
}

const FINISHED = new Set(['done', 'cancelled', 'failed']);
/** Stages before the build: a job there with no declared list has no spec yet. */
const PRE_BUILD = new Set(['backlog', 'plan', 'spec', 'design']);

export interface ComponentsView {
  /** The components the page highlights: the job's `components`. */
  components: string[];
  /** Where that list came from: forge verify's recompute from the diff, or the spec's estimate. */
  source: 'diff' | 'declared';
  /** Why a list that matches no configured component is empty: the reason line shown instead of a highlight. */
  reason: 'no-match' | 'no-spec' | 'spec-none';
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

/** The list a job's highlight uses, where it came from, and the reason to show when it matches no component. */
export function componentsView(job: Pick<StateJob, 'stage' | 'components' | 'componentsDeclared' | 'componentsFromDiff'>): ComponentsView {
  const source = Array.isArray(job.componentsFromDiff) ? 'diff' : 'declared';
  const reason = source === 'diff' ? 'no-match' : job.componentsDeclared == null && PRE_BUILD.has(job.stage) ? 'no-spec' : 'spec-none';
  return { components: list(job.components), source, reason };
}

/** The job selector's choices: unfinished jobs by id, each with the components it names and where they came from. */
export function jobOptions(
  jobs: readonly Pick<StateJob, 'id' | 'title' | 'state' | 'stage' | 'components' | 'componentsDeclared' | 'componentsFromDiff'>[],
): ({ id: string; label: string } & ComponentsView)[] {
  return jobs
    .filter((j) => !FINISHED.has(j.state))
    .map((j) => ({ id: j.id, label: `${j.id} · ${j.title}`, ...componentsView(j) }))
    .sort((a, b) => cmp(a.id, b.id));
}
