import test from 'node:test';
import assert from 'node:assert/strict';
import { USER_NAMED_MAPS, deprecationChecks, unknownKeyChecks } from './deprecations.ts';
import { KEY_DOCS } from '../keys/docs.ts';
import { CONFIG_SCHEMA_VERSION } from '../../job/schema.ts';

const NO_AGENT_READS = 'no agent reads it: put the text in AGENTS.md (or a file project.instructions names) and delete the key';
const UNKNOWN_DETAIL = 'Forge reads no such key, so it has no effect: check its spelling and section against docs/CONFIG.md';

test('the real registry warns on each deprecated key', () => {
  const yaml = [
    'runtime:',
    '  host: claude-code',
    'usage:',
    '  track: true',
    'infra:',
    '  notes: terraform lives elsewhere',
    'project:',
    '  notes: be careful',
    '  kinds: [node]',
    '  description: a tool',
    '',
  ].join('\n');
  const detail = (note: string) => `deprecated in 0.23.0, removed in 1.0.0; ${note}`;
  assert.deepEqual(deprecationChecks(yaml), [
    { name: 'deprecated config key project.description', ok: true, warn: true, detail: detail(NO_AGENT_READS) },
    { name: 'deprecated config key project.kinds', ok: true, warn: true, detail: detail(NO_AGENT_READS) },
    { name: 'deprecated config key project.notes', ok: true, warn: true, detail: detail(NO_AGENT_READS) },
    { name: 'deprecated config key infra.notes', ok: true, warn: true, detail: detail(NO_AGENT_READS) },
    { name: 'deprecated config key usage.track', ok: true, warn: true, detail: detail('it has no effect (usage is recorded either way): delete the key') },
    { name: 'deprecated config key runtime.host', ok: true, warn: true, detail: detail('it has no effect: delete the key') },
  ]);
});

test('unknownKeyChecks', () => {
  const uniform = Object.entries(KEY_DOCS).filter(([, d]) => d.uniform).map(([k]) => k);
  assert.deepEqual([...USER_NAMED_MAPS].sort(), uniform.sort(), 'USER_NAMED_MAPS is the uniform KEY_DOCS entries');

  const long = 'k'.repeat(300);
  const rows: [string, string, string[]][] = [
    // AC4: one row per unknown key, in file order, at the first unknown segment.
    ['a top-level typo', 'pipelines:\n  plan: auto\n  maxRounds: 2\n', ['pipelines']],
    ['a nested typo', 'pipeline:\n  maxRound: 2\n', ['pipeline.maxRound']],
    ['a deep typo', 'foreman:\n  mandate:\n    budget:\n      usdd: 5\n', ['foreman.mandate.budget.usdd']],
    ['an unknown map with children gives one row', 'piplene:\n  plan: auto\n  split:\n    x: 1\n', ['piplene']],
    ['file order', 'zeta: 1\npipeline:\n  maxRound: 2\nalpha: 1\n', ['zeta', 'pipeline.maxRound', 'alpha']],
    ['known keys only', 'pipeline:\n  maxRounds: 2\nreview:\n  blockOn: [blocker]\n', []],
    // AC5: user-named maps, a custom tracker's block, lists, deprecated keys, migrated keys, type mismatches.
    ['commands', 'commands:\n  dist: npm run dist\n', []],
    ['usage.pricing', 'usage:\n  pricing:\n    models:\n      my-model:\n        input: 1\n', []],
    ['secrets', 'secrets:\n  DB:\n    env: DB_PASSWORD\n', []],
    ['tracker.github.project.statusMap', 'tracker:\n  github:\n    project:\n      statusMap:\n        review: In review\n', []],
    ['runtime.models', 'runtime:\n  models:\n    assistant: opus\n', []],
    ['runtime.efforts', 'runtime:\n  efforts:\n    assistant: high\n', []],
    ['project.instructions', 'project:\n  instructions:\n    builder: [AGENTS.md]\n', []],
    ['a custom tracker block', 'tracker:\n  kind: linear\n  linear:\n    team: x\n', []],
    ['a built-in tracker block is still checked', 'tracker:\n  kind: github\n  github:\n    repoo: x\n', ['tracker.github.repoo']],
    ['inside a list entry', 'components:\n  - { name: api, path: svc, kind: service, foo: 1 }\nreview:\n  panel:\n    - { name: code, foo: 1 }\n', []],
    ['a deprecated key', 'project:\n  notes: x\n', []],
    ['a v1 file migration moves', 'schemaVersion: 1\ndashboard:\n  port: 7400\n  launcher: "x {cmd}"\n', []],
    ['a value whose type differs from the default', 'release:\n  cadence:\n    x: 1\n', []],
    // AC6: nothing to judge.
    ['unparsable YAML', 'pipeline: [unclosed\n  : :\n\t- x', []],
    ['an empty file', '', []],
    ['a top-level list', '- a\n- b\n', []],
    ['a top-level scalar', 'hello\n', []],
    ['a newer schemaVersion', `schemaVersion: ${CONFIG_SCHEMA_VERSION + 1}\npiplene: {}\n`, []],
    // AC7: what a hostile key name can carry into the row.
    ['an ESC character', '"ab\\u001b[31mcd": 1\n', ['ab[31mcd']],
    ['a backtick', 'ab`cd: 1\n', ['abcd']],
    ['U+2028', '"ab\\u2028cd": 1\n', ['abcd']],
    ['a 300-character key', `${long}: 1\n`, ['k'.repeat(120)]],
  ];
  for (const [name, yaml, want] of rows) {
    assert.deepEqual(
      unknownKeyChecks(yaml),
      want.map((k) => ({ name: `unknown config key ${k}`, ok: true, warn: true, detail: UNKNOWN_DETAIL })),
      name,
    );
  }
});
