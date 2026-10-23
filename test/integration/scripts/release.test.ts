// scripts/release.ts: the versions the release notes compare, read from a tag or the working tree.
import test from 'node:test';
import assert from 'node:assert/strict';
import { versionsAt } from '../../../scripts/release.ts';

const CONSTANTS = [
  'export const CONFIG_SCHEMA_VERSION = 22;',
  'export const JOB_SCHEMA_VERSION = 14;',
  'export const EVENT_SCHEMA_VERSION = 2;',
  'export const ARCHIVE_SCHEMA_VERSION = 1;',
  'export const API_VERSION = 29;',
  'export const SEVERITIES = 4;',
].join('\n');
const LITERALS = { CONFIG_SCHEMA_VERSION: 22, JOB_SCHEMA_VERSION: 14, EVENT_SCHEMA_VERSION: 2, ARCHIVE_SCHEMA_VERSION: 1, API_VERSION: 29 };

const TWO = ["export const X = [", "  // a step's comment", "  { id: 'one', up: (c) => c },", "  { id: 'two', up: (c) => {", '    return c;', '  } },', '];'].join('\n');
const THREE = ['export const API_CHANGES = [', "  { id: 'api-2' },", "  { id: 'api-3' },", "  { id: 'api-4' },", '] as const;'].join('\n');
const LISTS_SCHEMA = ['export const ARCHIVE_SCHEMA_VERSION = 1;', "export { CONFIG_SCHEMA_VERSION } from '../versions/config.ts';"].join('\n');

test('versionsAt reads literal constants and version lists', () => {
  const rows: [string, Record<string, string>, Record<string, number>][] = [
    ['a tag with literal constants in lib/core/job/schema.ts', { 'lib/core/job/schema.ts': CONSTANTS }, LITERALS],
    ['a tag from before the lib/ layers, with only lib/schema.ts', { 'lib/schema.ts': CONSTANTS }, LITERALS],
    [
      'a tree with version lists, one entry multi-line',
      {
        'lib/core/job/schema.ts': LISTS_SCHEMA,
        'lib/core/versions/config.ts': TWO,
        'lib/core/versions/job.ts': THREE,
        'lib/core/versions/event.ts': TWO,
        'lib/api/versions.ts': THREE,
      },
      { ARCHIVE_SCHEMA_VERSION: 1, CONFIG_SCHEMA_VERSION: 3, JOB_SCHEMA_VERSION: 4, EVENT_SCHEMA_VERSION: 3, API_VERSION: 4 },
    ],
    ['a tree with no schema file', {}, {}],
  ];
  for (const [name, files, want] of rows) assert.deepEqual(versionsAt((rel) => files[rel] ?? null), want, name);
});
