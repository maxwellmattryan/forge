// The machine index version steps: `<FORGE_HOME>/projects.json`'s schemaVersion is this list's length
// plus one. Applied on read; the file is rewritten only by the next add or remove. Append only
// (AGENTS.md here): a new step goes at the end, with a row keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const MACHINE_STEPS: readonly Step[] = [];

export const MACHINE_INDEX_VERSION = versionOf(MACHINE_STEPS);
