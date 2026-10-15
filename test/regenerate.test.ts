import test from 'node:test';
import assert from 'node:assert/strict';
import { tempRepo } from './helpers.ts';
import { defaults, validateConfig } from '../lib/config.ts';

test('validateConfig checks worktrees.generated and generatedBy', () => {
  const repo = tempRepo();
  try {
    const problems = (generated: unknown[], generatedBy = 'build', commands: Record<string, string | null> = { build: 'node gen.mjs' }) => {
      const c: any = defaults();
      Object.assign(c.commands, commands);
      c.worktrees.generated = generated;
      c.worktrees.generatedBy = generatedBy;
      return validateConfig(c, repo.dir).filter((p) => p.startsWith('worktrees.'));
    };
    assert.deepEqual(validateConfig(defaults(), repo.dir), [], 'the defaults produce no problem');
    assert.deepEqual(problems(['dist/**', 'dashboard/dist/', '*.min.js']), []);
    for (const bad of ['', '  ', 3, null, '/abs/dist/**', '-rf', '!dist/**', ':(top)dist', '../x/**', 'dist/../../x', 'a\\..\\b']) {
      assert.equal(problems([bad]).length, 1, `${JSON.stringify(bad)} is refused`);
    }
    assert.match(problems(['dist/**'], 'nope')[0], /generatedBy must name a configured command/);
    assert.match(problems(['dist/**'], 'build', { build: null })[0], /generatedBy/, 'an unset command is not configured');
    assert.match(problems(['dist/**'], 'toString', {})[0], /generatedBy/, 'an inherited property is not a command');
    assert.deepEqual(problems([], 'nope'), [], 'generatedBy is only checked when generated is set');
    const c: any = defaults();
    c.worktrees.generated = 'dist/**';
    assert.match(validateConfig(c, repo.dir).join('\n'), /worktrees\.generated must be a list/);
  } finally {
    repo.cleanup();
  }
});
