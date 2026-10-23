// docs/CLI.md's command reference from planted help tables: markdown escaping, tables only where a
// command has rows, docs links made relative to docs/, and syncCliDoc refusing a file without its markers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CLI_END, CLI_START, ERRORS_END, ERRORS_START, cliReference, syncCliDoc } from './help.ts';
import type { HelpGroup } from '../types.ts';

test('renders the CLI reference from planted tables', () => {
  const group: HelpGroup = {
    name: 'demo',
    summary: 'a demo group',
    commands: [
      {
        command: 'demo run',
        args: '<id> [--only A|B]',
        summary: 'run <id> on *.ts files, not `a|b <x>`',
        flags: [['--only A|B', 'pick A or B; `x|y` is <literal>']],
        exits: [[1, 'failed for <id>']],
        docs: ['Effort', 'docs/CONFIG.md#effort'],
      },
      { command: 'demo list', args: '', summary: 'list them' },
      { command: 'demo update', args: '', summary: 'update in place', docs: ['Updating', 'README.md#updating'] },
    ],
  };
  const text = cliReference([group]);
  assert.match(text, /^Every command also takes these flags, and exits 0 when it did what it was asked or 2 \(`usage`\) when /);
  assert.ok(text.includes('\n| Global flag | Meaning |\n|---|---|\n'), 'the global flags table');
  assert.ok(text.includes('\n| `--mode human\\|agent` | '), 'a global flag escapes its |');
  assert.equal(
    text.slice(text.indexOf('### ')),
    [
      '### `forge demo`',
      'A demo group.',
      '**`forge demo run <id> [--only A|B]`**: run &lt;id> on \\*.ts files, not `a|b <x>`',
      '| Flag | Meaning |\n|---|---|\n| `--only A\\|B` | pick A or B; `x\\|y` is &lt;literal> |',
      '| Exit | When |\n|---|---|\n| 1 | failed for &lt;id> |',
      'See [Effort](CONFIG.md#effort).',
      '**`forge demo list`**: list them',
      '**`forge demo update`**: update in place',
      'See [Updating](../README.md#updating).',
    ].join('\n\n'),
  );

  const both = `a\n${ERRORS_START}\nold\n${ERRORS_END}\nb\n${CLI_START}\nold\n${CLI_END}\n`;
  assert.ok(syncCliDoc(both).includes(`${CLI_START}\nEvery command also takes these flags`));
  assert.throws(() => syncCliDoc(`${CLI_START}\n${CLI_END}\n`), { message: `docs/CLI.md has no ${ERRORS_START} … ${ERRORS_END} region` });
  assert.throws(() => syncCliDoc(`${ERRORS_START}\n${ERRORS_END}\n`), { message: `docs/CLI.md has no ${CLI_START} … ${CLI_END} region` });
});
