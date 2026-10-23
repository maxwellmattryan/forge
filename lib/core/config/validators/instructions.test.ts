import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { INSTRUCTION_ROLES, instructionsFor, instructionsProblems } from './instructions.ts';
import { defaults } from '../keys/defaults.ts';
import { validateConfig } from '../validate.ts';
import { CONFIG_STEPS } from '../../versions/config.ts';

const cfg = (instructions: unknown) => ({ project: { instructions } }) as any;

test("instructionsFor picks each role's files", () => {
  const map = { default: ['AGENTS.md'], builder: ['AGENTS.md', 'docs/DEVELOPING.md'], reviewer: ['REVIEW.md'], approver: [] };
  const rows: [string, unknown, string | undefined, string[]][] = [
    ['a named role gets its own list', map, 'builder', ['AGENTS.md', 'docs/DEVELOPING.md']],
    ['a role list replaces default, never adds to it', map, 'reviewer', ['REVIEW.md']],
    ['reviewer:<lens> resolves as reviewer', map, 'reviewer:security', ['REVIEW.md']],
    ['a role mapped to [] gets none', map, 'approver', []],
    ['an unnamed role gets default', map, 'planner', ['AGENTS.md']],
    ['no role gets default', map, undefined, ['AGENTS.md']],
    ['a role outside INSTRUCTION_ROLES gets default', { ...map, retro: ['X.md'] }, 'retro', ['AGENTS.md']],
    ['a map without default gives unnamed roles none', { builder: ['B.md'] }, 'planner', []],
    ['a plain list is every role\'s', ['AGENTS.md', 'CLAUDE.md'], 'judge', ['AGENTS.md', 'CLAUDE.md']],
    ['a plain list with no role', ['AGENTS.md'], undefined, ['AGENTS.md']],
    ['bad entries are dropped', ['AGENTS.md', '', '  ', 7, null, '/etc/passwd', 'C:\\x.md', '../up.md', 'a/../../b.md', 'docs/X.md'], 'builder', ['AGENTS.md', 'docs/X.md']],
    ['bad entries in a role list are dropped', { default: ['A.md'], builder: ['/abs.md', 'B.md'] }, 'builder', ['B.md']],
    ['a role value that is not a list falls back to default', { default: ['A.md'], builder: 'B.md' }, 'builder', ['A.md']],
    ['neither a list nor a map', 'AGENTS.md', 'builder', []],
    ['no key at all', undefined, 'builder', []],
  ];
  for (const [name, value, role, want] of rows) assert.deepEqual(instructionsFor(cfg(value), role), want, name);
  // defaults() and deepMerge: a user map naming only builder keeps default for every other role.
  assert.deepEqual(instructionsFor(defaults(), 'spec-writer'), ['AGENTS.md', 'CLAUDE.md']);
  assert.ok(INSTRUCTION_ROLES.includes('reviewer'));
});

test('instructionsProblems', () => {
  const rows: [string, unknown, RegExp | null][] = [
    ['a list', ['AGENTS.md', 'docs/DEVELOPING.md'], null],
    ['a valid map', { default: ['AGENTS.md'], 'spec-writer': ['AGENTS.md', 'docs/DEVELOPING.md'], approver: [] }, null],
    ['no key', undefined, null],
    ['an unknown role key', { default: [], builer: ['A.md'] }, /^project\.instructions\.builer is not a role: use default, planner, spec-writer, designer, builder, reviewer, approver, integrator, verifier, judge$/],
    ['a value that is not a list', { builder: 'A.md' }, /^project\.instructions\.builder must be a list of files/],
    ['a non-string entry', { default: [7] }, /^project\.instructions\.default\[0\] must be a non-empty string/],
    ['an empty entry', ['AGENTS.md', ' '], /^project\.instructions\[1\] must be a non-empty string/],
    ['an absolute path', ['/etc/passwd'], /^project\.instructions\[0\] must be a path relative to the repo root/],
    ['a drive path', { reviewer: ['C:\\x.md'] }, /^project\.instructions\.reviewer\[0\] must be a path relative to the repo root/],
    ['a .. segment', ['docs/../../x.md'], /^project\.instructions\[0\] must not contain a \.\. segment/],
    ['neither a list nor a map', 'AGENTS.md', /^project\.instructions must be a list of files or a map of role lists/],
  ];
  for (const [name, value, want] of rows) {
    const problems = instructionsProblems(cfg(value));
    if (want === null) assert.deepEqual(problems, [], name);
    else {
      assert.equal(problems.length, 1, `${name}: ${JSON.stringify(problems)}`);
      assert.match(problems[0], want, name);
    }
  }
  // validateConfig reports them.
  const c: any = defaults();
  c.project.instructions = { default: ['AGENTS.md'], builer: [] };
  assert.deepEqual(validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('project.instructions')).length, 1);
});

test('the instructions-per-role step leaves a config without a list alone', () => {
  const step = CONFIG_STEPS.find((s) => s.id === 'instructions-per-role')!;
  const map = { project: { instructions: { default: ['A.md'], builder: [] } } };
  assert.deepEqual(step.up(structuredClone(map)), map);
  assert.deepEqual(step.up({ git: { base: 'main' } }), { git: { base: 'main' } });
  assert.deepEqual(step.up({ project: { name: 'x' } }), { project: { name: 'x' } });
});
