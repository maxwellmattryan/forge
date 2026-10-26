// The filing record version steps: an approved milestone draft's filing.json `schemaVersion`
// (`.forge/runtime/mandates/<id>/filing.json`) is this list's length plus one. Applied on read by
// lib/office/mandates/filing.ts; a file is rewritten only by the next `forge mandate draft approve`. Append
// only (AGENTS.md here): a new step goes at the end, with a row keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const FILING_STEPS: readonly Step[] = [];

export const FILING_SCHEMA_VERSION = versionOf(FILING_STEPS);
