// The stage list every job walks: it opens at backlog and closes at done, each stage once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STAGES } from './constants.ts';

test('STAGES runs from backlog to done with no stage twice', () => {
  assert.equal(STAGES[0], 'backlog');
  assert.equal(STAGES.at(-1), 'done');
  assert.equal(new Set(STAGES).size, STAGES.length);
});
