// The Pipeline graph: every job exactly once in layout order, a filed goal mandate readied in place by a merge, node
// marks and state lines, the merges that heat an edge, the No mandate section, filters that dim without moving, and
// each plate's plan status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { graphMarks, heatedEdges, newlyMerged, pipelineGraph } from './pipeline-graph.ts';
import type { Block, GNode, GraphInput, GraphMandate, PipelineGraph } from './pipeline-graph.ts';
import { PLAN_SIZE } from './plan-layout.ts';
import type { JobLike } from '../jobs/state.ts';
import type { MandatePlanResponse, MandateRow } from '../core/types.ts';

type JobIn = { id: string; issue?: string } & Record<string, unknown>;
let clock = 0;
const job = ({ id, issue, ...o }: JobIn): JobLike =>
  ({
    id,
    title: `Job ${id}`,
    kind: 'feature',
    stage: 'build',
    state: 'running',
    createdAt: new Date(Date.UTC(2026, 10, 1, 0, clock++)).toISOString(),
    mandate: null,
    dependsOn: [],
    issues: issue ? [{ tracker: 'github', ref: issue }] : [],
    ...o,
  }) as JobLike;

const mandate = (id: string, o: Partial<MandateRow> = {}): GraphMandate => ({ id, title: `Mandate ${id}`, status: 'active', state: 'active', ...o }) as GraphMandate;

type NodeIn = [ref: string, job?: string | null, state?: string, wave?: number | null, title?: string];
const plan = (id: string, nodes: NodeIn[], edges: [string, string][] = [], problems: string[] = []): MandatePlanResponse =>
  ({
    mandate: id,
    readAt: '2026-11-08T00:00:00.000Z',
    nodes: nodes.map(([ref, j = null, state = 'planned', wave = null, title = `Issue ${ref}`]) => ({ ref, title, wave, job: j, state })),
    edges: edges.map(([from, to]) => ({ from, to, source: 'body' })),
    problems: problems.map((detail) => ({ kind: 'malformed', ref: null, detail, edges: [] })),
  }) as MandatePlanResponse;

const graph = (o: Partial<GraphInput>): PipelineGraph =>
  pipelineGraph({ jobs: [], mandates: [], plans: {}, planErrors: {}, filter: 'all', size: PLAN_SIZE, ...o });

const blocks = (g: PipelineGraph): Block[] => [...g.plates.map((p) => p.block), ...g.loose.chains, ...g.loose.lone];
const allNodes = (g: PipelineGraph): GNode[] => blocks(g).flatMap((b) => b.nodes);
const nodeById = (g: PipelineGraph, id: string): GNode => {
  const n = allNodes(g).find((x) => x.id === id);
  assert.ok(n, `no node ${JSON.stringify(id)}`);
  return n;
};
const places = (g: PipelineGraph): [string, number, number][] => allNodes(g).map((n) => [n.id, n.x, n.y]);
const edge = (g: PipelineGraph, from: string, to: string) => {
  const e = blocks(g)
    .flatMap((b) => b.edges)
    .find((x) => x.from === from && x.to === to);
  assert.ok(e, `no edge ${from} → ${to}`);
  return e;
};

test('every job appears exactly once', () => {
  const A = 'm-0000aaaa';
  const D = 'm-0000dddd';
  const jobs = [
    job({ id: 'a1', issue: '#1', mandate: A, stage: 'done', state: 'done' }),
    job({ id: 'a2', issue: '#2', mandate: A }),
    job({ id: 'a3', issue: '#2', mandate: A, title: 'A second job on #2' }),
    job({ id: 'a4', mandate: A, title: 'No issue', dependsOn: ['a2'] }),
    job({ id: 'a5', issue: '#3', mandate: A, title: 'Just started on #3' }),
    job({ id: 'closed1', mandate: 'm-0000c105' }),
    job({ id: 'unread1', mandate: 'm-0000bad0' }),
    job({ id: 'gone1', mandate: 'm-0000dead' }),
    job({ id: 'eval1', kind: 'eval' }),
    job({ id: 'tidy' }),
    job({ id: 'doc', dependsOn: ['tidy'] }),
    job({ id: 'lone' }),
    job({ id: 'd1', issue: '#9', mandate: D }),
  ];
  const g = graph({
    jobs,
    mandates: [mandate(A), mandate('m-0000c105', { status: 'closed', state: 'closed' }), { id: 'm-0000bad0', problem: 'unreadable' }, mandate(D)],
    plans: {
      [A]: plan(A, [['#1', 'a1', 'merged'], ['#2', 'a2', 'running'], ['#3']], [['#1', '#2'], ['#1', '#3']]),
      [D]: plan(D, [['#9', 'd1', 'running']]),
    },
  });

  const seen = allNodes(g).flatMap((n) => (n.job ? [n.job] : []));
  assert.deepEqual([...seen].sort(), jobs.map((j) => j.id as string).sort(), 'every job is one node');
  assert.equal(new Set(seen).size, seen.length, 'no job twice');
  assert.deepEqual(g.plates.map((p) => p.id), [A, D], 'open mandates only, in list order');

  assert.equal(nodeById(g, `${A}|#3`).job, 'a5', 'a job the plan has not attached yet takes its issue node');
  assert.equal(nodeById(g, `${A}|\0job a3`).ref, '#2', 'a second job on one issue is an extra node');
  assert.equal(nodeById(g, `${A}|\0job a4`).ref, null);
  assert.equal(edge(g, `${A}|#2`, `${A}|\0job a4`).solid, false, "an extra node's dependsOn link is an edge");
  assert.equal(g.plates[0].total, 5);
  assert.equal(g.plates[0].merged, 1);

  assert.deepEqual(g.loose.chains.map((b) => b.nodes.map((n) => n.job)), [['tidy', 'doc']]);
  assert.deepEqual(g.loose.lone.map((b) => b.nodes[0].job), ['closed1', 'unread1', 'gone1', 'eval1', 'lone']);
  assert.equal(g.loose.count, 7);

  // Tab order: plates in mandate order, each block by column then top to bottom, then the chains, then the lone jobs.
  for (const b of blocks(g)) {
    const sorted = [...b.nodes].sort((p, q) => p.x - q.x || p.y - q.y);
    assert.deepEqual(b.nodes.map((n) => n.id), sorted.map((n) => n.id), 'a block lists its nodes by column, then row');
  }
  const order = allNodes(g).map((n) => n.id);
  const at = (id: string): number => order.indexOf(id);
  assert.ok(at(`${A}|#1`) < at(`${D}|#9`) && at(`${D}|#9`) < at('loose|\0job tidy') && at('loose|\0job doc') < at('loose|\0job closed1'));
  assert.equal(new Set(order).size, order.length, 'node ids are unique across the graph');
});

test('a filed goal mandate: every issue from the start; a merge readies its dependants in place', () => {
  const G = 'm-00006001';
  const goal = { id: G, title: 'Ship billing', status: 'active', state: 'active', intake: false, filedAt: '2026-11-01T00:00:00.000Z' } satisfies Partial<MandateRow>;
  const edges: [string, string][] = [
    ['forge#10', 'forge#11'],
    ['forge#10', 'forge#12'],
    ['forge#11', 'forge#13'],
    ['forge#12', 'forge#13'],
  ];
  const nodes = (j10: string | null, s10: string, j12: string | null, s12: string): NodeIn[] => [
    ['forge#10', j10, s10, 1],
    ['forge#11', null, 'waiting', 2],
    ['forge#12', j12, s12, 2],
    ['forge#13', null, 'waiting', 3],
    ['forge#14', null, 'planned', 3],
  ];
  const at = (jobs: JobLike[], p: MandatePlanResponse) => graph({ jobs, mandates: [goal], plans: { [G]: p } });

  const before = at([], plan(G, nodes(null, 'ready', null, 'waiting'), edges));
  assert.equal(before.plates[0].total, 5, 'every scope issue is a node before any job');
  for (const n of before.plates[0].block.nodes) {
    assert.equal(n.dashed, true, `${n.key} dashed`);
    assert.equal(n.steps, null, `${n.key} has no track`);
    assert.equal(n.job, null);
  }
  const id = (ref: string): string => `${G}|${ref}`;
  assert.equal(nodeById(before, id('forge#10')).mark, 'ready');
  assert.deepEqual(nodeById(before, id('forge#11')).line, { kind: 'waits', ref: 'forge#10', more: 0 });
  assert.deepEqual(nodeById(before, id('forge#13')).line, { kind: 'waits', ref: 'forge#11', more: 1 });
  assert.equal(nodeById(before, id('forge#14')).mark, 'planned');

  const running = job({ id: 'j10', issue: 'forge#10', mandate: G });
  const sibling = job({ id: 'j12', issue: 'forge#12', mandate: G, stage: 'verify' });
  const p = plan(G, nodes('j10', 'running', 'j12', 'running'), edges);
  const mid = at([running, sibling], p);
  assert.equal(nodeById(mid, id('forge#11')).mark, 'waiting');
  assert.deepEqual(nodeById(mid, id('forge#11')).line, { kind: 'waits', ref: 'forge#10', more: 0 });
  assert.equal(edge(mid, id('forge#10'), id('forge#11')).solid, false);
  assert.equal(nodeById(mid, id('forge#12')).mark, 'running');

  // The job lands between plan fetches: the old plan still calls forge#10 running.
  const after = at([{ ...running, stage: 'done', state: 'done' }, sibling], p);
  assert.equal(nodeById(after, id('forge#10')).mark, 'merged');
  assert.equal(nodeById(after, id('forge#11')).mark, 'ready');
  assert.deepEqual(nodeById(after, id('forge#11')).line, { kind: 'ready' });
  assert.equal(edge(after, id('forge#10'), id('forge#11')).solid, true);
  assert.equal(edge(after, id('forge#10'), id('forge#12')).solid, true);
  assert.equal(edge(after, id('forge#11'), id('forge#13')).solid, false);
  assert.deepEqual(nodeById(after, id('forge#13')).line, { kind: 'waits', ref: 'forge#11', more: 1 }, 'forge#12 is still running');
  assert.deepEqual(places(after), places(mid), 'a merge moves nothing');
  assert.deepEqual(places(after), places(before), 'nor does a job starting');
  assert.equal(after.plates[0].merged, 1);
});

test('node marks and state lines', () => {
  const M = 'm-00001234';
  const park = { state: 'waiting', waitingOn: 'external', reason: 'dependencies not done: up' };
  const jobs = [
    job({ id: 'done', issue: '#1', mandate: M, stage: 'done', state: 'done' }),
    job({ id: 'run', issue: '#2', mandate: M, stage: 'build', state: 'running' }),
    job({ id: 'gate', issue: '#3', mandate: M, stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' }),
    job({ id: 'up', issue: '#4', mandate: M, stage: 'review', state: 'running' }),
    job({ id: 'parked', issue: '#5', mandate: M, stage: 'backlog', ...park }),
    job({ id: 'cancel', issue: '#8', mandate: M, stage: 'build', state: 'cancelled' }),
  ];
  const g = graph({
    jobs,
    mandates: [mandate(M)],
    plans: {
      [M]: plan(
        M,
        [['#1', 'done', 'merged'], ['#2', 'run', 'running'], ['#3', 'gate', 'running'], ['#4', 'up', 'running'], ['#5', 'parked', 'waiting'], ['#6', null, 'ready'], ['#7'], ['#8', 'cancel', 'planned'], ['#9', 'archived', 'running'], ['#10', 'old', 'merged', null, '']],
        [['#4', '#5'], ['#1', '#6']],
      ),
    },
  });
  const past = (n: GNode): number | null => (n.steps ? n.steps.filter((s) => s.status === 'past').length : null);
  const rows: [ref: string, mark: string, line: unknown, dashed: boolean, steps: number | null, job: string | null][] = [
    ['#1', 'merged', { kind: 'merged' }, false, 9, 'done'],
    ['#2', 'running', { kind: 'stage', stage: 'Build', state: null }, false, 3, 'run'],
    ['#3', 'held', { kind: 'stage', stage: 'Spec', state: 'Spec approval' }, false, 1, 'gate'],
    ['#5', 'waiting', { kind: 'waits', ref: '#4', more: 0 }, false, 0, 'parked'],
    ['#6', 'ready', { kind: 'ready' }, true, null, null],
    ['#7', 'planned', { kind: 'planned' }, true, null, null],
    ['#8', 'cancelled', { kind: 'cancelled' }, true, null, 'cancel'],
    ['#9', 'running', { kind: 'running' }, true, null, null],
    ['#10', 'merged', { kind: 'merged' }, true, 9, null],
  ];
  for (const [ref, mark, line, dashed, steps, j] of rows) {
    const n = nodeById(g, `${M}|${ref}`);
    assert.deepEqual({ mark: n.mark, line: n.line, dashed: n.dashed, steps: past(n), job: n.job }, { mark, line, dashed, steps, job: j }, ref);
  }
  assert.equal(nodeById(g, `${M}|#10`).title, '#10', 'an empty title shows the ref');
  assert.equal(nodeById(g, `${M}|#2`).title, 'Issue #2', 'the plan title wins');
  assert.equal(nodeById(g, `${M}|#2`).steps?.find((s) => s.status === 'current')?.stage, 'build');

  // A park whose upstream merged, or that has none in the block, is held, with the park's own label.
  const g2 = graph({ jobs: [job({ id: 'p', ...park, stage: 'backlog' }), job({ id: 'q', stage: 'backlog', state: 'queued' })] });
  assert.deepEqual({ mark: g2.loose.lone[0].nodes[0].mark, line: g2.loose.lone[0].nodes[0].line }, { mark: 'held', line: { kind: 'stage', stage: 'Queued', state: 'Dependencies' } });
  assert.deepEqual(g2.loose.lone[1].nodes[0].line, { kind: 'stage', stage: 'Queued', state: null }, 'a state that repeats the stage is left out');
});

test('newlyMerged', () => {
  const M = 'm-00005678';
  const base = (state: string, extra: JobLike[] = []) =>
    graph({
      jobs: [job({ id: 'x', issue: '#1', mandate: M, state, stage: state === 'done' ? 'done' : 'build' }), ...extra],
      mandates: [mandate(M)],
      plans: { [M]: plan(M, [['#1', 'x', 'running'], ['#2']], [['#1', '#2']]) },
    });
  const before = graphMarks(base('running'));
  const landed = base('done', [job({ id: 'fresh', state: 'done', stage: 'done' })]);
  const after = graphMarks(landed);
  assert.deepEqual(heatedEdges(landed, newlyMerged(before, after)), [edge(landed, `${M}|#1`, `${M}|#2`).id], 'its outgoing edges heat');
  assert.deepEqual(newlyMerged(null, after), [], 'the first render never heats');
  assert.deepEqual(newlyMerged(before, after), [`${M}|#1`], 'present and unmerged, then merged');
  assert.ok(!newlyMerged(before, after).includes('loose|\0job fresh'), 'a node that appears already merged never heats');
  assert.deepEqual(newlyMerged(after, after), [], 'a merged node stays quiet');
});

test('no mandate: lone jobs, chains and orphaned mandate jobs', () => {
  const jobs = [
    job({ id: 'b', createdAt: '2026-11-02T00:00:00.000Z' }),
    job({ id: 'a', createdAt: '2026-11-02T00:00:00.000Z' }),
    job({ id: 'undated', createdAt: null }),
    job({ id: 'early', createdAt: '2026-11-01T00:00:00.000Z' }),
    job({ id: 'tail', createdAt: '2026-11-05T00:00:00.000Z', dependsOn: ['head'] }),
    job({ id: 'head', createdAt: '2026-11-04T00:00:00.000Z' }),
    job({ id: 'closed', mandate: 'm-0000c105', createdAt: '2026-11-03T00:00:00.000Z' }),
    job({ id: 'deleted', mandate: 'm-0000dead', createdAt: '2026-11-03T01:00:00.000Z' }),
    job({ id: 'unread', mandate: 'm-0000bad0', createdAt: '2026-11-03T02:00:00.000Z' }),
  ];
  const mandates = [mandate('m-0000c105', { status: 'closed', state: 'closed' }), { id: 'm-0000bad0', problem: 'bad yaml' }];
  const g = graph({ jobs, mandates });
  assert.equal(g.plates.length, 0);
  assert.deepEqual(g.loose.lone.map((b) => b.nodes[0].job), ['early', 'a', 'b', 'closed', 'deleted', 'unread', 'undated'], 'creation, then id, an undated job last');
  assert.equal(g.loose.chains.length, 1);
  const chain = g.loose.chains[0];
  assert.deepEqual(chain.nodes.map((n) => n.job), ['head', 'tail']);
  assert.ok(chain.nodes[1].x > chain.nodes[0].x, 'a dependant sits right of its dependency');
  assert.equal(edge(g, 'loose|\0job head', 'loose|\0job tail').solid, false);
  assert.equal(g.loose.count, jobs.length);

  // A failed mandates list with none earlier: every job, an open mandate's too, goes under No mandate.
  const failed = graph({ jobs: [...jobs, job({ id: 'open1', mandate: 'm-00000001', issue: '#1' })], mandates: null });
  assert.equal(failed.plates.length, 0);
  assert.equal(failed.loose.count, jobs.length + 1);
  assert.ok(allNodes(failed).some((n) => n.job === 'open1'));
});

test('filters dim without moving', () => {
  const M = 'm-00009999';
  const jobs = [
    job({ id: 'm1', issue: '#1', mandate: M, stage: 'done', state: 'done' }),
    job({ id: 'm2', issue: '#2', mandate: M, stage: 'spec', state: 'waiting', waitingOn: 'spec-approval' }),
    job({ id: 'free', stage: 'build', state: 'running' }),
    job({ id: 'ev', kind: 'eval', stage: 'build', state: 'running' }),
  ];
  const input = {
    jobs,
    mandates: [mandate(M)],
    plans: { [M]: plan(M, [['#1', 'm1', 'merged'], ['#2', 'm2', 'running'], ['#3', null, 'ready'], ['#4', 'x', 'merged']], [['#1', '#2'], ['#1', '#3'], ['#4', '#3']]) },
  };
  const by = (f: string) => graph({ ...input, filter: f });
  const matched = (g: PipelineGraph) => allNodes(g).filter((n) => n.match).map((n) => n.id).sort();
  const all = by('all');
  for (const f of ['active', 'waiting', 'done']) assert.deepEqual(places(by(f)), places(all), `${f} moves nothing and removes nothing`);
  assert.equal(matched(all).length, allNodes(all).length);
  assert.deepEqual(matched(by('done')), [`${M}|#1`, `${M}|#4`]);
  assert.deepEqual(matched(by('waiting')), [`${M}|#2`]);
  assert.deepEqual(matched(by('active')), ['loose|\0job free', `${M}|#2`, `${M}|#3`], 'an eval job matches only All');
  const waiting = by('waiting');
  assert.equal(edge(waiting, `${M}|#1`, `${M}|#3`).dim, true, 'both ends dimmed');
  assert.equal(edge(waiting, `${M}|#1`, `${M}|#2`).dim, false, 'one end kept');
});

test('plate status: loading, error, kept plan, problems', () => {
  const M = 'm-0000abcd';
  const jobs = [job({ id: 'j1', issue: '#1', mandate: M }), job({ id: 'j2', issue: '#2', mandate: M, dependsOn: ['j1'] })];
  const base = { jobs, mandates: [mandate(M)] };

  const loading = graph(base).plates[0];
  assert.equal(loading.status, 'loading');
  assert.equal(loading.block.nodes.length, 0);
  assert.equal(graph(base).loose.count, 0, "a loading plate's jobs wait for it");

  const failed = graph({ ...base, planErrors: { [M]: 'HTTP 500' } }).plates[0];
  assert.equal(failed.status, 'error');
  assert.equal(failed.error, 'HTTP 500');
  assert.deepEqual(failed.block.nodes.map((n) => n.job), ['j1', 'j2'], 'the live jobs still show');
  assert.equal(failed.block.edges.length, 1, 'with their dependsOn edge');

  const problems = ['one', 'two', 'three', 'four', 'five'];
  const kept = graph({ ...base, plans: { [M]: plan(M, [['#1', 'j1', 'running'], ['#2', 'j2', 'running']], [['#1', '#2']], problems) }, planErrors: { [M]: 'timeout' } }).plates[0];
  assert.equal(kept.status, 'ready', 'an earlier plan is kept');
  assert.equal(kept.error, 'timeout', 'beside the error');
  assert.equal(kept.total, 2);
  assert.deepEqual(kept.problems, ['one', 'two', 'three']);
  assert.equal(kept.moreProblems, 2);

  const none = graph({ ...base, jobs: [], plans: { [M]: plan(M, []) } }).plates[0];
  assert.deepEqual({ status: none.status, total: none.total, problems: none.problems, more: none.moreProblems }, { status: 'ready', total: 0, problems: [], more: 0 });
});
