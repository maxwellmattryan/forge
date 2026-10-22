// lib/ folder maps stay true: every lib/ source opens with the header comment `npm run docs:map` reads,
// and each AGENTS.md map under lib/ is what it writes (docs/TESTING.md › Allowed source-text tests, entry 6).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAP_END, MAP_START, headerSentence, mapFiles, renderMap, syncMap } from '../../scripts/docs-map.ts';

const LIB = path.resolve(import.meta.dirname, '..', '..', 'lib');

test('every lib/ source file opens with a header comment', () => {
  const bare = (fs.readdirSync(LIB, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => /\.(ts|mjs)$/.test(f))
    .filter((f) => headerSentence(fs.readFileSync(path.join(LIB, f), 'utf8')) === null);
  assert.deepEqual(bare, [], 'open each with a // comment whose first sentence says what the file holds');
});

test('lib/ folder maps are what npm run docs:map writes', () => {
  const maps = mapFiles(LIB);
  assert.ok(maps.includes(path.join(LIB, 'step', 'AGENTS.md')), 'lib/step/AGENTS.md is a map');
  for (const file of maps) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(syncMap(text, renderMap(path.dirname(file))), text, `${path.relative(LIB, file)} is stale: run npm run docs:map`);
  }
});

test('docs:map reads header comments and stops at nested maps', () => {
  assert.equal(headerSentence('// Holds `a.ts` and b. More text.\n// Still more.\nimport x;'), 'Holds `a.ts` and b.');
  assert.equal(headerSentence('/**\n * Block header. Second.\n */\nexport {};'), 'Block header.');
  assert.equal(headerSentence('/* One line */'), 'One line');
  assert.equal(headerSentence('#!/usr/bin/env node\n\n// After a shebang!\n'), 'After a shebang!');
  assert.equal(headerSentence('// First paragraph without a mark\n//\n// Second paragraph.'), 'First paragraph without a mark');
  assert.equal(headerSentence('// Dots `in.code. spans` stay. Then.'), 'Dots `in.code. spans` stay.');
  assert.equal(headerSentence('#!/usr/bin/env node\nimport x;'), null, 'a shebang alone is no header');
  assert.equal(headerSentence("import x from './x.ts';\n// Too late."), null, 'a comment after the first import is no header');
  assert.equal(headerSentence(''), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docs-map-'));
  try {
    const put = (rel: string, text: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    };
    put('a.ts', '// Line header with `a.ts` and a | pipe. Rest.\nexport {};\n');
    put('b.mjs', '/** Block header. */\nexport {};\n');
    put('c.ts', '#!/usr/bin/env node\n// Shebang file.\n');
    put('x.test.ts', 'import test from "node:test";\n');
    put('notes.json', '{}');
    put('flat/d.ts', '// Nested without a map.\n');
    put('mapped/AGENTS.md', `# mapped/\n\nThe mapped folder. More.\n\n${MAP_START}\n${MAP_END}\n`);
    put('mapped/e.ts', 'export {};\n');
    assert.equal(renderMap(dir), [
      '| File | What it holds |',
      '|---|---|',
      '| `a.ts` | Line header with `a.ts` and a \\| pipe. |',
      '| `b.mjs` | Block header. |',
      '| `c.ts` | Shebang file. |',
      '| `flat/d.ts` | Nested without a map. |',
      '| `mapped/` | The mapped folder. |',
    ].join('\n'));
    assert.throws(() => renderMap(path.join(dir, 'mapped')), /e\.ts/, 'a mapped file without a header is named');

    put('g.ts', 'export {};\n');
    put('flat/h.ts', 'export {};\n');
    assert.throws(() => renderMap(dir), (err: Error) => /flat\/h\.ts/.test(err.message) && /g\.ts/.test(err.message));

    const doc = `# x\n\nIntro.\n\n${MAP_START}\nold\n${MAP_END}\nTail.\n`;
    assert.equal(syncMap(doc, 'new'), `# x\n\nIntro.\n\n${MAP_START}\nnew\n${MAP_END}\nTail.\n`);
    assert.throws(() => syncMap('# x\n\nNo markers.\n', 'new'), /markers/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
