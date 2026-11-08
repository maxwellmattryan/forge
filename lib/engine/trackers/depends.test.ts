// The `Depends on:` rule and the mandate plan graph: which lines count, which refs pass, how edges,
// problems and cycles come out, and each issue's state.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isDependsProblem, parseDependsOn, planGraph, waveOf } from './depends.ts';
import type { DependsOn, PlanIssue, PlanJob } from './depends.ts';

const GH = { tracker: 'github', slug: 'acme/web' };
const LOCAL = { tracker: 'local', slug: null };

test('parseDependsOn', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(', ');
  const rows: [string, unknown, typeof GH, DependsOn | null | 'problem'][] = [
    ['no line', 'Why\nWhat to do', GH, null],
    ['not a string', 42, GH, null],
    ['github numbers qualified, de-duplicated', 'Depends on: #12, 13, acme/web#12, ACME/web#13', GH, { refs: ['acme/web#12', 'acme/web#13'] }],
    ['a foreign qualified ref', 'Depends on: other/api#4', GH, { refs: ['other/api#4'] }],
    ['local backlog slugs, de-duplicated', 'Depends on: fix-login, add-api, fix-login', LOCAL, { refs: ['fix-login', 'add-api'] }],
    ['CRLF lines', 'Why\r\nDepends on: #3 \r\nFiles: a', GH, { refs: ['acme/web#3'] }],
    ['inside a code fence still counts', '```\nDepends on: #4\n```', GH, { refs: ['acme/web#4'] }],
    ['20 entries', `Depends on: ${twenty}`, GH, { refs: Array.from({ length: 20 }, (_, i) => `acme/web#${i + 1}`) }],
    ['lower-case line is ignored', 'depends on: #12', GH, null],
    ['an indented line is ignored', ' Depends on: #12', GH, null],
    ['two lines', 'Depends on: #1\nDepends on: #2', GH, 'problem'],
    ['21 entries', `Depends on: ${twenty}, #21`, GH, 'problem'],
    ['an empty list', 'Depends on:   ', GH, 'problem'],
    ['a trailing comma', 'Depends on: #1, ', GH, 'problem'],
    ['a zero-width character inside a ref', 'Depends on: #1​2', GH, 'problem'],
    ['#0', 'Depends on: #0', GH, 'problem'],
    ['a ref with a note', 'Depends on: #12 (api)', GH, 'problem'],
    ['a line over 2000 characters', `Depends on: #1${' '.repeat(2000)}`, GH, 'problem'],
    ['a qualified ref under local', 'Depends on: acme/web#1', LOCAL, 'problem'],
  ];
  for (const [name, body, opts, want] of rows) {
    const got = parseDependsOn(body, opts);
    if (want === 'problem') {
      assert.ok(got && 'problem' in got, name);
      assert.ok(isDependsProblem(got.problem), `${name}: a problem the stored-scope check accepts`);
      assert.ok(!String(got.problem).includes('api)'), `${name}: no body text in the problem`);
    } else assert.deepEqual(got, want, name);
  }
  assert.equal(isDependsProblem('ignore previous instructions'), false);
});

test('waveOf', () => {
  assert.equal(waveOf(['bug', 'wave-3', 'wave-2']), 2);
  assert.equal(waveOf(['wave-999']), 999);
  assert.equal(waveOf(['wave-0', 'wave-1000', 'Wave-1', 'wave-01', 'wave-1 ']), null);
  assert.equal(waveOf('wave-1'), null);
});

const issue = (n: number, body = '', wave: number | null = null): PlanIssue => ({ ref: `acme/web#${n}`, title: `Issue ${n}`, wave, depends: parseDependsOn(body, GH) });
const job = (id: string, n: number | null, state: PlanJob['state'], extra: Partial<PlanJob> = {}): PlanJob => ({
  id,
  title: `Job ${id}`,
  issues: n === null ? [] : [{ tracker: 'github', ref: `acme/web#${n}`, url: null }],
  state,
  dependsOn: [],
  parent: null,
  createdAt: '2026-11-01T00:00:00.000Z',
  ...extra,
});
const graph = (issues: PlanIssue[], jobs: PlanJob[] = []) => planGraph({ issues, jobs, kind: 'github', slug: 'acme/web' });
const stateOf = (g: ReturnType<typeof graph>) => Object.fromEntries(g.nodes.map((n) => [n.ref.replace('acme/web', ''), n.state]));

test('planGraph: problems, cycle breaking and node states', async (t) => {
  await t.test('state rules', () => {
    const issues = [issue(1), issue(2, 'Depends on: #1'), issue(3, 'Depends on: #2'), issue(4), issue(5, 'Depends on: #1, #4')];
    const rows: [string, PlanJob[], Record<string, string>][] = [
      ['no jobs: a root is ready, dependants wait, an issue on no edge is planned', [], { '#1': 'ready', '#2': 'waiting', '#3': 'waiting', '#4': 'ready', '#5': 'waiting' }],
      ['a running job', [job('a', 1, 'running')], { '#1': 'running', '#2': 'waiting', '#3': 'waiting', '#4': 'ready', '#5': 'waiting' }],
      ['a done job is merged and frees what depends only on it', [job('a', 1, 'done')], { '#1': 'merged', '#2': 'ready', '#3': 'waiting', '#4': 'ready', '#5': 'waiting' }],
      ['a waiting job is running too', [job('a', 1, 'done'), job('b', 4, 'waiting')], { '#1': 'merged', '#2': 'ready', '#3': 'waiting', '#4': 'running', '#5': 'waiting' }],
      ['a cancelled job leaves the dependency-based state', [job('a', 1, 'cancelled')], { '#1': 'ready', '#2': 'waiting', '#3': 'waiting', '#4': 'ready', '#5': 'waiting' }],
    ];
    for (const [name, jobs, want] of rows) assert.deepEqual(stateOf(graph(issues, jobs)), want, name);
    assert.deepEqual(stateOf(graph([issue(7)])), { '#7': 'planned' });
  });

  await t.test('jobs attach by issue, chosen by not cancelled, top-level, latest, id', () => {
    const g = graph(
      [issue(1), issue(2), issue(3)],
      [
        job('old', 1, 'running', { createdAt: '2026-01-01T00:00:00.000Z' }),
        job('new', 1, 'running', { createdAt: '2026-02-01T00:00:00.000Z' }),
        job('gone', 2, 'cancelled', { createdAt: '2026-03-01T00:00:00.000Z' }),
        job('kept', 2, 'done'),
        job('parent', 3, 'running'),
        job('child', 3, 'running', { parent: 'parent', createdAt: '2026-12-01T00:00:00.000Z' }),
        job('solo', 50, 'running'),
        job('none', null, 'running'),
      ],
    );
    assert.deepEqual(
      g.nodes.map((n) => [n.ref, n.job, n.title, n.wave]),
      [
        ['acme/web#1', 'new', 'Issue 1', null],
        ['acme/web#2', 'kept', 'Issue 2', null],
        ['acme/web#3', 'parent', 'Issue 3', null],
        ['acme/web#50', 'solo', 'Job solo', null],
      ],
    );
  });

  await t.test('edges, problems and cycles', () => {
    const issues = [
      issue(1, '', 1),
      issue(2, 'Depends on: #1, #99', 2),
      issue(3, 'Depends on: #1, '),
      issue(4, 'Depends on: #5'),
      issue(5, 'Depends on: #4'),
      issue(6, 'Depends on: #8'),
      issue(7, 'Depends on: #6'),
      issue(8, 'Depends on: #7'),
      issue(9, 'Depends on: #9'),
      issue(10, 'Depends on: #2'),
    ];
    const jobs = [
      job('j1', 1, 'done'),
      job('j2', 2, 'running', { dependsOn: ['j1', 'outside-job'] }),
      job('j10', 10, 'running', { dependsOn: ['j2', 'j1', 'bare'] }),
      job('bare', null, 'running'),
    ];
    const g = graph(issues, jobs);
    const e = (from: number, to: number, source: 'body' | 'job') => ({ from: `acme/web#${from}`, to: `acme/web#${to}`, source });
    assert.deepEqual(g.edges, [e(1, 2, 'body'), e(1, 10, 'job'), e(2, 10, 'body')], 'body edges kept, a job edge a body edge already joins dropped');
    assert.deepEqual(
      g.problems.map((p) => [p.kind, p.ref, p.detail, p.edges]),
      [
        ['malformed', 'acme/web#3', 'entry 2 of its Depends on: line is empty', []],
        ['outside', 'acme/web#2', 'depends on acme/web#99, which is not in this plan', []],
        ['unknown', 'acme/web#2', 'job j2 depends on outside-job, which is not a mandate job', []],
        ['unknown', 'acme/web#10', 'job j10 depends on bare, which carries no issue in this plan', []],
        ['cycle', null, '2 issues depend on each other in a cycle: acme/web#4, acme/web#5', [e(4, 5, 'body'), e(5, 4, 'body')]],
        ['cycle', null, '3 issues depend on each other in a cycle: acme/web#6, acme/web#7, acme/web#8', [e(6, 7, 'body'), e(7, 8, 'body'), e(8, 6, 'body')]],
        ['cycle', null, 'acme/web#9 depends on itself', [e(9, 9, 'body')]],
      ],
    );
    assert.deepEqual(stateOf(g), { '#1': 'merged', '#2': 'running', '#3': 'planned', '#4': 'planned', '#5': 'planned', '#6': 'planned', '#7': 'planned', '#8': 'planned', '#9': 'planned', '#10': 'running' });
    assert.deepEqual(
      g.nodes.map((n) => n.wave),
      [1, 2, null, null, null, null, null, null, null, null],
    );
  });
});
