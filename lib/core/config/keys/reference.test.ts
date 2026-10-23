// The config reference renderer: its layout rules on a planted config, what configDocProblems reports
// on planted gaps, and syncConfigDoc refusing a file without its markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG_END, CONFIG_START, configDocProblems, renderConfigReference, syncConfigDoc } from './reference.ts';
import { parse } from '../../format/yaml.ts';
import type { KeyDoc } from './docs.ts';

test('renders the reference and reports undocumented keys', () => {
  const config = {
    app: {
      name: 'demo',
      nested: { deep: true },
      span: { from: 1, to: 2 },
      rules: [{ paths: ['a/**', '**/*.pem'], reason: 'keys: never' }],
      tools: ['Bash(x:*)', 'Read'],
      tags: [],
      extra: {},
      longKeyNameThatPushesPastTheColumn: 'value',
    },
    roles: { builder: 'opus', judge: 'sonnet' },
  };
  const docs: Record<string, KeyDoc> = {
    app: { doc: 'the app', more: ['  - { name: x }   # an example entry'] },
    'app.name': { doc: 'display name\nand a second line' },
    'app.nested': { doc: 'a block map' },
    'app.nested.deep': { doc: 'deep flag' },
    'app.span': { doc: 'one line', layout: 'flow' },
    'app.rules': { doc: 'a list of maps' },
    'app.tools': { doc: 'one per line', layout: 'block' },
    'app.tags': { doc: 'empty list' },
    'app.extra': { doc: 'empty map' },
    'app.longKeyNameThatPushesPastTheColumn': { doc: 'two spaces' },
    roles: { doc: 'per role', uniform: true },
    'roles.judge': { doc: 'the judge' },
  };
  const text = renderConfigReference(config, docs);
  assert.equal(
    text,
    [
      'app:                         # the app',
      '  name: demo                 # display name',
      '                             # and a second line',
      '  nested:                    # a block map',
      '    deep: true               # deep flag',
      '  span: { from: 1, to: 2 }   # one line',
      '  rules:                     # a list of maps',
      '    - { paths: [a/**, "**/*.pem"], reason: "keys: never" }',
      '  tools:                     # one per line',
      '    - Bash(x:*)',
      '    - Read',
      '  tags: []                   # empty list',
      '  extra: {}                  # empty map',
      '  longKeyNameThatPushesPastTheColumn: value  # two spaces',
      '#   - { name: x }   # an example entry',
      '',
      'roles:                       # per role',
      '  builder: opus',
      '  judge: sonnet              # the judge',
      '',
    ].join('\n'),
  );
  assert.deepEqual(parse(text), config);
  assert.deepEqual(configDocProblems(config, docs), []);

  const gaps: Record<string, KeyDoc> = {
    ...docs,
    'app.name': { doc: ' ' },
    'app.gone': { doc: 'no such key' },
    'app.tools': { doc: 'not a map', layout: 'flow' },
    'app.rules': { doc: 'not a list of scalars', layout: 'block' },
  };
  delete gaps['app.nested.deep'];
  assert.deepEqual(configDocProblems(config, gaps), [
    'app.gone: documented but not in defaults()',
    'app.name: no doc string in lib/core/config/keys/docs.ts',
    'app.nested.deep: no doc string in lib/core/config/keys/docs.ts',
    'app.rules: layout block does not fit its value',
    'app.tools: layout flow does not fit its value',
  ]);

  assert.throws(() => syncConfigDoc('# no markers\n'), { message: `docs/CONFIG.md has no ${CONFIG_START} … ${CONFIG_END} region` });
  assert.throws(() => syncConfigDoc(`${CONFIG_END}\n${CONFIG_START}\n`), /has no .* region/);
});
