# lib/engine/pipeline/

The pipeline: `forge job step`, agent briefs, review panels, verifiers and the facts they read.

- `step/` is the one decider of transitions (its own map); `step.ts` only re-exports it.
- `moves/` holds the one move (`moveJob`) every caller that needs a move's effects uses (its own map).
- `brief.ts` renders each agent's brief. Briefs carry paths, never file contents, so text an agent wrote never becomes another agent's prompt. A pipeline rule or brief change gets a row per transition in `test/step-rows.ts`.
- `brief.ts` and `step/` count toward the plugin hash (`lib/engine/evals/provenance.ts`), and `brief.ts` is in the default `evals.recall.paths`.
- Design: [Why a CLI does the bookkeeping](../../../docs/architecture/cli-bookkeeping.md), [Job model](../../../docs/architecture/job-model.md), [Policies](../../../docs/architecture/policies.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `acs.ts` | `forge job acs`: which spec acceptance criteria the builder's latest AC table proves. |
| `brief.ts` | Agent briefs for `forge job step`: paths and config-derived lines only, never file contents, so text an agent wrote (after reading tracker or PR text) is never re-injected into another prompt. |
| `findings.ts` | `forge job findings`: review findings raised per round and lens, the builder's answers to them (fixed or disputed), findings that recur, and the finding keys that group them across jobs. |
| `member-panel.ts` | Member review panels: the lenses a member repo of a job defines for itself. |
| `moves/` | How a job moves between stages and states: the one move with its effects, the Foreman's gate policy, dependency waits, the notes a spec approval carries to the builder, the clean pass that moves a job past decide without the approver, and the human-command table a job request is applied by. |
| `panel.ts` | `forge job panel`: this round's review lenses, computed from recorded inputs and the branch diff. |
| `roster.ts` | The agent roster: every role's prompt, the model it runs on, and a content hash of the prompt plus the repo's addendum for that role. |
| `scope.ts` | `forge job scope`: which files a job changed that its spec's Approach never named, and the round diff reviewers read. |
| `step.ts` | `forge job step` lives in lib/engine/pipeline/step/: start at lib/engine/pipeline/step/order.ts, which walks the rule tables in order. |
| `step/` | `forge job step`, the pure decider of the next pipeline action. |
| `types.ts` | What `forge job step` reads and prints, and the verifier shapes, type-only: step/ is at its entry cap, so they live here. |
| `verifiers.ts` | Verifiers: repo-local yes/no checks scoped to file globs, answered by a small model against only the matching hunks, after `forge verify` passes and before any reviewer starts (docs/VERIFIERS.md). |
<!-- forge:map:end -->
