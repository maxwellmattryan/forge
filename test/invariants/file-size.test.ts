// lib/ files stay small: no lib/ source is over 600 lines unless ALLOWED pins it at its count, and a
// pinned file may shrink but never grow. It counts source lines, so it reads lib/ files (docs/TESTING.md ›
// Allowed source-text tests, entry 11). The move (#421) re-keys the paths; the splits (#413–#419)
// delete entries, and a file that fits under the cap must leave the list.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const LIB = path.resolve(import.meta.dirname, '..', '..', 'lib');
const CAP = 600;

/** Lib-relative path → its line count when pinned. Lower a pin when a file shrinks; never raise one. */
const ALLOWED: Record<string, number> = {
  'engine/environment/backing.ts': 751,
  'cli/commands/tracker.ts': 611,
  'office/pool.ts': 632,
  'engine/guard/integrity.ts': 832,
  'engine/release/interim-apply.ts': 921,
  'engine/release/interim.ts': 698,
  'core/job/store.ts': 808,
  'core/job/schema.ts': 666,
  'engine/guard/secrets.ts': 705,
};

/** Lines as `wc -l` counts them for a newline-terminated file. */
const lineCount = (text: string): number => text.split('\n').length - (text.endsWith('\n') ? 1 : 0);

/** Files over the cap and off the list, files past their pin, pins that now fit, and pins for missing files. */
function sizeProblems(sizes: Map<string, number>, allowed: Record<string, number>, cap: number): string[] {
  const problems: string[] = [];
  for (const [file, lines] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
    const pin = allowed[file];
    if (pin === undefined) {
      if (lines > cap) problems.push(`${file}: ${lines} lines, over the ${cap}-line cap: split it`);
    } else if (lines > pin) {
      problems.push(`${file}: ${lines} lines, over its pin of ${pin}: split it rather than raise the pin`);
    } else if (lines <= cap) {
      problems.push(`${file}: ${lines} lines, within the ${cap}-line cap: drop it from the list`);
    }
  }
  for (const file of Object.keys(allowed).sort()) {
    if (!sizes.has(file)) problems.push(`${file}: pinned but not found: drop it from the list`);
  }
  return problems;
}

test('no lib/ source file is over 600 lines unless allowlisted', () => {
  const files = (fs.readdirSync(LIB, { recursive: true }) as string[])
    .map((f) => f.split(path.sep).join('/'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const sizes = new Map(files.map((f) => [f, lineCount(fs.readFileSync(path.join(LIB, f), 'utf8'))]));
  const problems = sizeProblems(sizes, ALLOWED, CAP);
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('the size check reports growth, fits and stale entries', () => {
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
  const sizes = new Map([['big.ts', 601], ['grown.ts', 700], ['fits.ts', 600], ['held.ts', 650], ['small.ts', 10]]);
  assert.deepEqual(sizeProblems(sizes, { 'grown.ts': 690, 'fits.ts': 640, 'held.ts': 660, 'gone.ts': 900 }, 600), [
    'big.ts: 601 lines, over the 600-line cap: split it',
    'fits.ts: 600 lines, within the 600-line cap: drop it from the list',
    'grown.ts: 700 lines, over its pin of 690: split it rather than raise the pin',
    'gone.ts: pinned but not found: drop it from the list',
  ]);
});
