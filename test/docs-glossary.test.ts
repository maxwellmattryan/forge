import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '../lib/config.ts';
import { getPath } from '../lib/util.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const GLOSSARY = read('docs/GLOSSARY.md');

const TERMS = [
  'project', 'root repo', 'member repo', 'component', 'dependency', 'backing service', 'isolation', 'project graph',
  'profile', 'environment', 'endpoint', 'focus', 'checkout hook', 'job repo', 'verify-only repo', 'local link',
  'interim reference', 'interim strategy', 'release gate', 'release', 'release strategy', 'release mechanism', 'release cadence', 'release plan', 'config sink',
  'secret reference', 'issue ref',
];

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

function collisions(): string {
  const m = /^## Collisions we avoid$([\s\S]*?)(?=^## )/m.exec(GLOSSARY);
  assert.ok(m, 'glossary has a "Collisions we avoid" section followed by another section');
  return m[1];
}

test('every required term has one row', () => {
  const all = rows();
  for (const term of TERMS) {
    const hits = all.filter((r) => r.term === term);
    assert.equal(hits.length, 1, `${term}: expected one row, found ${hits.length}`);
    assert.ok(hits[0].line.startsWith(`| **${term}** |`), term);
  }
});

test('each term is one sentence with a key cell', () => {
  for (const r of rows()) {
    assert.equal(r.cells.length, 3, `${r.term}: three cells`);
    const meaning = r.cells[1];
    assert.match(meaning, /\.$/, `${r.term}: meaning ends in a period`);
    assert.doesNotMatch(meaning, /\. [A-Z]/, `${r.term}: meaning is one sentence`);
    assert.ok(r.cells[2].trim().length > 0, `${r.term}: key cell is filled`);
  }
});

test('enumerated terms list their values', () => {
  const values: Record<string, string[]> = {
    component: ['library', 'service', 'app'],
    dependency: ['build', 'runtime'],
    isolation: ['per-job', 'shared', 'external'],
    'interim strategy': ['canary', 'git-ref', 'local', 'sequential'],
    'release mechanism': ['release-please', 'cargo-release', 'changesets', 'tag'],
    'release cadence': ['on-merge', 'scheduled', 'manual'],
  };
  const all = rows();
  for (const [term, vals] of Object.entries(values)) {
    const row = all.find((r) => r.term === term);
    assert.ok(row, term);
    for (const v of vals) assert.ok(row.cells[1].includes(`\`${v}\``), `${term}: lists \`${v}\``);
  }
});

test('config keys exist or are marked planned', () => {
  const d = defaults();
  for (const r of rows()) {
    const cell = r.cells[2].trim();
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

test('collisions section names the reserved words', () => {
  const s = collisions();
  for (const w of ['`resources`', '`infra.mode`', 'GitHub Project', '`tracker.github.project`', '`statusSync: project`', '`project:`', '`services:`', 'Model profiles', '`runtime.models`', '`dependsOn`']) {
    assert.ok(s.includes(w), `collisions section names ${w}`);
  }
  assert.match(s, /`resources`[\s\S]*`infra\.mode`[\s\S]*"backing service"/, 'says why runtime infrastructure is a backing service');
});

test('plain words only', () => {
  const outside = GLOSSARY.replace(collisions(), '');
  const bare = [...outside.matchAll(/\bProjects?\b/g)].filter((m) => !outside.slice(0, m.index).endsWith('GitHub '));
  assert.deepEqual(bare.map((m) => outside.slice(Math.max(0, m.index - 30), m.index + 10)), [], 'capital-P Project only as GitHub Project');
  assert.doesNotMatch(GLOSSARY, /\b(Heat|Piece|Crucible|Pour|Smithy)\b/, 'no metaphor names');
});

test('README, ARCHITECTURE and AGENTS link the glossary', () => {
  assert.ok(read('README.md').includes('](docs/GLOSSARY.md)'), 'README links docs/GLOSSARY.md');
  assert.ok(read('AGENTS.md').includes('](docs/GLOSSARY.md)'), 'AGENTS links docs/GLOSSARY.md');
  assert.ok(read('docs/ARCHITECTURE.md').includes('](GLOSSARY.md)'), 'ARCHITECTURE links GLOSSARY.md');
});
