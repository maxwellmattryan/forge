// The closing summary version steps: a closed mandate's summary.json `schemaVersion`
// (`.forge/runtime/mandates/<id>/summary.json`) is this list's length plus one. Read by
// lib/office/mandates/pass.ts (`readSummary`), which refuses a newer one; the Office pass writes the file
// once, when it closes the mandate. Append only (AGENTS.md here): a new step goes at the end, with a row
// keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const MANDATE_SUMMARY_STEPS: readonly Step[] = [];

export const MANDATE_SUMMARY_SCHEMA_VERSION = versionOf(MANDATE_SUMMARY_STEPS);
