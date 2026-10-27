// The closing summary version steps: a closed mandate's summary.json `schemaVersion`
// (`.forge/runtime/mandates/<id>/summary.json`) is this list's length plus one. Read by
// lib/office/mandates/pass.ts (`readSummary`), which refuses a newer one; the Office pass writes the file
// when it closes the mandate, and rewrites it once when the card's outcomes are all final. Append only
// (AGENTS.md here): a new step goes at the end, with a row keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const MANDATE_SUMMARY_STEPS: readonly Step[] = [
  // The closing summary carries the mandate's report card at close; one written before it has none.
  { id: 'summary-card', up: (s) => ({ ...s, card: null }) },
  // outcomesFinalAt: when the card's outcomes went final; an older summary reads null, so the pass fills its card in once.
  { id: 'summary-final', up: (s) => ({ ...s, outcomesFinalAt: null }) },
];

export const MANDATE_SUMMARY_SCHEMA_VERSION = versionOf(MANDATE_SUMMARY_STEPS);
