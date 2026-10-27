// A component's `paths`: what componentProblems reports about them, how componentsForChanges maps
// changed files to the configured components a job changes, and how unmatchedChanges and jobComponent
// keep a stray file outside every component from picking one component's commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import { componentProblems, componentsForChanges, jobComponent, unmatchedChanges } from './components.ts';
import type { ComponentConfig } from '../types.ts';

test('component paths problems', () => {
  const rows: [string, unknown, string[]][] = [
    ['valid paths', ['lib/cli/**', 'bin/forge', '*.md'], []],
    ['not a list', 'lib/**', ['components "web".paths must be a list of paths or globs (got "lib/**")']],
    ['an empty list', [], ['components "web".paths must name at least one path or glob; omit it to match by path']],
    ['an absolute entry', ['/etc/x'], ['components "web".paths entry "/etc/x" must be relative to the repo']],
    ['a leading -', ['-x'], ['components "web".paths entry "-x" must not start with -, ! or :']],
    ['a leading !', ['!x'], ['components "web".paths entry "!x" must not start with -, ! or :']],
    ['a leading :', [':(top)x'], ['components "web".paths entry ":(top)x" must not start with -, ! or :']],
    ['a .. segment', ['web/../lib/**'], ['components "web".paths entry "web/../lib/**" must not contain a .. segment']],
    ['an empty entry', [''], ['components "web".paths entries must be non-empty strings (got "")']],
  ];
  for (const [name, paths, want] of rows) {
    const problems = componentProblems({ components: [{ name: 'web', path: '.', kind: 'app', paths }] });
    assert.deepEqual(problems, want, name);
  }
  assert.deepEqual(componentProblems({ components: [{ name: 'web', path: '.', kind: 'app' }] }), [], 'no paths: nothing to report');
});

test('componentsForChanges matches by paths, else path', () => {
  const c = (name: string, path: string, more: Partial<ComponentConfig> = {}): ComponentConfig => ({ name, path, kind: 'library', ...more });
  const config = {
    components: [
      c('core', 'crates/core'),
      c('cli', '.', { paths: ['lib/cli/**', 'bin/**'] }),
      c('root', '.'),
      c('docs', './docs/'),
      c('lib', '.', { repo: 'lib' }),
      c('ui', 'src', { repo: 'ui' }),
    ],
  };
  const rows: [string, [string | null, string[]][], string[]][] = [
    ['no changes', [], []],
    ['an empty root list', [[null, []]], []],
    ['. matches every root file', [[null, ['README.md']]], ['root']],
    ['a path matches files under it, not a sibling prefix', [[null, ['crates/core/x.rs', 'crates/corex/y.rs']]], ['core', 'root']],
    ['a path matches the file itself', [[null, ['crates/core']]], ['core', 'root']],
    ['paths win over path, in config order', [[null, ['bin/forge', 'crates/core/a.rs']]], ['core', 'cli', 'root']],
    ['a leading ./ and trailing / are dropped from path', [[null, ['docs/CLI.md']]], ['root', 'docs']],
    ['a member component matches only its repo', [['lib', ['src/a.ts']]], ['lib']],
    ['a member path applies within its repo', [['ui', ['src/App.svelte']], ['lib', []]], ['ui']],
    ['a member file never matches a root component', [['ui', ['lib/cli/a.ts']]], []],
  ];
  for (const [name, entries, want] of rows) assert.deepEqual(componentsForChanges(config, new Map(entries)), want, name);
});

test('unmatchedChanges counts root files no root component covers', () => {
  const c = (name: string, path: string, more: Partial<ComponentConfig> = {}): ComponentConfig => ({ name, path, kind: 'library', ...more });
  const scoped = { components: [c('cli', '.', { paths: ['lib/cli/**'] }), c('web', 'apps/web'), c('lib', '.', { repo: 'lib' })] };
  const rows: [string, typeof scoped, [string | null, string[]][], number][] = [
    ['no changes', scoped, [], 0],
    ['files every component covers', scoped, [[null, ['lib/cli/a.ts', 'apps/web/x.ts']]], 0],
    ['a root file outside every component', scoped, [[null, ['lib/cli/a.ts', 'Makefile']]], 1],
    ['each stray file counts', scoped, [[null, ['.github/ci.yml', 'scripts/test.sh', 'apps/web/x.ts']]], 2],
    ['a member repo file never counts', scoped, [['lib', ['src/a.rs']], [null, ['lib/cli/a.ts']]], 0],
    ['a component with path . covers the root', { components: [c('all', '.')] }, [[null, ['anything/at/all']]], 0],
    ['a member component does not cover the root', { components: [c('lib', '.', { repo: 'lib' })] }, [[null, ['a.ts']]], 1],
    ['paths that are not strings cover nothing', { components: [c('bad', '.', { paths: [1, null] as unknown as string[] })] }, [[null, ['a.ts']]], 1],
  ];
  for (const [name, config, entries, want] of rows) assert.equal(unmatchedChanges(config, new Map(entries)), want, name);
  // A component with a bad `paths` entry still matches by the entries that are strings, and never throws.
  const mixed = { components: [c('mixed', '.', { paths: ['lib/**', 7] as unknown as string[] })] };
  assert.deepEqual(componentsForChanges(mixed, new Map([[null, ['lib/a.ts']]])), ['mixed']);
  assert.deepEqual(componentsForChanges(mixed, new Map([[null, ['docs/a.md']]])), []);
});

test('jobComponent selects none when changes sit outside every component', () => {
  const config = { components: [{ name: 'cli', path: 'lib/cli', kind: 'library' as const }, { name: 'web', path: 'apps/web', kind: 'app' as const, repo: 'web' }] };
  const rows: [string, string[], boolean, string | null][] = [
    ['one root component', ['cli'], false, 'cli'],
    ['one root component and a file outside every component', ['cli'], true, null],
    ['none', [], false, null],
    ['several', ['cli', 'web'], false, null],
    ['a member component', ['web'], false, null],
  ];
  for (const [name, components, componentsUnmatched, want] of rows) assert.equal(jobComponent(config, { components, componentsUnmatched })?.name ?? null, want, name);
});
