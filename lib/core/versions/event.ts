// The event version steps: an events.jsonl line's `v` is this list's length plus one. Applied on
// read; files stay as written. Append only (AGENTS.md here): a new step goes at the end, with a row
// keyed by its id in test/schema.test.ts.
import { versionOf } from './steps.ts';
import type { Step } from './steps.ts';

export const EVENT_STEPS: readonly Step[] = [
  // v2 makes `actor` an object `{ login, source }`. A v1 `human` event recorded only "human" or
  // "foreman" (or nothing, before the field existed); other v1 events had no actor at all.
  { id: 'actor-object', up: (e) => {
    if (e.type !== 'human') return e;
    if (e.actor === 'foreman') return { ...e, actor: { login: null, source: 'foreman' } };
    if (e.actor === undefined || e.actor === 'human') return { ...e, actor: { login: null, source: 'unknown' } };
    return e;
  } },
  // v3 adds pluginHash, promptHash and configHash to agent-start (lib/engine/evals/provenance.ts); a v2 start
  // simply has none, and readers treat it as unrecorded.
  { id: 'agent-start-provenance', up: (e) => e },
  // v4 adds autoMerge, head and heads to `decision` (forge job decision binds it to the worktree HEAD).
  // A v3 decision has none of them, and readers (lib/engine/pr/eligible.ts) treat it as not eligible.
  { id: 'decision-head', up: (e) => e },
  // v5 lets an actor's `source` be `daemon` (a daemon session's action); an older Forge reads it as `unknown`.
  { id: 'actor-source-daemon', up: (e) => e },
];

export const EVENT_SCHEMA_VERSION = versionOf(EVENT_STEPS);
