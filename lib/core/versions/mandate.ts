// The mandate version steps: a mandate file's `schemaVersion` (`.forge/runtime/mandates/<id>.md`) is this
// list's length plus one. Applied on read by lib/office/mandates/store.ts; a file is rewritten only by the
// next `forge mandate` write. Append only (AGENTS.md here): a new step goes at the end, with a row keyed by
// its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const MANDATE_STEPS: readonly Step[] = [
  // A goal mandate (forge mandate new --goal): the owner's goal, null on every mandate written before it.
  { id: 'mandate-goal', up: (m) => ({ ...m, goal: null }) },
  // A goal mandate's filing (forge mandate draft approve): when its draft was filed, null on every mandate written before it.
  { id: 'mandate-filed', up: (m) => ({ ...m, filedAt: null }) },
  // The mandate's scoring term (#590): every mandate written before it scores all its merged jobs, the default.
  { id: 'mandate-scoring', up: (m) => ({ ...m, scoring: 'all' }) },
];

export const MANDATE_SCHEMA_VERSION = versionOf(MANDATE_STEPS);
