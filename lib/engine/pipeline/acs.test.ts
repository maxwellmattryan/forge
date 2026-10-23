import test from 'node:test';
import assert from 'node:assert/strict';
import { acCoverage } from './acs.ts';

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
