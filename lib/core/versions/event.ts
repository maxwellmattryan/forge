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
  // v6 adds actor (on every pr-merged, not only --now), scope and via to pr-merged, and reason
  // superseded to pr-merge-refused; an older pr-merged without --now has no actor, and readers treat
  // it as unrecorded.
  { id: 'merge-provenance', up: (e) => e },
  // v7 adds metered and unmeasured to agent-end (forge job agent end in a daemon session). An older agent-end has
  // neither, and readers (lib/engine/metrics/spend.ts) treat its usage as reported and not covered by any meter.
  { id: 'agent-end-metering', up: (e) => e },
  // v8 lets an actor's `source` be `chat` (an action a chat session took for the owner); an older Forge reads it as `unknown`.
  { id: 'actor-source-chat', up: (e) => e },
  // v9 adds the `shelved` and `unshelved` events, `waitingOn: shelved` in transitions, and the person's
  // actor on a transition their grant made (a job finished while shelved put back to work); an older
  // Forge reads them as generic events.
  { id: 'shelve-events', up: (e) => e },
  // v10 adds the `components` event (forge verify's recompute of a job's components from its diff:
  // declared, components, added, dropped, sha); an older Forge reads it as a generic event.
  { id: 'components-event', up: (e) => e },
  // v11 adds the `senior-pass` event ({ gate, first }, the Foreman's actor): the gate runner's once-per-park marker
  // under foreman.escalations: foreman. An older Forge reads it as a generic event.
  { id: 'senior-pass', up: (e) => e },
  // v12 adds the `retro-scope` event ({mandate}): `forge retro prepare --mandate` records a mandate retro's scope
  // on its job; an older Forge reads it as a generic event.
  { id: 'retro-scope-event', up: (e) => e },
  // v13 lets an actor's `source` be `launch` (the `daemon-mode` audit event `forge dash --permission-mode` writes for each
  // project it loads); an older Forge reads it as `unknown`.
  { id: 'actor-source-launch', up: (e) => e },
  // v14 adds `ci-rerun` {head, runs, jobs, checks} and `ci-rerun-failed` {head, cause, checks}; an older Forge reads them as
  // generic events.
  { id: 'ci-rerun-events', up: (e) => e },
  // v15 adds the `push-held` event ({ kind, reason, head, paths? }): `forge pr open` held the push (CI config,
  // a security review that isn't PASS, reported secrets) and step's PR13 parks on its reason. An older Forge
  // reads it as a generic event.
  { id: 'push-held-event', up: (e) => e },
  // v16 adds the `pr-gate` event ({ action: set | clear | none, rule, waitingOn, reason, number, label, labeled, body,
  // error? }): `forge pr gate` synced the PR's gate section and label; step's PR14 and PR18 read it. An older Forge
  // reads it as a generic event.
  { id: 'pr-gate-event', up: (e) => e },
  // v17 lets `ci-rerun` carry an `actor`: a person's Re-run failed checks (`forge pr rerun` or the dashboard), which
  // sync treats as that head's re-run. One without an actor is sync's own; an older Forge reads it as sync's.
  { id: 'person-ci-rerun', up: (e) => e },
  // v18 adds the `permission-timed-out` event ({tool}): the supervisor denied a job session's permission prompt nobody
  // answered within daemon.permissionTimeoutMinutes. An older Forge reads it as a generic event.
  { id: 'permission-timed-out-event', up: (e) => e },
  // v19 adds the `context-session` event ({role: 'context', session, round, agent, model, status, reason, usage}) and
  // `context` ({mode, session, reason, firstRead}) on a role run's `agent-end`; an older Forge reads the event as generic
  // and ignores the field.
  { id: 'context-session-event', up: (e) => e },
  // v20 adds the `builder-note` event ({ note, actor }): `forge job note --for builder` logs a person's hint for the
  // job's builder, which approval-notes.md renders. An older Forge reads it as a generic event.
  { id: 'builder-note-event', up: (e) => e },
];

export const EVENT_SCHEMA_VERSION = versionOf(EVENT_STEPS);
