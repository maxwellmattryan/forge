// The stage list every job walks: it opens at backlog and closes at done, each stage once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ESCALATION_RULES, GATE_RULES, STAGES } from './constants.ts';

test('STAGES runs from backlog to done with no stage twice', () => {
  assert.equal(STAGES[0], 'backlog');
  assert.equal(STAGES.at(-1), 'done');
  assert.equal(new Set(STAGES).size, STAGES.length);
});

test('GATE_RULES are the escalation rules after approver, in the same order', () => {
  assert.equal(ESCALATION_RULES[0], 'approver');
  assert.deepEqual([...GATE_RULES], ESCALATION_RULES.slice(1));
});
