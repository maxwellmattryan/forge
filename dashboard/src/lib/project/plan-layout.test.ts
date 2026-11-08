// A mandate's plan laid out by dependency depth: layers, order within a layer, boxes and edge paths, the
// compact size, determinism and bad input, over small fixtures and a 30-node plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutPlan, PLAN_SIZE, PLAN_SIZE_COMPACT, refOrder } from './plan-layout.ts';
import type { PlanIn, PlanLayout, PlanNodeOut } from './plan-layout.ts';

type NodeIn = { ref: string; wave?: unknown; state?: string; title?: string; job?: string | null };
const plan = (nodes: (string | NodeIn)[], edges: [string, string][]): PlanIn =>
  ({ nodes: nodes.map((n) => (typeof n === 'string' ? { ref: n } : n)), edges: edges.map(([from, to]) => ({ from, to })) }) as PlanIn;

const node = (l: PlanLayout, ref: string): PlanNodeOut => {
  const n = l.nodes.find((x) => x.ref === ref);
  assert.ok(n, `no node ${ref}`);
  return n;
};
const placed = (l: PlanLayout): [string, number, number][] => l.nodes.map((n) => [n.ref, n.layer, n.index]);

const thirty = (): PlanIn => {
  const ref = (g: number, s: number): string => `#${5 * g + s + 1}`;
  const nodes: string[] = [];
  const edges: [string, string][] = [];
  for (let g = 0; g < 6; g++)
    for (let s = 0; s < 5; s++) {
      nodes.push(ref(g, s));
      if (g >= 1) edges.push([ref(g - 1, s), ref(g, s)], [ref(g - 1, (s + 2) % 5), ref(g, s)]);
      if (g >= 2 && s === 0) edges.push([ref(g - 2, 4), ref(g, s)]);
    }
  return plan(nodes, edges);
};

const fixtures: Record<string, PlanIn> = {
  chain: plan(['#1', '#2', '#3'], [['#1', '#2'], ['#2', '#3']]),
  diamond: plan(['#1', '#2', '#3', '#4'], [['#1', '#2'], ['#1', '#3'], ['#2', '#4'], ['#3', '#4']]),
  fanIn: plan(['#10', '#2', '#3', '#20'], [['#10', '#20'], ['#2', '#20'], ['#3', '#20']]),
  transitive: plan(['#1', '#2', '#3'], [['#1', '#2'], ['#2', '#3'], ['#1', '#3']]),
  isolated: plan(['#1', '#2', { ref: '#5' }, { ref: '#6', wave: 4 }, { ref: '#7', wave: 2 }, { ref: '#8', wave: -1 }], [['#1', '#2'], ['#5', '#99'], ['#5', '#5']]),
  waveOnly: plan([{ ref: '#3', wave: 1 }, { ref: '#1', wave: 1 }, { ref: '#2', wave: 3 }, { ref: '#4' }], []),
  cycle: plan(['#1', '#2'], [['#1', '#2'], ['#2', '#1']]),
  malformed: { nodes: [{ ref: '#1' }, { ref: '#1', wave: 2 }, { ref: '' }, { ref: 7 }, null, { ref: '#2', wave: 1 }, 'x'], edges: [{ from: '#1', to: '#2' }, { from: '#1', to: '#2' }, null, { from: 3, to: '#2' }] } as unknown as PlanIn,
  thirty: thirty(),
};

test('lays out a chain', () => {
  const l = layoutPlan(fixtures.chain);
  assert.deepEqual(placed(l), [['#1', 0, 0], ['#2', 1, 0], ['#3', 2, 0]]);
  assert.equal(new Set(l.nodes.map((n) => n.y)).size, 1);
  assert.equal(l.edges.length, 2);
  const y = l.nodes[0].y + PLAN_SIZE.nodeH / 2;
  for (const e of l.edges) {
    const nums = e.d.split(/\s+/).filter((t) => !/[A-Z]/.test(t)).map(Number);
    assert.equal(nums[1], y);
    assert.equal(nums[nums.length - 1], y);
  }
  assert.equal(l.width, 3 * PLAN_SIZE.nodeW + 2 * PLAN_SIZE.colGap);
  assert.equal(l.height, PLAN_SIZE.nodeH);
});

test('lays out a diamond', () => {
  assert.deepEqual(placed(layoutPlan(fixtures.diamond)), [['#1', 0, 0], ['#2', 1, 0], ['#3', 1, 1], ['#4', 2, 0]]);
});

test('lays out a fan-in and routes a long edge through a waypoint', () => {
  assert.deepEqual(placed(layoutPlan(fixtures.fanIn)), [['#2', 0, 0], ['#3', 0, 1], ['#10', 0, 2], ['#20', 1, 0]]);
  const t = layoutPlan(fixtures.transitive);
  assert.equal(node(t, '#3').layer, 2);
  const long = t.edges.find((e) => e.from === '#1' && e.to === '#3');
  assert.ok(long);
  const cmds = long.d.split(/\s+/).filter((x) => /[A-Z]/.test(x));
  assert.deepEqual(cmds, ['M', 'C', 'H', 'C']);
  for (const [a, b] of [['#2', '#10'], ['a/b#3', 'c/d#1'], ['#99', 'job-1'], ['#02', '#2']]) assert.ok(refOrder(a, b) < 0 && refOrder(b, a) > 0, `${a} < ${b}`);
});

test('places an isolated node by its wave or in layer 0', () => {
  const l = layoutPlan(fixtures.isolated);
  assert.equal(node(l, '#5').layer, 0);
  assert.equal(node(l, '#8').layer, 0);
  assert.equal(node(l, '#7').layer, 0);
  assert.equal(node(l, '#6').layer, 1);
  assert.deepEqual(l.edges.map((e) => [e.from, e.to]), [['#1', '#2']]);
  for (const wave of [-1, 1.5, '2']) assert.equal(node(layoutPlan(plan(['#1', { ref: '#2', wave: 5 }, { ref: '#3', wave }], [])), '#3').layer, 0);
});

test('lays out a wave-only plan', () => {
  const l = layoutPlan(fixtures.waveOnly);
  assert.deepEqual(placed(l), [['#1', 0, 0], ['#3', 0, 1], ['#4', 0, 2], ['#2', 1, 0]]);
  assert.deepEqual(l.edges, []);
});

test('lays out a 30-node plan in under 5 ms', () => {
  const p = fixtures.thirty;
  const l = layoutPlan(p);
  assert.equal(l.nodes.length, 30);
  assert.equal(l.edges.length, 54);
  for (const e of l.edges) assert.ok(node(l, e.from).layer < node(l, e.to).layer, `${e.from}→${e.to}`);
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    layoutPlan(p);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best < 5, `best run took ${best} ms`);
});

test('is deterministic and ignores node state', () => {
  for (const [name, p] of Object.entries(fixtures)) {
    const once = JSON.stringify(layoutPlan(p));
    assert.equal(JSON.stringify(layoutPlan(p)), once, name);
    const reversed = { nodes: [...p.nodes].reverse(), edges: [...p.edges].reverse() };
    assert.equal(JSON.stringify(layoutPlan(reversed)), once, `${name} reversed`);
    const dressed = { ...p, nodes: p.nodes.map((n, i) => (n && typeof n === 'object' ? { ...n, state: i % 2 ? 'merged' : 'running', title: `t${i}`, job: `j${i}` } : n)) };
    assert.equal(JSON.stringify(layoutPlan(dressed)), once, `${name} dressed`);
    for (const n of layoutPlan(dressed).nodes) assert.deepEqual(Object.keys(n).sort(), ['h', 'index', 'layer', 'ref', 'w', 'x', 'y']);
  }
});

/** Every point along a path: each cubic at 50 values of t, and both ends of each H. */
function samples(d: string): [number, number][] {
  const tok = d.split(/\s+/);
  const out: [number, number][] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < tok.length; ) {
    const c = tok[i++];
    if (c === 'M') {
      x = Number(tok[i++]);
      y = Number(tok[i++]);
      out.push([x, y]);
    } else if (c === 'H') {
      out.push([x, y]);
      x = Number(tok[i++]);
      out.push([x, y]);
    } else if (c === 'C') {
      const [x1, y1, x2, y2, x3, y3] = tok.slice(i, i + 6).map(Number);
      i += 6;
      for (let k = 0; k <= 50; k++) {
        const t = k / 50;
        const u = 1 - t;
        out.push([u ** 3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x3, u ** 3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y3]);
      }
      x = x3;
      y = y3;
    } else assert.fail(`unexpected command ${c} in ${d}`);
  }
  return out;
}

test('no edge crosses a node box', () => {
  for (const size of [PLAN_SIZE, PLAN_SIZE_COMPACT])
    for (const [name, p] of Object.entries(fixtures)) {
      const l = layoutPlan(p, size);
      for (const e of l.edges)
        for (const [px, py] of samples(e.d))
          for (const n of l.nodes) assert.ok(!(n.x < px && px < n.x + n.w && n.y < py && py < n.y + n.h), `${name}: ${e.from}→${e.to} crosses ${n.ref}`);
    }
});

test('the compact variant keeps the same order', () => {
  for (const [name, p] of Object.entries(fixtures)) {
    const regular = layoutPlan(p);
    const compact = layoutPlan(p, PLAN_SIZE_COMPACT);
    assert.deepEqual(placed(compact), placed(regular), name);
    if (regular.nodes.length) assert.ok(compact.width < regular.width, name);
  }
});

test('survives cycles, duplicates and malformed nodes', () => {
  const c = layoutPlan(fixtures.cycle);
  assert.deepEqual(c.nodes.map((n) => n.ref).sort(), ['#1', '#2']);
  assert.equal(c.edges.length, 1);
  assert.ok(node(c, c.edges[0].from).layer < node(c, c.edges[0].to).layer);

  const m = layoutPlan(fixtures.malformed);
  assert.deepEqual(placed(m), [['#1', 0, 0], ['#2', 1, 0]]);
  assert.deepEqual(m.edges.map((e) => [e.from, e.to]), [['#1', '#2']]);
  const dup = layoutPlan(plan([{ ref: '#1', wave: 3 }, { ref: '#1', wave: 1 }, { ref: '#2', wave: 2 }], []));
  assert.deepEqual(placed(dup), [['#1', 0, 0], ['#2', 1, 0]]);

  for (const empty of [plan([], []), { nodes: null, edges: undefined } as unknown as PlanIn, null as unknown as PlanIn])
    assert.deepEqual(layoutPlan(empty), { width: 0, height: 0, layers: 0, nodes: [], edges: [] });
});
