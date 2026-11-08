// tableColumns: which optional Pipeline table columns show for a list of jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OPTIONAL_COLUMNS, tableColumns } from './board.ts';
import type { OptionalColumn } from './board.ts';
import type { JobLike } from './state.ts';

type Row = JobLike & { budgeted?: boolean };
const hasBudget = (j: Row): boolean => j.budgeted === true;
const cols = (jobs: Row[]): OptionalColumn[] => [...tableColumns(jobs, hasBudget)].sort();

test('tableColumns shows a column only when a row fills it', () => {
  const blank: Row = { id: 'blank', title: 'Blank', progress: { done: 0, total: 0 }, reviewers: [], pr: null, usage: undefined };
  const fillers: [OptionalColumn, Row][] = [
    ['tasks', { id: 'a', progress: { done: 1, total: 3 } }],
    ['verdicts', { id: 'b', reviewers: ['code'] }],
    ['pr', { id: 'c', pr: { number: 12, url: 'https://example.test/pr/12' } as Row['pr'] }],
    ['tokens', { id: 'd', usage: { totalTokens: 0 } as Row['usage'] }],
    ['cost', { id: 'e', usage: { estCostUsd: 0.5 } as Row['usage'] }],
    ['budget', { id: 'f', budgeted: true }],
  ];
  for (const [col, job] of fillers) assert.deepEqual(cols([blank, job, blank]), [col], `${col} shows when one row fills it`);

  assert.deepEqual(cols(fillers.map(([, j]) => j)), [...OPTIONAL_COLUMNS].sort(), 'every column when each has a row');
  assert.deepEqual(cols([blank, { id: 'g', pr: { url: 'x' } as Row['pr'], reviewers: 'code' as unknown as string[], progress: { total: 'x' } as unknown as Row['progress'] }]), [], 'a PR without a number, a non-list reviewers and a non-numeric total fill nothing');
  assert.deepEqual(cols([]), [], 'no column for no rows');
});
