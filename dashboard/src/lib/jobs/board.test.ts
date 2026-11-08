// The Pipeline table's model: which optional columns show, the sort, the filter chips and the mandate groups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONAL_COLUMNS, filterChoices, filterTable, groupByMandate, nextSort, parseSort, sortByRank, sortPref, sortTable, tableColumns, tableRows } from './board.ts';
import type { OptionalColumn } from './board.ts';
import type { JobLike } from './state.ts';

type Row = JobLike & { budgeted?: boolean };
const hasBudget = (j: Row): boolean => j.budgeted === true;
const cols = (jobs: Row[]): OptionalColumn[] => [...tableColumns(jobs, hasBudget)].sort();
const ids = (jobs: JobLike[]): string[] => jobs.map((j) => String(j.id));
const usage = (totalTokens: number): JobLike['usage'] => ({ totalTokens }) as JobLike['usage'];

test('tableColumns shows a column only when a row fills it', () => {
  const blank: Row = { id: 'blank', title: 'Blank', progress: { done: 0, total: 0 }, reviewers: [], pr: null, usage: undefined, dependsOn: ['finished'], round: 0 };
  const finished: Row = { id: 'finished', state: 'done' };
  const fillers: [OptionalColumn, Row][] = [
    ['needs', { id: 'n', dependsOn: ['gone'] }],
    ['round', { id: 'r', round: 2 }],
    ['tasks', { id: 'a', progress: { done: 1, total: 3 } }],
    ['verdicts', { id: 'b', reviewers: ['code'] }],
    ['pr', { id: 'c', pr: { number: 12, url: 'https://example.test/pr/12' } as Row['pr'] }],
    ['tokens', { id: 'd', usage: { totalTokens: 0 } as Row['usage'] }],
    ['cost', { id: 'e', usage: { estCostUsd: 0.5 } as Row['usage'] }],
    ['budget', { id: 'f', budgeted: true }],
  ];
  for (const [col, job] of fillers) assert.deepEqual(cols([blank, job, blank, finished]), [col], `${col} shows when one row fills it`);
  assert.deepEqual([...tableColumns([blank], hasBudget, [blank, { id: 'finished', state: 'running' }])], ['needs'], 'needs resolves against all, not only the rows');

  assert.deepEqual(cols(fillers.map(([, j]) => j)), [...OPTIONAL_COLUMNS].sort(), 'every column when each has a row');
  assert.deepEqual(cols([blank, finished, { id: 'g', pr: { url: 'x' } as Row['pr'], reviewers: 'code' as unknown as string[], progress: { total: 'x' } as unknown as Row['progress'] }]), [], 'a PR without a number, a non-list reviewers and a non-numeric total fill nothing');
  assert.deepEqual(cols([]), [], 'no column for no rows');
});

test('nextSort cycles natural, reversed, then the urgency order', () => {
  const first = nextSort(null, 'tokens');
  assert.deepEqual(first, { col: 'tokens', dir: 'desc' }, "tokens' natural direction is descending");
  const second = nextSort(first, 'tokens');
  assert.deepEqual(second, { col: 'tokens', dir: 'asc' }, 'a second click reverses it');
  assert.equal(nextSort(second, 'tokens'), null, 'a third click returns to the urgency order');
  assert.deepEqual(nextSort(null, 'title'), { col: 'title', dir: 'asc' }, "title's natural direction is ascending");
  assert.deepEqual(nextSort({ col: 'tokens', dir: 'asc' }, 'title'), { col: 'title', dir: 'asc' }, 'another column restarts at its natural direction');
  assert.deepEqual(nextSort({ col: 'title', dir: 'asc' }, 'updated'), { col: 'updated', dir: 'desc' });
});

test('sortTable orders a column with missing values last', () => {
  // All running, newest first: the urgency order is a, b, c, d, e.
  const at = (n: number): string => `2026-11-0${n}T00:00:00Z`;
  const rows: JobLike[] = [
    { id: 'c', state: 'running', updatedAt: at(3) },
    { id: 'a', state: 'running', updatedAt: at(5), usage: usage(100) },
    { id: 'e', state: 'running', updatedAt: at(1), usage: { totalTokens: 'x' } as unknown as JobLike['usage'] },
    { id: 'd', state: 'running', updatedAt: at(2), usage: usage(300) },
    { id: 'b', state: 'running', updatedAt: at(4), usage: usage(300) },
  ];
  assert.deepEqual(ids(sortTable(rows, null, rows)), ids(sortByRank(rows)), 'null is the urgency order');
  assert.deepEqual(ids(sortTable(rows, null, rows)), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids(sortTable(rows, { col: 'tokens', dir: 'desc' }, rows)), ['b', 'd', 'a', 'c', 'e'], 'high to low, the tie in urgency order, no tokens last');
  assert.deepEqual(ids(sortTable(rows, { col: 'tokens', dir: 'asc' }, rows)), ['a', 'b', 'd', 'c', 'e'], 'low to high, no tokens still last');

  const staged: JobLike[] = ['review', 'weird', 'done', 'backlog', 'plan'].map((stage) => ({ id: stage, stage: stage as JobLike['stage'], state: 'running' }));
  assert.deepEqual(ids(sortTable(staged, { col: 'stage', dir: 'asc' }, staged)), ['backlog', 'plan', 'review', 'done', 'weird'], 'pipeline order, an unknown stage last');
  assert.deepEqual(ids(sortTable(staged, { col: 'stage', dir: 'desc' }, staged)), ['done', 'review', 'plan', 'backlog', 'weird']);

  const refs: JobLike[] = [
    { id: 'ten', state: 'running', issues: [{ ref: '10' }] as JobLike['issues'] },
    { id: 'nine', state: 'running', issues: [{ ref: '9' }] as JobLike['issues'] },
  ];
  assert.deepEqual(ids(sortTable(refs, { col: 'job', dir: 'asc' }, refs)), ['nine', 'ten'], '#9 before #10');
});

test('parseSort reads only a known column and direction', () => {
  const sort = parseSort('tokens:desc');
  assert.deepEqual(sort, { col: 'tokens', dir: 'desc' });
  assert.equal(sortPref(sort), 'tokens:desc');
  assert.deepEqual(parseSort(sortPref({ col: 'title', dir: 'asc' })), { col: 'title', dir: 'asc' });
  assert.equal(sortPref(null), '');
  for (const raw of ['', 'nope:asc', 'tokens:sideways', 'verdicts:asc', 'tokens', 'tokens:desc:x']) assert.equal(parseSort(raw), null, raw);
});

test('filterTable ANDs fields, ORs values and searches ref, id and title', () => {
  const rows: JobLike[] = [
    { id: 'x-open', title: 'Retry Policy', mandate: 'm-x', state: 'running', stage: 'build', issues: [{ ref: '42' }] as JobLike['issues'] },
    { id: 'x-done', title: 'Shipped', mandate: 'm-x', state: 'done', stage: 'done' },
    { id: 'y-open', title: 'Other', mandate: 'm-y', state: 'waiting', stage: 'spec' },
    { id: 'none-open', title: 'Loose', state: 'blocked', stage: 'build' },
  ];
  const mandate = { field: 'mandate', value: 'm-x' } as const;
  const open = { field: 'state', value: 'open' } as const;
  assert.deepEqual(ids(filterTable(rows, [mandate, open], '')), ['x-open'], 'mandate AND open');
  assert.deepEqual(ids(filterTable(rows, [open], '')), ['x-open', 'y-open', 'none-open'], 'dropping the mandate chip returns every open job');
  assert.deepEqual(ids(filterTable(rows, [mandate, { field: 'mandate', value: 'm-y' }], '')), ['x-open', 'x-done', 'y-open'], 'two chips of one field match either');
  assert.deepEqual(ids(filterTable(rows, [{ field: 'mandate', value: '' }], '')), ['none-open'], "'' is No mandate");
  assert.deepEqual(ids(filterTable(rows, [{ field: 'stage', value: 'build' }, { field: 'state', value: 'blocked' }], '')), ['none-open']);
  assert.deepEqual(ids(filterTable(rows, [], '  retry POLICY ')), ['x-open'], 'title, case-insensitive, trimmed');
  assert.deepEqual(ids(filterTable(rows, [], '#42')), ['x-open'], 'the ref');
  assert.deepEqual(ids(filterTable(rows, [], 'Y-OPEN')), ['y-open'], 'the id');
  assert.deepEqual(ids(filterTable(rows, [], '   ')), ids(rows), 'an empty box matches everything');
});

test('filterChoices offers present values not already chosen', () => {
  const rows: JobLike[] = [
    { id: 'a', mandate: 'm-b', state: 'failed', stage: 'review' },
    // A hand-edited state word the dashboard has no name for.
    { id: 'b', state: 'zany' as JobLike['state'], stage: 'plan' },
    { id: 'c', mandate: 'm-a', state: 'running', stage: 'review' },
    { id: 'd', mandate: 'm-b', state: 'done', stage: 'done' },
    { id: 'e', mandate: 'none', state: 'queued', stage: 'backlog' },
  ];
  const all = filterChoices(rows, []).map((c) => `${c.field}:${c.value}`);
  assert.deepEqual(all, [
    'mandate:m-b', 'mandate:m-a', 'mandate:',
    'state:open', 'state:running', 'state:failed', 'state:done', 'state:queued', 'state:zany',
    'stage:backlog', 'stage:plan', 'stage:review', 'stage:done',
  ]);
  const left = filterChoices(rows, [{ field: 'mandate', value: 'm-a' }, { field: 'state', value: 'open' }, { field: 'stage', value: 'done' }]).map((c) => `${c.field}:${c.value}`);
  assert.deepEqual(left, ['mandate:m-b', 'mandate:', 'state:running', 'state:failed', 'state:done', 'state:queued', 'state:zany', 'stage:backlog', 'stage:plan', 'stage:review'], 'chosen values are left out');
  assert.deepEqual(filterChoices([{ id: 'z', mandate: 'm-a', state: 'done', stage: 'done' }], []).map((c) => c.value), ['m-a', 'done', 'done'], 'no open and no No mandate when none is present');
});

test('groupByMandate orders groups and counts merged; a collapsed group keeps its header', () => {
  const rows: JobLike[] = [
    { id: '1', state: 'running' },
    { id: '2', mandate: 'm-b', state: 'waiting', pr: { number: 3, state: 'MERGED' } as JobLike['pr'] },
    { id: '3', mandate: 'm-a', state: 'running' },
    { id: '4', mandate: 'm-b', state: 'done' },
    { id: '5', mandate: 'm-b', state: 'running', pr: { number: 4, state: 'OPEN' } as JobLike['pr'] },
    { id: '6', mandate: 'Not An Id', state: 'done' },
  ];
  const groups = groupByMandate(rows);
  assert.deepEqual(
    groups.map((g) => [g.mandate, ids(g.jobs), g.merged]),
    [
      ['m-b', ['2', '4', '5'], 2],
      ['m-a', ['3'], 0],
      [null, ['1', '6'], 1],
    ],
    'by first row, No mandate last, an invalid id under No mandate',
  );
  const kinds = (collapsed: Set<string>) => tableRows(groups, collapsed).map((r) => (r.kind === 'group' ? `g:${r.group.mandate ?? ''}:${r.open}:${r.group.jobs.length}/${r.group.merged}` : r.job.id));
  assert.deepEqual(kinds(new Set()), ['g:m-b:true:3/2', '2', '4', '5', 'g:m-a:true:1/0', '3', 'g::true:2/1', '1', '6']);
  assert.deepEqual(kinds(new Set(['m-b', ''])), ['g:m-b:false:3/2', 'g:m-a:true:1/0', '3', 'g::false:2/1'], 'collapsed groups keep their headers and counts');
  assert.deepEqual(groupByMandate([]), []);
});
