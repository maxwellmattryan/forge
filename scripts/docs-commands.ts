// `npm run docs:commands`: regenerates docs/CLI.md's Common commands table from the help tables beside
// each command module (lib/cli/commands/*.ts), so that table and `forge help` can't drift.
import fs from 'node:fs';
import path from 'node:path';
import { syncCommonCommands } from '../lib/cli/commands/help.ts';

const file = path.resolve(import.meta.dirname, '..', 'docs', 'CLI.md');
const before = fs.readFileSync(file, 'utf8');
const after = syncCommonCommands(before);
if (after !== before) fs.writeFileSync(file, after);
process.stdout.write(after === before ? 'docs/CLI.md is up to date\n' : 'docs/CLI.md updated\n');
