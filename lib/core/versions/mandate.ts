// The mandate version steps: a mandate file's `schemaVersion` (`.forge/runtime/mandates/<id>.md`) is this
// list's length plus one. Applied on read by lib/office/mandates/store.ts; a file is rewritten only by the
// next `forge mandate` write. Append only (AGENTS.md here): a new step goes at the end, with a row keyed by
// its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const MANDATE_STEPS: readonly Step[] = [];

export const MANDATE_SCHEMA_VERSION = versionOf(MANDATE_STEPS);
