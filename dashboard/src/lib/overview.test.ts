// The Overview's model: cards sorted by what waits on you, and the stacked bars and legend of the cross-project graphs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OVERVIEW_WINDOWS, SERIES, overviewCards, stackedSeries } from './overview.ts';
import type { MachineProjectSummary, ProjectStatsSeries, ProjectsResponse, ProjectsStatsResponse } from './types.ts';

const latest = (at: string): MachineProjectSummary['latest'] => ({ id: `j-${at}`, title: `job of ${at}`, at, stage: 'build', state: 'running' });
const project = (name: string, over: Partial<MachineProjectSummary> = {}): MachineProjectSummary => ({
  name,
  path: `/src/${name}`,
  status: 'ok',
  loaded: true,
  jobs: { active: 1, waiting: 0 },
  latest: null,
  daemon: { enabled: true, wanted: true, foreman: true, office: 'idle', live: 0, maxConcurrent: 3 },
  ...over,
});
const response = (projects: MachineProjectSummary[]): ProjectsResponse => ({ error: null, machine: { maxConcurrent: 4, source: 'auto', live: 0, launchPermissionMode: null }, projects });
const unloaded = { loaded: false, jobs: null, latest: null, daemon: null } as const;

test('overviewCards sorts what waits first and missing last', () => {
  assert.deepEqual(overviewCards(null), []);
  const three = overviewCards(
    response([
      project('alpha', { latest: latest('2026-10-20T10:00:00.000Z') }),
      project('gone', { status: 'missing', ...unloaded }),
      project('gated', { jobs: { active: 1, waiting: 1 }, latest: latest('2026-10-01T10:00:00.000Z') }),
    ]),
  );
  assert.deepEqual(three.map((c) => [c.name, c.waiting]), [['gated', 1], ['alpha', 0], ['gone', 0]]);
  assert.equal(three[0]!.waitingHref, '#/p/gated/pipeline');
  assert.equal(three[1]!.waitingHref, null, 'no link at 0');
  assert.deepEqual([three[2]!.waitingHref, three[2]!.latest, three[2]!.foreman], [null, null, null], 'a missing card has no link, activity or foreman');

  const ties = overviewCards(
    response([
      project('zed', { status: 'missing', ...unloaded }),
      project('quiet'),
      project('beta', { latest: latest('2026-10-20T10:00:00.000Z') }),
      project('fresh', { status: 'not-initialized', ...unloaded }),
      project('newer', { latest: latest('2026-10-21T10:00:00.000Z') }),
      project('abel'),
      project('also', { latest: latest('2026-10-20T10:00:00.000Z') }),
    ]),
  );
  assert.deepEqual(
    ties.map((c) => c.name),
    ['newer', 'also', 'beta', 'abel', 'quiet', 'fresh', 'zed'],
    'newest activity first, none after, then name; unavailable before missing',
  );
  assert.deepEqual(ties.map((c) => c.state).slice(-2), ['unavailable', 'missing']);
});

test('overviewCards reads the Foreman', () => {
  const cards = overviewCards(
    response([
      project('a', { daemon: { enabled: true, wanted: true, foreman: false, office: 'off', live: 0, maxConcurrent: 2 } }),
      project('b', { daemon: { enabled: true, wanted: true, foreman: true, office: 'busy', live: 1, maxConcurrent: 2 } }),
      project('c', { daemon: { enabled: true, wanted: false, foreman: true, office: 'off', live: 0, maxConcurrent: 2 } }),
    ]),
  );
  assert.deepEqual(Object.fromEntries(cards.map((c) => [c.name, c.foreman])), { a: 'none', b: 'busy', c: 'off' });
});

const stats = (projects: Pick<ProjectStatsSeries, 'name' | 'shipped' | 'costUsd'>[], days = ['2026-10-18', '2026-10-19', '2026-10-20']): ProjectsStatsResponse => ({
  generatedAt: '2026-10-20T12:00:00.000Z',
  days,
  projects: projects.map((p) => ({ dayUsd: 0, monthUsd: 0, error: null, ...p })),
});

test('stackedSeries stacks each project and gives its share', () => {
  const r = stats([
    { name: 'web', shipped: [1, 0, 3], costUsd: [0.5, 0, 0] },
    { name: 'api', shipped: [1, 0, 1], costUsd: [0.25, 0, 0] },
  ]);
  const s = stackedSeries(r, 'shipped');
  assert.equal(s.max, 4);
  assert.deepEqual(s.columns.map((c) => [c.day, c.total]), [['2026-10-18', 2], ['2026-10-19', 0], ['2026-10-20', 4]]);
  assert.deepEqual(s.columns[1]!.segments, [], 'an empty day has no segment');
  const last = s.columns[2]!;
  assert.deepEqual(last.segments.map((g) => [g.project, g.value, g.series]), [['api', 1, 'series-1'], ['web', 3, 'series-2']], 'bottom-up in name order');
  assert.equal(last.segments.reduce((n, g) => n + g.h, 0), 100, 'the tallest day fills the chart');
  assert.equal(s.columns[0]!.segments.reduce((n, g) => n + g.h, 0), 50, "a day's height is its total over the max");
  assert.deepEqual(last.segments.map((g) => [g.y, g.h]), [[75, 25], [0, 75]], 'each segment sits on the one below');
  assert.deepEqual(s.legend, [
    { project: 'api', total: 2, share: 2 / 6, series: 'series-1', error: null },
    { project: 'web', total: 4, share: 4 / 6, series: 'series-2', error: null },
  ]);
  const cost = stackedSeries(r, 'costUsd');
  assert.deepEqual(cost.legend.map((l) => [l.project, l.series, l.total]), [['api', 'series-1', 0.25], ['web', 'series-2', 0.5]], 'the same colours in both graphs');

  const many = stats(Array.from({ length: 8 }, (_, i) => ({ name: `p${i}`, shipped: [0, 0, 0], costUsd: [0, 0, 0] })));
  const none = stackedSeries(many, 'shipped');
  assert.deepEqual(none.legend.map((l) => l.series), [...SERIES, 'series-1', 'series-2'], 'the classes cycle');
  assert.ok(none.legend.every((l) => l.share === null), 'no share when the total is 0');
  assert.equal(none.max, 0);
});

test('OVERVIEW_WINDOWS', () => {
  assert.deepEqual(OVERVIEW_WINDOWS.map(([v]) => v), ['7', '30', '90']);
});
