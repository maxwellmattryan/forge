// `npm run docs:commands`: regenerates README.md's CLI command table from the help tables beside
// each command module (lib/commands/*.ts), so README and `forge help` can't drift.
import fs from 'node:fs';
import path from 'node:path';
import { syncReadme } from '../lib/cli/commands/help.ts';

const file = path.resolve(import.meta.dirname, '..', 'README.md');
const before = fs.readFileSync(file, 'utf8');
const after = syncReadme(before);
if (after !== before) fs.writeFileSync(file, after);
process.stdout.write(after === before ? 'README.md is up to date\n' : 'README.md updated\n');
