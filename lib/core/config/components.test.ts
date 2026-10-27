// A component's `paths`: what componentProblems reports about them, and how componentsForChanges maps
// changed files to the configured components a job changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { componentProblems, componentsForChanges } from './components.ts';
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
