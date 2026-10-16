// The Project view's graph logic (dashboard/src/lib/project-graph.ts, issue #175): layout, highlight, options.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../dashboard/src/lib/project-graph.ts';
import type { ProjectResponse } from '../dashboard/src/lib/types.ts';

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (n: Box, b: Box) => n.x >= b.x && n.y >= b.y && n.x + n.w <= b.x + b.w && n.y + n.h <= b.y + b.h;

function noOverlaps(nodes: Box[]) {
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) assert.ok(!overlap(nodes[i], nodes[j]), `nodes ${i} and ${j} overlap`);
}

const comp = (name: string, repo: string | null = null, kind: 'library' | 'service' | 'app' = 'service') => ({ name, repo, kind, path: name });

test('single repo with no edges lays out as a grid', () => {
  const names = ['g', 'c', 'a', 'f', 'b', 'e', 'd'];
  const g: ProjectResponse = { components: names.map((n) => comp(n)), backing: [], edges: [], problems: 0 };
  const L = G.layoutProject(g, 'forge', 'Backing services');
  assert.equal(L.bands.length, 1);
  assert.equal(L.bands[0].key, '');
  assert.equal(L.bands[0].label, 'forge');
  assert.deepEqual(L.nodes.map((n) => n.full), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  assert.deepEqual(L.nodes.map((n) => n.col), [0, 1, 2, 3, 0, 1, 2]);
  const ys = [...new Set(L.nodes.map((n) => n.y))];
  assert.equal(ys.length, 2, 'two rows');
  assert.equal(L.nodes.filter((n) => n.y === ys[0]).length, G.GRID_COLS);
  assert.equal(L.nodes.filter((n) => n.y === ys[1]).length, 3);
  assert.equal(ys[1] - ys[0], G.NODE_H + G.ROW_GAP);
  for (const n of L.nodes) assert.equal(n.x, G.BAND_PAD + n.col * (G.NODE_W + G.COL_GAP));
  noOverlaps(L.nodes);
  for (const n of L.nodes) assert.ok(inside(n, L.bands[0]), `${n.id} inside its band`);
  assert.ok(L.width >= Math.max(...L.nodes.map((n) => n.x + n.w)) && L.height >= Math.max(...L.nodes.map((n) => n.y + n.h)));
  // Fewer nodes than GRID_COLS: one row of exactly that many columns.
  const two = G.layoutProject({ components: [comp('x'), comp('y')], backing: [], edges: [], problems: 0 }, 'r', 'b');
  assert.deepEqual(two.nodes.map((n) => [n.col, n.y]), [[0, G.BAND_HEAD], [1, G.BAND_HEAD]]);
  assert.deepEqual(G.layoutProject({ components: [], backing: [], edges: [], problems: 0 }, 'r', 'b'), { width: 0, height: 0, bands: [], nodes: [], edges: [] });
});

const MULTI: ProjectResponse = {
  components: [comp('api', 'acme/backend'), comp('core', null, 'library'), comp('ui', 'acme/design', 'library'), comp('web', null, 'app'), comp('worker', 'acme/backend')],
  backing: ['postgres', 'redis'],
  edges: [
    { from: 'api', to: 'core', target: 'component', type: 'build' },
    { from: 'api', to: 'postgres', target: 'backing', type: 'runtime' },
    { from: 'core', to: 'redis', target: 'backing', type: 'runtime' },
    { from: 'web', to: 'api', target: 'component', type: 'runtime' },
    { from: 'web', to: 'ui', target: 'component', type: 'build' },
    { from: 'worker', to: 'api', target: 'component', type: 'runtime' },
  ],
  problems: 0,
};

/** The first and last points of an SVG path made of M and C commands. */
function ends(d: string) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  assert.match(d, /^M-?\d/);
  return { start: [nums[0], nums[1]], end: [nums[nums.length - 2], nums[nums.length - 1]] };
}
const onEdge = ([x, y]: number[], n: Box) => (x === n.x || x === n.x + n.w) && y >= n.y && y <= n.y + n.h;

test('multi-repo layout: bands, columns, edges, determinism', () => {
  const L = G.layoutProject(MULTI, 'forge', 'Backing services');
  assert.deepEqual(L.bands.map((b) => b.key), ['', 'acme/backend', 'acme/design', G.BACKING_KEY]);
  assert.deepEqual(L.bands.map((b) => b.label), ['forge', 'acme/backend', 'acme/design', 'Backing services']);
  const col = Object.fromEntries(L.nodes.map((n) => [n.id, n.col]));
  assert.equal(col['b:postgres'], 0);
  assert.equal(col['b:redis'], 0);
  assert.equal(col['c:core'], 1, 'no component dependency: at least 1 with backing');
  assert.equal(col['c:ui'], 1);
  assert.equal(col['c:api'], 2);
  assert.equal(col['c:worker'], 3);
  assert.equal(col['c:web'], 3);
  for (const n of L.nodes) {
    const band = L.bands.find((b) => b.key === n.band)!;
    assert.ok(inside(n, band), `${n.id} inside its band`);
    assert.equal(n.label, G.fitLabel(n.full));
  }
  assert.equal(L.nodes.find((n) => n.id === 'c:core')!.componentKind, 'library');
  assert.equal(L.nodes.find((n) => n.id === 'b:redis')!.componentKind, null);
  noOverlaps(L.nodes);
  for (let i = 1; i < L.bands.length; i++) {
    assert.equal(L.bands[i].y, L.bands[i - 1].y + L.bands[i - 1].h + G.BAND_GAP);
    assert.equal(L.bands[i].w, L.bands[0].w, 'every band is as wide as the widest');
  }
  assert.equal(L.edges.length, MULTI.edges.length);
  const byId = new Map(L.nodes.map((n) => [n.id, n]));
  for (const e of L.edges) {
    const s = byId.get(`c:${e.from}`)!;
    const t = byId.get(`${e.target === 'component' ? 'c' : 'b'}:${e.to}`)!;
    const { start, end } = ends(e.d);
    assert.ok(onEdge(start, s), `${e.from}->${e.to} starts at its source (${e.d})`);
    assert.ok(onEdge(end, t), `${e.from}->${e.to} ends at its target (${e.d})`);
  }
  assert.deepEqual(G.layoutProject(structuredClone(MULTI), 'forge', 'Backing services'), L);
});

test('cycles terminate', () => {
  const runtime: ProjectResponse = {
    components: [comp('a'), comp('b')],
    backing: [],
    edges: [
      { from: 'a', to: 'b', target: 'component', type: 'runtime' },
      { from: 'b', to: 'a', target: 'component', type: 'runtime' },
    ],
    problems: 0,
  };
  const build: ProjectResponse = {
    components: [comp('x'), comp('y'), comp('z')],
    backing: ['db'],
    edges: [
      { from: 'x', to: 'y', target: 'component', type: 'build' },
      { from: 'y', to: 'z', target: 'component', type: 'build' },
      { from: 'z', to: 'x', target: 'component', type: 'build' },
      { from: 'z', to: 'db', target: 'backing', type: 'runtime' },
    ],
    problems: 1,
  };
  for (const g of [runtime, build]) {
    const L = G.layoutProject(g, 'r', 'b');
    assert.equal(L.nodes.length, g.components.length + g.backing.length);
    assert.equal(new Set(L.nodes.map((n) => n.id)).size, L.nodes.length, 'one node, so one column, per id');
    for (const n of L.nodes) assert.ok(Number.isFinite(n.col) && n.col >= 0, `${n.id} has a finite column`);
    for (const e of L.edges) assert.doesNotMatch(e.d, /NaN|Infinity/);
    noOverlaps(L.nodes);
  }
});

test('highlight: touched, transitive consumers, edges', () => {
  const h = G.highlight(MULTI, ['core', 'not-a-component']);
  assert.equal(h.matched, true);
  assert.deepEqual([...h.touched], ['core']);
  assert.deepEqual([...h.consumers].sort(), ['api', 'web', 'worker']);
  assert.deepEqual([...h.edges].sort(), ['api|core|build', 'web|api|runtime', 'worker|api|runtime']);
  // Touching a consumer as well keeps it touched, never a consumer, and backing is never highlighted.
  const both = G.highlight(MULTI, ['core', 'api']);
  assert.deepEqual([...both.touched].sort(), ['api', 'core']);
  assert.deepEqual([...both.consumers].sort(), ['web', 'worker']);
  assert.ok(!both.consumers.has('postgres') && !both.touched.has('postgres'));
  assert.deepEqual([...both.edges].sort(), ['web|api|runtime', 'worker|api|runtime']);
  // A cycle walks once.
  const cyc: ProjectResponse = { components: [comp('a'), comp('b')], backing: [], edges: [{ from: 'a', to: 'b', target: 'component', type: 'runtime' }, { from: 'b', to: 'a', target: 'component', type: 'runtime' }], problems: 0 };
  const c = G.highlight(cyc, ['a']);
  assert.deepEqual([...c.consumers], ['b']);
  assert.deepEqual([...c.edges], ['b|a|runtime']);
  for (const s of [[], ['ghost'], ['postgres']]) {
    const none = G.highlight(MULTI, s);
    assert.equal(none.matched, false);
    assert.equal(none.touched.size + none.consumers.size + none.edges.size, 0);
  }
  assert.equal(G.edgeKey({ from: 'a', to: 'b', type: 'build' }), 'a|b|build');
});

test('job options and labels', () => {
  const job = (id: string, state: string, services: unknown = []) => ({ id, title: `T${id}`, state, services }) as any;
  const opts = G.jobOptions([job('9-b', 'running', ['api']), job('10-a', 'waiting'), job('3', 'done'), job('4', 'cancelled'), job('5', 'failed'), job('1-c', 'queued', null)]);
  assert.deepEqual(opts, [
    { id: '1-c', label: '1-c · T1-c', services: [] },
    { id: '10-a', label: '10-a · T10-a', services: [] },
    { id: '9-b', label: '9-b · T9-b', services: ['api'] },
  ]);
  assert.equal(G.LABEL_MAX, 22);
  assert.equal(G.fitLabel('a'.repeat(22)), 'a'.repeat(22));
  assert.equal(G.fitLabel('a'.repeat(23)), `${'a'.repeat(21)}…`);
  assert.equal([...G.fitLabel('b'.repeat(40))].length, 22);
  assert.equal(G.fitLabel('abcdef', 4), 'abc…');
});
