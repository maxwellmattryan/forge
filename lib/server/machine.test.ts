// The Overview's per-project job counts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { projectJobCounts } from './machine.ts';
import type { Job } from '#core/types.ts';

test("the project summary's waiting count leaves shelved jobs out", () => {
  const jobs: Pick<Job, 'state' | 'waitingOn'>[] = [
    { state: 'waiting', waitingOn: 'escalation' },
    { state: 'waiting', waitingOn: 'shelved' },
    { state: 'waiting', waitingOn: 'external' },
    { state: 'running', waitingOn: null },
    { state: 'done', waitingOn: null },
  ];
  assert.deepEqual(projectJobCounts(jobs), { active: 4, waiting: 1 });
});
