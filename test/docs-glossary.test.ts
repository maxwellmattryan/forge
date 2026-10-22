// docs/GLOSSARY.md names config keys; they must stay in sync with defaults(), as docs/CONFIG.md does
// in config-set.test.ts (a docs-sync invariant on the docs/TESTING.md list).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../lib/config.ts';
import { getPath } from '../lib/util.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const GLOSSARY = fs.readFileSync(path.join(ROOT, 'docs', 'GLOSSARY.md'), 'utf8');

type Row = { term: string; cells: string[]; line: string };

function rows(): Row[] {
  return GLOSSARY.split('\n')
    .filter((l) => l.startsWith('| **'))
    .map((line) => {
      const cells = line.replace(/^\|\s/, '').replace(/\s\|$/, '').split(' | ');
      const m = /^\*\*(.+?)\*\*$/.exec(cells[0] ?? '');
      return { term: m ? m[1] : '', cells, line };
    });
}

test('config keys exist or are marked planned', () => {
  const d = defaults();
  const all = rows();
  assert.ok(all.length > 0, 'found the glossary rows');
  for (const r of all) {
    const cell = (r.cells[2] ?? '').trim();
    if (cell === '-' || /^planned \(M00\d\)$/.test(cell)) continue;
    const keys = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    assert.ok(keys.length > 0, `${r.term}: key cell "${cell}" is a key, planned (M00n) or -`);
    assert.equal(cell.replace(/`[^`]+`/g, '').replace(/[,\s]/g, ''), '', `${r.term}: key cell holds only keys`);
    for (const k of keys) {
      // `components[].config` names a key of each list entry: the list itself must be in defaults().
      const [list, sub] = k.split('[].');
      if (sub !== undefined) assert.ok(Array.isArray(getPath(d, list)), `${r.term}: \`${list}\` is not a list in defaults()`);
      else assert.notEqual(getPath(d, k), undefined, `${r.term}: \`${k}\` is not in defaults()`);
    }
  }
});
