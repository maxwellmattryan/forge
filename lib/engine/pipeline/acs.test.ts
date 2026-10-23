import test from 'node:test';
import assert from 'node:assert/strict';
import { acCoverage, specFileMapPaths } from './acs.ts';

const TABLE = ['| Path | Symbols | Change | Tests |', '|---|---|---|---|', '| `a.ts` | `f` | new | `a.test.ts` |', '| `b.ts` | `g` | edit: g | - |', '| `c.ts` | - | reuse | - |'];
const spec = (approach: string[], after: string[] = []) => ['# Spec', '', '## Acceptance criteria', '- [ ] AC1 — works', '', '## Approach', 'Change a, b and c.', '', ...approach, '', ...after, '## Tasks', '- [ ] do it', ''].join('\n');

test('spec file map', () => {
  const rows: { name: string; spec: string | null; want: { fileMap: number; incomplete: string[] } }[] = [
    { name: 'Approach ends with a 3-row Files: table', spec: spec(['Files:', ...TABLE]), want: { fileMap: 3, incomplete: [] } },
    { name: '**Files:** and blank lines before the table', spec: spec(['**Files:**', '', ...TABLE]), want: { fileMap: 3, incomplete: [] } },
    { name: '**Files**: and a lower-case header', spec: spec(['**Files**:', ...TABLE.map((l, i) => (i ? l : l.replace('Path', 'path')))]), want: { fileMap: 3, incomplete: [] } },
    { name: 'a row with an empty first cell is not counted', spec: spec(['Files:', ...TABLE, '|  | x | new | - |']), want: { fileMap: 3, incomplete: [] } },
    { name: 'no table', spec: spec([]), want: { fileMap: 0, incomplete: ['files'] } },
    { name: 'a table inside a code fence', spec: spec(['```', 'Files:', ...TABLE, '```']), want: { fileMap: 0, incomplete: ['files'] } },
    { name: 'a Files: table under another heading', spec: spec([], ['## Notes', 'Files:', ...TABLE, '']), want: { fileMap: 0, incomplete: ['files'] } },
    { name: "a first header cell that isn't Path", spec: spec(['Files:', '| File | Change |', '|---|---|', '| `a.ts` | new |']), want: { fileMap: 0, incomplete: ['files'] } },
    { name: 'a table without the Files: line', spec: spec(TABLE), want: { fileMap: 0, incomplete: ['files'] } },
    { name: 'no spec.md', spec: null, want: { fileMap: 0, incomplete: [] } },
  ];
  for (const r of rows) {
    const c = acCoverage(r.spec, null);
    assert.deepEqual({ fileMap: c.fileMap, incomplete: c.incomplete }, r.want, r.name);
  }
});

test('spec file map paths', () => {
  const map = (...first: string[]) => spec(['Files:', '| Path | Change |', '|---|---|', ...first.map((c) => `| ${c} | edit |`)]);
  const rows: [string, string, string[]][] = [
    ['backticks are stripped, in table order', spec(['Files:', ...TABLE]), ['a.ts', 'b.ts', 'c.ts']],
    ['a cell without backticks, cut at whitespace', map('lib/x.ts (new)'), ['lib/x.ts']],
    ['the first backtick span of a cell', map('`lib/a.ts`, `lib/b.ts`'), ['lib/a.ts']],
    ['a glob is cut down to its directory', map('`lib/engine/**/*.ts`', '`docs/*.md`', '`lib/core/x?.ts`', '`lib/api/[ab].ts`', '`skills/forge/{a,b}.md`'), ['lib/engine/', 'docs/', 'lib/core/', 'lib/api/', 'skills/forge/']],
    ['a root-level glob leaves nothing', map('`*.md`'), []],
    ['a directory keeps its slash', map('`lib/engine/pipeline/`'), ['lib/engine/pipeline/']],
    ['./ is normalised away', map('`./lib/x.ts`', '`lib//y.ts`'), ['lib/x.ts', 'lib/y.ts']],
    ['absolute paths are dropped', map('`/etc/passwd`', '`C:\\x.ts`', '`\\\\host\\x`', '`ok.ts`'), ['ok.ts']],
    ['.. segments are dropped, even ones normalize would fold', map('`../outside.ts`', '`lib/../x.ts`', '`lib/a/../../../x.ts`'), []],
    ['empty cells and duplicates', map('``', '`a.ts`', '`a.ts`', '` `'), ['a.ts']],
    ['a path over 300 characters is dropped', map(`\`${'a/'.repeat(151)}x.ts\``, '`b.ts`'), ['b.ts']],
    ['at most 100 paths', map(...Array.from({ length: 120 }, (_, i) => `\`f${i}.ts\``)), Array.from({ length: 100 }, (_, i) => `f${i}.ts`)],
    ['no file map', spec([]), []],
    ['a table in a code fence', spec(['```', 'Files:', ...TABLE, '```']), []],
  ];
  for (const [name, text, want] of rows) assert.deepEqual(specFileMapPaths(text), want, name);
});
