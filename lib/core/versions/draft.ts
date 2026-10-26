// The milestone draft version steps: a goal mandate's draft.json `schemaVersion`
// (`.forge/runtime/mandates/<id>/draft.json`) is this list's length plus one. Applied on read by
// lib/office/mandates/draft.ts; a file is rewritten only by the next `forge mandate draft record`. Append
// only (AGENTS.md here): a new step goes at the end, with a row keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const DRAFT_STEPS: readonly Step[] = [];

export const DRAFT_SCHEMA_VERSION = versionOf(DRAFT_STEPS);
