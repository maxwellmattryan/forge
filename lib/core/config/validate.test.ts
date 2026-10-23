// validateConfig's checks for sections that have no validator file of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { validateConfig } from './validate.ts';
import { defaults } from './keys/defaults.ts';

const seedProblems = (seed: unknown): string[] => {
  const c: any = defaults();
  c.worktrees.seed = seed;
  return validateConfig(c, os.tmpdir()).filter((p) => p.startsWith('worktrees.seed'));
};

const block = (over: Record<string, unknown> = {}) => ({ paths: ['node_modules'], key: ['package-lock.json'], setup: ['npm ls'], warm: [], ...over });

test('worktrees.seed problems', () => {
  const rows: [string, unknown, RegExp | null][] = [
    ['not a map', ['node_modules'], /^worktrees\.seed must be a map/],
    ['paths not a list', block({ paths: 'node_modules' }), /^worktrees\.seed\.paths must be a list/],
    ['an absolute path', block({ paths: ['/abs'] }), /^worktrees\.seed\.paths\[0\] must be a relative path/],
    ['a leading -', block({ paths: ['-x'] }), /^worktrees\.seed\.paths\[0\] must be a relative path/],
    ['a .. segment', block({ paths: ['a/../b'] }), /^worktrees\.seed\.paths\[0\] must have no empty, \. or \.\. segment/],
    ['inside .git', block({ paths: ['.git/x'] }), /^worktrees\.seed\.paths\[0\] must not be inside \.git/],
    ['a glob', block({ paths: ['a*'] }), /^worktrees\.seed\.paths\[0\] must be a relative path/],
    ['a duplicate', block({ paths: ['a', 'a'] }), /^worktrees\.seed\.paths lists "a" more than once/],
    ['a nested path', block({ paths: ['a', 'a/b'] }), /^worktrees\.seed\.paths entry "a\/b" sits inside "a"/],
    ['a key entry with a control character', block({ key: ['a\nb'] }), /^worktrees\.seed\.key\[0\] must be a relative path/],
    ['an empty setup entry', block({ setup: [''] }), /^worktrees\.seed\.setup must be a list of non-empty commands/],
    ['paths without a key', block({ key: [] }), /^worktrees\.seed\.key must name at least one file when worktrees\.seed\.paths is set$/],
    ['a valid block', block({ paths: ['node_modules', 'dist/cache'], warm: ['npm run typecheck'] }), null],
    ['the default (off)', { paths: [], key: [], setup: [], warm: [] }, null],
  ];
  for (const [name, seed, want] of rows) {
    const problems = seedProblems(seed);
    if (want === null) assert.deepEqual(problems, [], name);
    else assert.ok(problems.length === 1 && want.test(problems[0]), `${name}: ${JSON.stringify(problems)}`);
  }
});

test('worktrees.seed commands get the placeholder check', () => {
  const c: any = defaults();
  c.worktrees.seed = block({ warm: ['curl {endpoint.api}'] });
  assert.ok(validateConfig(c, os.tmpdir()).some((p) => p.startsWith('worktrees.seed.warm[0] uses {endpoint.api}')));
});
