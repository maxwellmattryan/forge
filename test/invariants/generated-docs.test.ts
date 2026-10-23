// The generated docs are what `npm run docs` writes, every config key has a doc string beside its
// default, and the dashboard's settings allowlist covers only documented keys (folded from
// config-set.test.ts). Docs stay in sync with code: docs/TESTING.md › Allowed source-text tests, entry 6.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from '#core/config/load.ts';
import { KEY_DOCS } from '#core/config/keys/docs.ts';
import { configDocProblems, renderConfigReference, syncConfigDoc } from '#core/config/keys/reference.ts';
import { parse } from '#core/format/yaml.ts';
import { syncReadme } from '../../lib/cli/commands/help.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (file: string): string => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('generated docs are what npm run docs writes', () => {
  for (const [file, sync] of [
    ['README.md', syncReadme],
    ['docs/CONFIG.md', syncConfigDoc],
  ] as const) {
    const text = read(file);
    assert.ok(sync(text) === text, `${file} is stale: run npm run docs`);
  }
});

test('every config key is documented beside its default', () => {
  const problems = configDocProblems(defaults(), KEY_DOCS);
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.deepEqual(parse(renderConfigReference()), defaults());
});
