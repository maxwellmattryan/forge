// The pipeline table's sort and filter (dashboard/src/lib/jobs-table.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DIR, SORT_KEYS, filterByText, nextSort, sortJobs } from '../dashboard/src/lib/jobs-table.ts';
import { sortByRank } from '../dashboard/src/lib/view.ts';

// Urgency order: fail (rank 0), run (1), then the queued ones newest first, then done.
const JOBS: any[] = [
  { id: 'q-old', title: 'beta', stage: 'build', state: 'queued', updatedAt: '2026-10-13T00:00:00Z', usage: { totalTokens: 300, estCostUsd: 0.3 } },
  { id: 'done', title: 'Alpha', stage: 'done', state: 'done', updatedAt: '2026-10-15T00:00:00Z', usage: { totalTokens: 900, estCostUsd: 2 } },
  { id: 'run', title: 'gamma', stage: 'spec', state: 'running', updatedAt: '2026-10-12T00:00:00Z', usage: { totalTokens: 100, estCostUsd: 0.1 } },
  { id: 'fail', title: 'Delta', stage: 'verify', state: 'failed', updatedAt: '2026-10-11T00:00:00Z', usage: { totalTokens: 500, estCostUsd: 0.5 } },
  { id: 'q-new', title: 'epsilon', stage: 'plan', state: 'queued', updatedAt: '2026-10-14T00:00:00Z', usage: { totalTokens: 200, estCostUsd: 0.2 } },
];
const ids = (js: any[]) => js.map((j) => j.id);

test('sortJobs: null is the urgency order', () => {
  assert.deepEqual(ids(sortJobs(JOBS, null)), ids(sortByRank(JOBS)));
  assert.deepEqual(ids(sortJobs(JOBS, null)), ['fail', 'run', 'q-new', 'q-old', 'done']);
});

test('sortJobs: each key in both directions', () => {
  const asc: Record<string, string[]> = {
    title: ['done', 'q-old', 'fail', 'q-new', 'run'],
    stage: ['q-new', 'run', 'q-old', 'fail', 'done'],
    state: ['q-new', 'q-old', 'run', 'fail', 'done'],
    tokens: ['run', 'q-new', 'q-old', 'fail', 'done'],
    cost: ['run', 'q-new', 'q-old', 'fail', 'done'],
    updated: ['fail', 'run', 'q-old', 'q-new', 'done'],
  };
  // The two queued jobs tie on state, so they keep their urgency order (q-new first) in both directions.
  const desc: Record<string, string[]> = { ...Object.fromEntries(Object.entries(asc).map(([k, v]) => [k, [...v].reverse()])), state: ['done', 'fail', 'run', 'q-new', 'q-old'] };
  for (const key of SORT_KEYS) {
    assert.deepEqual(ids(sortJobs(JOBS, { key, dir: 'asc' })), asc[key], `${key} asc`);
    assert.deepEqual(ids(sortJobs(JOBS, { key, dir: 'desc' })), desc[key], `${key} desc`);
  }
  const before = ids(JOBS);
  sortJobs(JOBS, { key: 'title', dir: 'asc' });
  assert.deepEqual(ids(JOBS), before, 'the input keeps its order');
});

test('sortJobs: missing values sort last either way', () => {
  const jobs: any[] = [
    // No title, an unknown stage and state, an unparsable date, no usage.
    { id: 'none', state: 'mystery', stage: 'mystery', updatedAt: 'not a date' },
    { id: 'odd', state: 'queued', stage: 'build', title: 'b', updatedAt: '2026-10-14T00:00:00Z', usage: { totalTokens: 5, estCostUsd: 1 } },
    { id: 'ok', state: 'running', stage: 'plan', title: 'a', updatedAt: '2026-10-13T00:00:00Z', usage: { totalTokens: 9, estCostUsd: 2 } },
    // Usage present but its numbers missing.
    { id: 'empty-usage', state: 'running', stage: 'plan', title: 'c', updatedAt: '2026-10-12T00:00:00Z', usage: {} },
  ];
  for (const key of SORT_KEYS) {
    for (const dir of ['asc', 'desc'] as const) {
      const out = ids(sortJobs(jobs, { key, dir }));
      assert.equal(out[out.length - 1], 'none', `${key} ${dir}: the job with no value is last`);
    }
  }
  assert.deepEqual(ids(sortJobs(jobs, { key: 'tokens', dir: 'desc' })), ['ok', 'odd', 'empty-usage', 'none'], 'empty usage sorts with the missing, in urgency order');
  assert.deepEqual(ids(sortJobs(jobs, { key: 'tokens', dir: 'asc' })), ['odd', 'ok', 'empty-usage', 'none']);
});

test('sortJobs: ties keep urgency order', () => {
  const jobs: any[] = [
    { id: 'q', title: 'Same', stage: 'build', state: 'queued', updatedAt: '2026-10-14T00:00:00Z' },
    { id: 'r', title: 'same', stage: 'build', state: 'running', updatedAt: '2026-10-10T00:00:00Z' },
    { id: 'f', title: 'SAME', stage: 'build', state: 'failed', updatedAt: '2026-10-12T00:00:00Z' },
  ];
  const urgency = ids(sortByRank(jobs));
  assert.deepEqual(urgency, ['f', 'r', 'q']);
  for (const dir of ['asc', 'desc'] as const) {
    assert.deepEqual(ids(sortJobs(jobs, { key: 'title', dir })), urgency, `title ${dir}: case-insensitive tie`);
    assert.deepEqual(ids(sortJobs(jobs, { key: 'stage', dir })), urgency, `stage ${dir}`);
  }
});

test('nextSort cycles default, reversed, none', () => {
  for (const key of SORT_KEYS) {
    const first = nextSort(null, key);
    assert.deepEqual(first, { key, dir: DEFAULT_DIR[key] }, `${key}: first click`);
    const second = nextSort(first, key);
    assert.deepEqual(second, { key, dir: DEFAULT_DIR[key] === 'asc' ? 'desc' : 'asc' }, `${key}: second click`);
    assert.equal(nextSort(second, key), null, `${key}: third click`);
  }
  assert.deepEqual(DEFAULT_DIR, { title: 'asc', stage: 'asc', state: 'asc', tokens: 'desc', cost: 'desc', updated: 'desc' });
  assert.deepEqual(nextSort({ key: 'cost', dir: 'asc' }, 'title'), { key: 'title', dir: 'asc' }, 'another header starts over');
});

test('filterByText matches title or id, case-insensitive', () => {
  assert.deepEqual(ids(filterByText(JOBS, 'ALPHA')), ['done'], 'title');
  assert.deepEqual(ids(filterByText(JOBS, 'q-')), ['q-old', 'q-new'], 'id fragment, input order kept');
  assert.deepEqual(ids(filterByText(JOBS, '  Delta  ')), ['fail'], 'surrounding spaces ignored');
  assert.deepEqual(filterByText(JOBS, 'zzz'), [], 'no match');
  assert.deepEqual(ids(filterByText([{ id: 'x' }, { title: 'X-ray' }] as any[], 'x')), ['x', undefined], 'a missing title or id never throws');
});

test('filterByText: blank query keeps every job', () => {
  assert.equal(filterByText(JOBS, ''), JOBS);
  assert.equal(filterByText(JOBS, '   '), JOBS);
});
