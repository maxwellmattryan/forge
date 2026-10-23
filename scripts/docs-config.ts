// `npm run docs:config`: regenerates docs/CONFIG.md's per-key reference block from defaults() and the
// doc strings in lib/core/config/keys/docs.ts, so the documented defaults can't drift from the code.
import fs from 'node:fs';
import path from 'node:path';
import { syncConfigDoc } from '../lib/core/config/keys/reference.ts';

const file = path.resolve(import.meta.dirname, '..', 'docs', 'CONFIG.md');
const before = fs.readFileSync(file, 'utf8');
const after = syncConfigDoc(before);
if (after !== before) fs.writeFileSync(file, after);
process.stdout.write(after === before ? 'docs/CONFIG.md is up to date\n' : 'docs/CONFIG.md updated\n');
