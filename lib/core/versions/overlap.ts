// The overlap report version steps: a `forge overlap` report's `schemaVersion`
// (`.forge/runtime/overlap/jobs/<id>.json`, `.forge/runtime/overlap/prs/<n>.json`) is this list's length plus one.
// Applied on read by lib/engine/project/overlap.ts (readOverlapReport); a file is rewritten only by the next
// `forge overlap`. Append only (AGENTS.md here): a new step goes at the end, with a row keyed by its id in
// test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const OVERLAP_STEPS: readonly Step[] = [];

export const OVERLAP_SCHEMA_VERSION = versionOf(OVERLAP_STEPS);
