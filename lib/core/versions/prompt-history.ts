// The prompt history version steps: a `.forge/runtime/permission-prompts.jsonl` line's `v` is
// PROMPT_HISTORY_STEPS' length plus one. Applied on read by lib/office/session/permissions/history.ts
// (readPromptHistory); lines stay as written. Append only (AGENTS.md here): a new step goes at the end,
// with a row keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const PROMPT_HISTORY_STEPS: readonly Step[] = [];

export const PROMPT_HISTORY_VERSION = versionOf(PROMPT_HISTORY_STEPS);
