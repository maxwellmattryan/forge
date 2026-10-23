// The release notes count every version list: `versionsAt` (scripts/release.ts) reads the lists as
// text, because a past tag's lists can only be read that way, so this holds that the text count of
// this repo's real list files equals the versions the engine computes (docs/TESTING.md › Allowed
// source-text tests, entry 13). An entry written off the `  { id: '` line format fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { versionsAt } from '../../scripts/release.ts';
import { API_VERSION, ARCHIVE_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, JOB_SCHEMA_VERSION } from '#core/job/schema.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');

test('the release notes count every version list', () => {
  const read = (rel: string) => {
    const file = path.join(ROOT, rel);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  };
  assert.deepEqual(versionsAt(read), { ARCHIVE_SCHEMA_VERSION, CONFIG_SCHEMA_VERSION, JOB_SCHEMA_VERSION, EVENT_SCHEMA_VERSION, API_VERSION });
});
