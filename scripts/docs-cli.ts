// `npm run docs:cli`: regenerates docs/CLI.md's command reference from the help tables beside each
// command module (lib/cli/commands/*.ts) and its "Error codes" table from ERROR_CODE_DOCS in
// lib/core/errors.ts, so the reference can't drift from `forge help`.
import fs from 'node:fs';
import path from 'node:path';
import { syncCliDoc } from '../lib/cli/commands/help.ts';

const file = path.resolve(import.meta.dirname, '..', 'docs', 'CLI.md');
const before = fs.readFileSync(file, 'utf8');
const after = syncCliDoc(before);
if (after !== before) fs.writeFileSync(file, after);
process.stdout.write(after === before ? 'docs/CLI.md is up to date\n' : 'docs/CLI.md updated\n');
