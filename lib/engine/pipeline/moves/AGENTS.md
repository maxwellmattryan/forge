# lib/engine/pipeline/moves/

How a job moves between stages and states: the one move with its effects, the Foreman's gate policy, dependency waits, the notes a spec approval carries to the builder, the clean pass that moves a job past decide without the approver, and the human-command table a job request is applied by.

- `request-table.ts` decides; `forge job apply` (`apply` in lib/cli/commands/job/decide.ts) carries the plan out through the `forge job human` and `forge job set` handlers, in-process. A decision is applied only from a person (`PERSON_SOURCES`), and request text reaches a file only fenced (`fenceImport`), never argv.

- A stage, state or `waitingOn` change that needs effects (environment, the Foreman's gate request, the tracker mirror) goes through `moveJob` (`apply.ts`); `mirrorJob` runs the mirror alone. Notifications follow every transition through setJob's hook list (`lib/core/job/transitions.ts`), whoever writes.
- Only tests call `useMoveEffects`; production always runs `realMoveEffects`.
- `deps.ts` imports nothing from this folder: `lib/engine/workspace/worktree.ts` imports it, and anything more would risk a cycle.
- Import order: `foreman-gates.ts` ← `effects.ts` ← `apply.ts`. `approval-notes.ts` imports nothing from this folder, and `../step/facts.ts` imports it.
- `escalation.ts` is pure and imports nothing from this folder or from `lib/engine/guard/protected.ts`: protected.ts imports it. `gate-reasons.ts` is its I/O half (`forge job gate`).
- Design: [Job model](../../../../docs/architecture/job-model.md), [Foreman](../../../../docs/architecture/foreman.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `apply.ts` | The one move: a locked write of a job's stage, state or waitingOn, then its effects in a fixed order (environment, the Foreman's gate request, the tracker mirror), so every caller gets the same follow-up whoever moves the job. |
| `approval-notes.ts` | Approval notes: a person's spec-approval notes and `forge job note --for builder` hints, rendered from the job's events into approval-notes.md, which the builder brief lists. |
| `clean-pass.ts` | The clean pass: when every lens passed and nothing can escalate, Forge records the APPROVE and renders decision.md and pr.md itself instead of running the approver (approver.skipWhenClean, rule DC13, `forge job decision --clean`). |
| `deps.ts` | Dependencies between jobs (`job.dependsOn`): validation, parking, claim refusal, stacked branches and retargeting. |
| `effects.ts` | A move's effects behind one seam: the environment a finished job leaves, the Foreman's gate request and the tracker mirror. |
| `escalation.ts` | Escalation reasons as data: the one park reason that lists them (`escalation: <rules>`), its parser (today's form and the reasons the merge gates wrote before they collapsed), the `gate` events `forge job gate` logs, and the brief lines that carry them. |
| `foreman-gates.ts` | The Foreman's gate policy: which gate class a job waits on, which classes the Foreman decides, what foreman.reserved and the security, total-round, retro and human-only holds keep with a human, and the `gate` requests a park queues. |
| `gate-reasons.ts` | `forge job gate`: the mechanical reasons a job needs a person before merge (gate reasons), computed from job facts once per review and logged as a `gate` event that DC12, PR19, the briefs and the escalation park read. |
| `request-table.ts` | The human-command table: what one job request (approve, revise-spec, answer, rework, cancel, resume) records on the job it names, as a plan `forge job apply` carries out, and the two files a request's text reaches (feedback.md and the questions.md answer), always fenced as data. |
| `shelve.ts` | The shelf: a person setting a job aside (`forge job shelve`) and taking it off again (`forge job unshelve`, the dashboard's Shelved list). |
<!-- forge:map:end -->
