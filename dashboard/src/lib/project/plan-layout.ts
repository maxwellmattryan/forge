// A mandate's plan laid out by dependency depth (issue #713): layers by longest path, order by barycenter
// sweeps with ties by ref, and boxes and edge paths for a given size, depending only on the plan's nodes
// and edges. Plain functions and constants, no DOM access, so node:test can pin them.
// Input may come from tracker data and job records, so every field is checked at runtime despite the types.

export interface PlanNodeIn {
  ref: string;
  wave?: number | null;
}
/** `from` is the upstream issue (it must finish first); `to` waits on it. */
export interface PlanEdgeIn {
  from: string;
  to: string;
}
export interface PlanIn {
  nodes: readonly PlanNodeIn[];
  edges: readonly PlanEdgeIn[];
}
export interface PlanSize {
  nodeW: number;
  nodeH: number;
  colGap: number;
  rowGap: number;
}

export const PLAN_SIZE: PlanSize = { nodeW: 220, nodeH: 56, colGap: 48, rowGap: 12 };
export const PLAN_SIZE_COMPACT: PlanSize = { nodeW: 160, nodeH: 48, colGap: 28, rowGap: 8 };

export type PlanItem = { kind: 'node'; ref: string } | { kind: 'waypoint'; from: string; to: string };
/** Layers and within-layer order, waypoints included: topology only, no geometry. */
export interface PlanOrder {
  /** `layers[l]` lists layer l's items top to bottom. */
  layers: PlanItem[][];
  /** The forward edges kept, in ref order of `from`, then `to`. */
  edges: { from: string; to: string }[];
}

export interface PlanNodeOut {
  ref: string;
  layer: number;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface PlanEdgeOut {
  from: string;
  to: string;
  d: string;
}
export interface PlanLayout {
  width: number;
  height: number;
  layers: number;
  nodes: PlanNodeOut[];
  edges: PlanEdgeOut[];
}

const units = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A ref ending in `#<digits>` split into its prefix and digits, or null. Same as `/^(.*)#(\d+)$/`, in linear time. */
function issueRef(ref: string): { prefix: string; digits: string } | null {
  const at = ref.lastIndexOf('#');
  if (at < 0 || at === ref.length - 1) return null;
  for (let i = at + 1; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 48 || c > 57) return null;
  }
  return { prefix: ref.slice(0, at), digits: ref.slice(at + 1) };
}

/** Two digit strings compared as numbers, exactly, at any length. */
function numeric(a: string, b: string): number {
  const x = a.replace(/^0+/, '');
  const y = b.replace(/^0+/, '');
  return x.length !== y.length ? (x.length < y.length ? -1 : 1) : units(x, y);
}

/** A total order on refs: `prefix#N` refs first (by prefix, then N as a number, then the whole string), then the rest by code units. */
export function refOrder(a: string, b: string): number {
  const ia = issueRef(a);
  const ib = issueRef(b);
  if (ia && ib) return units(ia.prefix, ib.prefix) || numeric(ia.digits, ib.digits) || units(a, b);
  if (ia) return -1;
  if (ib) return 1;
  return units(a, b);
}

const validWave = (w: unknown): w is number => typeof w === 'number' && Number.isInteger(w) && w >= 0;
const validRef = (r: unknown): r is string => typeof r === 'string' && r !== '';

interface Normal {
  refs: string[];
  wave: Map<string, number | null>;
  edges: { from: string; to: string }[];
  ups: Map<string, string[]>;
  linked: Set<string>;
}

/** Collapse, validate and sort the plan, so nothing after this depends on the input's order. */
function normalise(plan: PlanIn): Normal {
  const wave = new Map<string, number | null>();
  const nodes: unknown = plan && typeof plan === 'object' ? plan.nodes : null;
  for (const n of Array.isArray(nodes) ? (nodes as unknown[]) : []) {
    if (!n || typeof n !== 'object') continue;
    const { ref, wave: w } = n as { ref?: unknown; wave?: unknown };
    if (!validRef(ref)) continue;
    const prev = wave.get(ref) ?? null;
    const next = validWave(w) ? w : null;
    wave.set(ref, prev === null ? next : next === null ? prev : Math.min(prev, next));
  }
  const refs = [...wave.keys()].sort(refOrder);

  const seen = new Set<string>();
  const edges: { from: string; to: string }[] = [];
  const rawEdges: unknown = plan && typeof plan === 'object' ? plan.edges : null;
  for (const e of Array.isArray(rawEdges) ? (rawEdges as unknown[]) : []) {
    if (!e || typeof e !== 'object') continue;
    const { from, to } = e as { from?: unknown; to?: unknown };
    if (!validRef(from) || !validRef(to) || from === to || !wave.has(from) || !wave.has(to)) continue;
    const key = `${from.length}:${from}${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  edges.sort((a, b) => refOrder(a.from, b.from) || refOrder(a.to, b.to));

  const ups = new Map<string, string[]>(refs.map((r) => [r, []]));
  const linked = new Set<string>();
  for (const e of edges) {
    ups.get(e.to)!.push(e.from);
    linked.add(e.from);
    linked.add(e.to);
  }
  for (const list of ups.values()) list.sort(refOrder);
  return { refs, wave, edges, ups, linked };
}

/** Each node's layer: longest path from the roots for linked nodes, the dense rank of its wave (or 0) for the rest. */
function layerOf(n: Normal): Map<string, number> {
  const layer = new Map<string, number>();
  const open = new Set<string>();
  const visit = (r: string): number => {
    const known = layer.get(r);
    if (known !== undefined) return known;
    open.add(r);
    let l = 0;
    for (const u of n.ups.get(r)!) if (!open.has(u)) l = Math.max(l, visit(u) + 1);
    open.delete(r);
    layer.set(r, l);
    return l;
  };
  for (const r of n.refs) if (n.linked.has(r)) visit(r);

  const isolated = n.refs.filter((r) => !n.linked.has(r));
  const waves = [...new Set(isolated.flatMap((r) => (n.wave.get(r) === null ? [] : [n.wave.get(r)!])))].sort((a, b) => a - b);
  const rank = new Map(waves.map((w, i) => [w, i]));
  for (const r of isolated) {
    const w = n.wave.get(r)!;
    layer.set(r, w === null ? 0 : rank.get(w)!);
  }
  return layer;
}

interface Item {
  item: PlanItem;
  layer: number;
  up: number[];
  down: number[];
}

/** Ties within a layer: a node by its ref, a waypoint by its edge's from, then to; a node before a waypoint on the same first ref. */
function tie(a: PlanItem, b: PlanItem): number {
  const a0 = a.kind === 'node' ? a.ref : a.from;
  const b0 = b.kind === 'node' ? b.ref : b.from;
  const first = refOrder(a0, b0);
  if (first) return first;
  if (a.kind === 'node' && b.kind === 'node') return 0;
  if (a.kind === 'node') return -1;
  if (b.kind === 'node') return 1;
  return refOrder(a.to, b.to);
}

/** Layers and within-layer order, waypoints included: topology only, no geometry. */
export function planOrder(plan: PlanIn): PlanOrder {
  const n = normalise(plan);
  if (n.refs.length === 0) return { layers: [], edges: [] };
  const layer = layerOf(n);
  const edges = n.edges.filter((e) => layer.get(e.to)! > layer.get(e.from)!);

  const items: Item[] = [];
  const nodeId = new Map<string, number>();
  for (const ref of n.refs) {
    nodeId.set(ref, items.length);
    items.push({ item: { kind: 'node', ref }, layer: layer.get(ref)!, up: [], down: [] });
  }
  for (const e of edges) {
    let prev = nodeId.get(e.from)!;
    const end = layer.get(e.to)!;
    for (let l = layer.get(e.from)! + 1; l <= end; l++) {
      const id = l === end ? nodeId.get(e.to)! : items.length;
      if (l !== end) items.push({ item: { kind: 'waypoint', from: e.from, to: e.to }, layer: l, up: [], down: [] });
      items[prev].down.push(id);
      items[id].up.push(prev);
      prev = id;
    }
  }

  const count = Math.max(...items.map((it) => it.layer)) + 1;
  const rows: number[][] = Array.from({ length: count }, () => []);
  for (let id = 0; id < items.length; id++) rows[items[id].layer].push(id);
  const pos = new Array<number>(items.length).fill(0);
  const place = (row: number[]): void => row.forEach((id, i) => (pos[id] = i));
  for (const row of rows) {
    row.sort((a, b) => tie(items[a].item, items[b].item));
    place(row);
  }

  const sweep = (l: number, side: 'up' | 'down'): void => {
    const key = new Map<number, number>();
    for (const id of rows[l]) {
      const near = items[id][side];
      key.set(id, near.length ? near.reduce((s, m) => s + pos[m], 0) / near.length : pos[id]);
    }
    rows[l].sort((a, b) => key.get(a)! - key.get(b)! || tie(items[a].item, items[b].item));
    place(rows[l]);
  };
  for (let pass = 0; pass < 4; pass++) {
    if (pass % 2 === 0) for (let l = 1; l < count; l++) sweep(l, 'up');
    else for (let l = count - 2; l >= 0; l--) sweep(l, 'down');
  }

  return { layers: rows.map((row) => row.map((id) => items[id].item)), edges };
}

/** The plan's boxes and edge paths at a size, from `planOrder`, so every size shares one order. */
export function layoutPlan(plan: PlanIn, size: PlanSize = PLAN_SIZE): PlanLayout {
  const { nodeW, nodeH, colGap, rowGap } = size;
  const order = planOrder(plan);
  const count = order.layers.length;
  if (count === 0) return { width: 0, height: 0, layers: 0, nodes: [], edges: [] };

  const nodes: PlanNodeOut[] = [];
  const box = new Map<string, PlanNodeOut>();
  const via = new Map<string, number>();
  let height = 0;
  order.layers.forEach((row, l) => {
    const x = l * (nodeW + colGap);
    let y = 0;
    let index = 0;
    let bottom = 0;
    for (const it of row) {
      if (it.kind === 'node') {
        const out = { ref: it.ref, layer: l, index: index++, x, y, w: nodeW, h: nodeH };
        nodes.push(out);
        box.set(it.ref, out);
        bottom = y + nodeH;
        y += nodeH + rowGap;
      } else {
        via.set(`${l}:${it.from.length}:${it.from}${it.to}`, y);
        bottom = y;
        y += rowGap;
      }
    }
    height = Math.max(height, bottom);
  });

  const edges = order.edges.map((e): PlanEdgeOut => {
    const a = box.get(e.from)!;
    const b = box.get(e.to)!;
    let x0 = a.x + nodeW;
    let y0 = a.y + nodeH / 2;
    const parts = [`M ${x0} ${y0}`];
    const step = (x1: number, y1: number): void => {
      parts.push(`C ${x0 + colGap / 2} ${y0} ${x1 - colGap / 2} ${y1} ${x1} ${y1}`);
      x0 = x1;
      y0 = y1;
    };
    for (let l = a.layer + 1; l < b.layer; l++) {
      const wy = via.get(`${l}:${e.from.length}:${e.from}${e.to}`)!;
      step(l * (nodeW + colGap), wy);
      x0 += nodeW;
      parts.push(`H ${x0}`);
    }
    step(b.x, b.y + nodeH / 2);
    return { from: e.from, to: e.to, d: parts.join(' ') };
  });

  return { width: count * (nodeW + colGap) - colGap, height, layers: count, nodes, edges };
}
