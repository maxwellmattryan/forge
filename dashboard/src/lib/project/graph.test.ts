// The Project page's job picker: which components a job highlights, where the list came from, and why
// an unmatched job's list is empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { componentsView, jobOptions } from './graph.ts';
import type { ComponentsView } from './graph.ts';
import type { StateJob } from '../core/types.ts';

type Fields = Pick<StateJob, 'stage' | 'components' | 'componentsDeclared' | 'componentsFromDiff'>;

test('componentsView picks the list, its source and the empty reason', () => {
  const rows: [string, Fields, ComponentsView][] = [
    ['a recompute', { stage: 'review', components: ['cli'], componentsDeclared: ['dashboard'], componentsFromDiff: ['cli'] }, { components: ['cli'], source: 'diff', reason: 'no-match' }],
    ['an empty recompute', { stage: 'build', components: [], componentsDeclared: ['cli'], componentsFromDiff: [] }, { components: [], source: 'diff', reason: 'no-match' }],
    ['a declared list', { stage: 'build', components: ['cli'], componentsDeclared: ['cli'], componentsFromDiff: null }, { components: ['cli'], source: 'declared', reason: 'spec-none' }],
    ...(['backlog', 'plan', 'spec', 'design'] as const).map((stage): [string, Fields, ComponentsView] => [
      `no spec yet in ${stage}`,
      { stage, components: [], componentsDeclared: null, componentsFromDiff: null },
      { components: [], source: 'declared', reason: 'no-spec' },
    ]),
    ['a spec that named none', { stage: 'spec', components: [], componentsDeclared: [], componentsFromDiff: null }, { components: [], source: 'declared', reason: 'spec-none' }],
    ['a migrated job past spec', { stage: 'build', components: [], componentsDeclared: null, componentsFromDiff: null }, { components: [], source: 'declared', reason: 'spec-none' }],
  ];
  for (const [name, job, want] of rows) assert.deepEqual(componentsView(job), want, name);
});

test('jobOptions lists unfinished jobs by id with their components view', () => {
  const job = (id: string, state: StateJob['state'], fields: Partial<Fields> = {}) =>
    ({ id, title: `T ${id}`, state, stage: 'build', components: [], componentsDeclared: null, componentsFromDiff: null, ...fields }) as Pick<StateJob, 'id' | 'title' | 'state'> & Fields;
  const options = jobOptions([job('b', 'running', { components: ['cli'], componentsFromDiff: ['cli'] }), job('a', 'queued'), job('c', 'done')]);
  assert.deepEqual(options, [
    { id: 'a', label: 'a · T a', components: [], source: 'declared', reason: 'spec-none' },
    { id: 'b', label: 'b · T b', components: ['cli'], source: 'diff', reason: 'no-match' },
  ]);
});
