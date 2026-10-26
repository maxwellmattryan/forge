import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { defaults } from '../keys/defaults.ts';
import { validateConfig } from '../validate.ts';

test('commandEnv validation', () => {
  assert.deepEqual(defaults().commandEnv, { inherit: [], loginShell: false });
  const rows: [string, unknown, RegExp | null][] = [
    ['the defaults', { inherit: [], loginShell: false }, null],
    ['names, globs and parentheses', { inherit: ['JAVA_*', 'DATABASE_URL', 'ProgramFiles(x86)'], loginShell: true }, null],
    ['only inherit', { inherit: ['JAVA_HOME'] }, null],
    ['a bare *', { inherit: ['*'] }, /^commandEnv\.inherit entry "\*" would pass the whole environment; name the variables \(globs such as JAVA_\* are fine\)$/],
    ['a **', { inherit: ['**'] }, /^commandEnv\.inherit entry "\*\*" would pass the whole environment/],
    ['an empty entry', { inherit: [''] }, /^commandEnv\.inherit entry "" must be a variable name/],
    ['a space', { inherit: ['A B'] }, /^commandEnv\.inherit entry "A B" must be a variable name/],
    ['a $', { inherit: ['$X'] }, /^commandEnv\.inherit entry "\$X" must be a variable name/],
    ['a number', { inherit: [1] }, /^commandEnv\.inherit entries must be strings \(got 1\)$/],
    ['inherit not a list', { inherit: 'JAVA_*' }, /^commandEnv\.inherit must be a list of variable names/],
    ['loginShell not a boolean', { loginShell: 'yes' }, /^commandEnv\.loginShell must be true or false \(got "yes"\)$/],
    ['commandEnv a list', [], /^commandEnv must be a map with inherit and loginShell/],
  ];
  for (const [name, value, want] of rows) {
    const c: any = defaults();
    c.commandEnv = value;
    const problems = validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('commandEnv'));
    if (want === null) assert.deepEqual(problems, [], name);
    else {
      assert.equal(problems.length, 1, `${name}: ${JSON.stringify(problems)}`);
      assert.match(problems[0], want, name);
    }
  }
});
