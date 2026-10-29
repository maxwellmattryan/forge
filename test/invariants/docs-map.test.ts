// Folder maps stay true: every source under lib/ and dashboard/src/lib/ opens with the header comment
// `npm run docs:map` reads, each AGENTS.md map under those roots is what it writes, and header comments
// under lib/ and dashboard/src/ stay wrapped (docs/TESTING.md › Allowed source-text tests, entries 6 and 14).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAP_END, MAP_ROOTS, MAP_START, headerSentence, mapFiles, renderMap, syncMap } from '../../scripts/docs-map.ts';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const LIB = path.join(REPO, 'lib');
const DASHBOARD_SRC = path.join(REPO, 'dashboard', 'src');
// Absolute, not "past its neighbours": a relative rule flags every short last line. Reviewers flagged
// 193, 164 and 185 columns in three jobs; 160 catches all three and leaves 7 files to rewrap, 140 23.
const HEADER_WIDTH = 160;

/**
 * A source file's header comment, as numbered lines: after an optional shebang, blank lines and one
 * opening `<script>` line, either a run of `//` lines or one `/* … *\/` or `<!-- … -->` block.
 */
function headerLines(text: string): { n: number; line: string }[] {
  const lines = text.split('\n');
  let i = 0;
  if (lines[i]?.startsWith('#!')) i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (/^<script\b/.test(lines[i] ?? '')) i++;
  const out: { n: number; line: string }[] = [];
  const first = (lines[i] ?? '').trimStart();
  if (first.startsWith('//')) {
    for (; i < lines.length && lines[i].trimStart().startsWith('//'); i++) out.push({ n: i + 1, line: lines[i] });
  } else if (first.startsWith('/*') || first.startsWith('<!--')) {
    const close = first.startsWith('/*') ? '*/' : '-->';
    for (; i < lines.length; i++) {
      out.push({ n: i + 1, line: lines[i] });
      if (lines[i].includes(close)) break;
    }
  }
  return out;
}

const tooWide = (text: string): { n: number; width: number }[] =>
  headerLines(text).filter((l) => l.line.length > HEADER_WIDTH).map((l) => ({ n: l.n, width: l.line.length }));

test('header comment lines stay within 160 columns', () => {
  const pad = (prefix: string, width: number): string => prefix + 'x'.repeat(width - prefix.length);
  const forms: [string, (line: string) => string][] = [
    ['// header', (l) => `${l}\n// more\nexport {};\n`],
    ['/* … */ header', (l) => `/**\n${l}\n */\nexport {};\n`],
    ['<!-- … --> header', (l) => `<!-- Svelte header\n${l}\n-->\n<script lang="ts"></script>\n`],
    ['// after <script>', (l) => `<script lang="ts">\n${l}\n  import x from './x.ts';\n</script>\n`],
    ['after a shebang', (l) => `#!/usr/bin/env node\n\n${l}\nimport x;\n`],
  ];
  for (const [name, wrap] of forms) {
    const prefix = name.startsWith('/*') ? ' * ' : name.startsWith('<!--') ? '     ' : name.includes('<script') ? '  // ' : '// ';
    assert.equal(tooWide(wrap(pad(prefix, 161))).length, 1, `${name}: 161 columns fails`);
    assert.deepEqual(tooWide(wrap(pad(prefix, 160))), [], `${name}: 160 columns passes`);
  }
  assert.deepEqual(tooWide(`// Short header.\nconst x = '${'y'.repeat(200)}';\n// ${'z'.repeat(200)}\n`), [], 'lines after the header are ignored');

  const offenders: string[] = [];
  for (const dir of [LIB, DASHBOARD_SRC]) {
    for (const f of fs.readdirSync(dir, { recursive: true }) as string[]) {
      if (!/\.(ts|mjs|svelte)$/.test(f) || f.endsWith('.test.ts')) continue;
      const file = path.join(dir, f);
      for (const o of tooWide(fs.readFileSync(file, 'utf8'))) offenders.push(`${path.relative(path.dirname(LIB), file).split(path.sep).join('/')}:${o.n} (${o.width})`);
    }
  }
  assert.deepEqual(offenders, [], `rewrap these header comment lines to ${HEADER_WIDTH} columns or fewer`);
});

test('every lib/ and dashboard/src/lib/ source file opens with a header comment', () => {
  const bare = MAP_ROOTS.flatMap((root) => (fs.readdirSync(path.join(REPO, root), { recursive: true }) as string[])
    .map((f) => `${root}/${f.split(path.sep).join('/')}`))
    .filter((f) => /\.(ts|mjs)$/.test(f) && !f.endsWith('.test.ts'))
    .filter((f) => headerSentence(fs.readFileSync(path.join(REPO, f), 'utf8')) === null);
  assert.deepEqual(bare, [], 'open each with a // comment whose first sentence says what the file holds');
});

test('folder maps are what npm run docs:map writes', () => {
  const maps = MAP_ROOTS.flatMap((root) => mapFiles(path.join(REPO, root)));
  assert.ok(maps.includes(path.join(LIB, 'engine', 'pipeline', 'step', 'AGENTS.md')), 'lib/engine/pipeline/step/AGENTS.md is a map');
  assert.ok(maps.includes(path.join(REPO, 'dashboard', 'src', 'lib', 'AGENTS.md')), 'dashboard/src/lib/AGENTS.md is a map');
  for (const file of maps) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(syncMap(text, renderMap(path.dirname(file))), text, `${path.relative(REPO, file)} is stale: run npm run docs:map`);
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
  assert.equal(headerSentence('/// <reference types="vite/client" />\n// The locale layer. More.\n'), 'The locale layer.', 'a /// directive is skipped');
  assert.equal(headerSentence('/// <reference types="vite/client" />\n'), null, 'a /// directive alone is no header');
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
