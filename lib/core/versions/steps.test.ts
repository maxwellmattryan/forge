import test from 'node:test';
import assert from 'node:assert/strict';
import { runSteps, stepProblems, versionOf } from './steps.ts';
import type { Step } from './steps.ts';
import { CONFIG_SCHEMA_VERSION, CONFIG_STEPS } from './config.ts';

test('stepProblems', () => {
  const rows: [string, { id: string }[], string[]][] = [
    ['valid', [{ id: 'one' }, { id: 'two-2' }, { id: 'a1-b2-c3' }], []],
    ['duplicate', [{ id: 'one' }, { id: 'two' }, { id: 'one' }], ['duplicate id `one` at 2']],
    ['not kebab-case', [{ id: 'Bad_Id' }], ['id `Bad_Id` at 0 is not kebab-case of at most 60 characters']],
    ['empty id', [{ id: 'ok' }, { id: '' }], ['id `` at 1 is not kebab-case of at most 60 characters']],
    ['61 characters', [{ id: `a${'-b'.repeat(30)}` }], [`id \`a${'-b'.repeat(30)}\` at 0 is not kebab-case of at most 60 characters`]],
  ];
  for (const [name, list, want] of rows) assert.deepEqual(stepProblems(list), want, name);
  assert.equal(`a${'-b'.repeat(30)}`.length, 61);
  assert.deepEqual(stepProblems([{ id: `a${'b'.repeat(59)}` }]), [], '60 characters is allowed');
});

test('two appended steps merge in either order', () => {
  const tagged = (id: string, tag: string): Step => ({ id, up: (c) => ({ ...c, trail: [...(c.trail ?? []), tag] }) });
  const L = tagged('left-step', 'left');
  const R = tagged('right-step', 'right');
  for (const [first, second] of [
    [L, R],
    [R, L],
  ]) {
    const merged = [...CONFIG_STEPS, first, second];
    const tag = (s: Step) => (s === L ? 'left' : 'right');
    assert.deepEqual(stepProblems(merged), [], 'a merge that keeps both is valid');
    assert.equal(versionOf(merged), CONFIG_SCHEMA_VERSION + 2);
    // Each step applies to the previous one's output, in list order.
    assert.deepEqual(runSteps(merged, { schemaVersion: CONFIG_SCHEMA_VERSION }, CONFIG_SCHEMA_VERSION).trail, [tag(first), tag(second)]);
    assert.deepEqual(runSteps(merged, { schemaVersion: CONFIG_SCHEMA_VERSION + 1 }, CONFIG_SCHEMA_VERSION + 1).trail, [tag(second)], 'from the middle version, only the second');
    assert.deepEqual(stepProblems([...CONFIG_STEPS, first, { ...second, id: first.id }]), [`duplicate id \`${first.id}\` at ${CONFIG_STEPS.length + 1}`], 'both sides picked the same id');
  }
});
