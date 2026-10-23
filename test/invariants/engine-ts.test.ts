// The engine compiles strict and erasable-only. Kept through the test rewrite (docs/test-rewrite/README.md):
// the compiler flags are the invariant (strict types; only syntax Node's type stripping can erase), and no
// public function exposes them, so this reads tsconfig.json (docs/TESTING.md › Allowed source-text tests, entry 8).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const readJson = (rel: string): any => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

test('engine tsconfig is strict and erasable-only', () => {
  const { compilerOptions } = readJson('tsconfig.json');
  assert.equal(compilerOptions.strict, true);
  assert.equal(compilerOptions.erasableSyntaxOnly, true);
});
