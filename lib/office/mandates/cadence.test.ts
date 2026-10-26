// When the pool runs the Office pass: when asked, or a cadence after the last one; after a mandate job
// settles; and when a mandate file is added or rewritten.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo } from '../../../test/helpers.ts';
import { cadenceMs, mandatesPrint, passDue, passWantedAfter } from './cadence.ts';
import type { Config, Job } from '#core/types.ts';

const MIN = 60_000;
const foreman = (cadence: unknown) => ({ foreman: { cadence } }) as unknown as Pick<Config, 'foreman'>;

test('when the Office pass is due', () => {
  const due: [string, Parameters<typeof passDue>[0], boolean][] = [
    ['wanted', { now: 1000, last: 1000, cadenceMs: 10 * MIN, wanted: true }, true],
    ['a cadence gone by', { now: 10 * MIN, last: 0, cadenceMs: 10 * MIN, wanted: false }, true],
    ['inside the cadence', { now: 10 * MIN - 1, last: 0, cadenceMs: 10 * MIN, wanted: false }, false],
  ];
  for (const [name, o, want] of due) assert.equal(passDue(o), want, name);

  const cadences: [unknown, number][] = [
    [5, 5 * MIN],
    [0, 10 * MIN],
    ['x', 10 * MIN],
    [1441, 10 * MIN],
    [undefined, 10 * MIN],
  ];
  for (const [c, want] of cadences) assert.equal(cadenceMs(foreman(c)), want, `cadence ${String(c)}`);

  const after: [string, Pick<Job, 'mandate' | 'state'> | null, boolean][] = [
    ['done in a mandate', { mandate: 'm1', state: 'done' }, true],
    ['cancelled in a mandate', { mandate: 'm1', state: 'cancelled' }, true],
    ['failed in a mandate', { mandate: 'm1', state: 'failed' }, true],
    ['waiting in a mandate', { mandate: 'm1', state: 'waiting' }, true],
    ['running in a mandate', { mandate: 'm1', state: 'running' }, false],
    ['done in no mandate', { mandate: null, state: 'done' }, false],
    ['no job', null, false],
  ];
  for (const [name, job, want] of after) assert.equal(passWantedAfter(job), want, name);

  const repo = tempRepo();
  try {
    const dir = path.join(repo.dir, '.forge', 'runtime', 'mandates');
    const before = mandatesPrint(repo.dir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'm1.md'), '---\n---\n');
    const added = mandatesPrint(repo.dir);
    assert.notEqual(added, before, 'a mandate added');
    fs.writeFileSync(path.join(dir, 'm1.md'), '---\ntitle: longer\n---\n');
    assert.notEqual(mandatesPrint(repo.dir), added, 'a mandate rewritten');
    const rewritten = mandatesPrint(repo.dir);
    fs.mkdirSync(path.join(dir, 'm1'));
    fs.writeFileSync(path.join(dir, 'm1', 'board.md'), 'board');
    assert.equal(mandatesPrint(repo.dir), rewritten, "a mandate's runtime files are not mandates");
  } finally {
    repo.cleanup();
  }
});
