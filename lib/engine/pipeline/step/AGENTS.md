# lib/engine/pipeline/step/

`forge job step`, the pure decider of the next pipeline action. Start at `order.ts`, which walks the rule tables in order (`step()`, `TABLES`).

- `input.ts` is the only reader of disk and clock (`loadStepInput`); every other file here is pure.
- A new rule is a row in `stages/<stage>.ts` or `gates.ts`, its ID in `RULES` (`rules.ts`), a row per transition in `test/step-rows.ts`, and the pinned order in `test/step-tables.test.ts`.
- Each file's row below is the first sentence of its header comment: edit that, then run `npm run docs:map`.
- Design: [Job model](../../../../docs/architecture/job-model.md), [Why a CLI does the bookkeeping](../../../../docs/architecture/cli-bookkeeping.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `actions.ts` | The actions a rule returns. |
| `answered.ts` | GA1–GA11: a gate a logged `human` decision (a person's or the foreman's) answered. |
| `facts.ts` | What step reads off a StepInput: agent records, events and the facts derived from them, whether a rework spawn resumes its role's last session, and the park reason NP1b writes for a prompt nobody answered in time, with its parser (brief.ts reads it without the step rows). |
| `gates.ts` | The gates that run before the stage rules (secret scan, protected paths, repo proposals, downstream verification), the open rules of the one escalation park (openEscalation), and what step tells a human at a gate. |
| `generic.ts` | The per-role rows every stage shares (NP1, NP1b, N1, N1b, N2, M1, M2) and the X1 fallback. |
| `global.ts` | The rows that run before any stage: finished jobs, parks, running agents, lost runs, and the retro kind's own start. |
| `input.ts` | loadStepInput: the one place `forge job step` reads disk. |
| `order.ts` | `forge job step`: the one decider of pipeline transitions, the way the CLI is already the one writer of state. |
| `panel.ts` | The review panel, the lenses each round reviews and the brief lines built from review history: pure helpers step, `forge job panel` and loadStepInput share. |
| `recall.ts` | The recall eval's facts: decide runs it before the approver (RC1), the pr table holds the merge without a record (PR17), and the approver's `Reviewer recall:` line reads them too, so they live apart from both tables and the brief: pure functions of the StepInput. |
| `rules.ts` | The rule IDs of `forge job step` and the shape of its tables. |
| `stages/build.ts` | Build: open a round, hold it to the round limits, run the builder, then verify. |
| `stages/decide.ts` | Decide: the gate reasons (DC12), then the approver (Forge's own APPROVE on a clean pass; for an eval, the judge and the grade), then on to integrate and pr. |
| `stages/design.ts` | Design: the designer writes design.md, the spec-writer folds its spec deltas in, then back to spec. |
| `stages/intake.ts` | Intake (backlog): find an issue, create the worktree, adopt a PR and act on what it says, then plan or spec. |
| `stages/integrate.ts` | Integrate: bring the branch up to date with its base, resolve conflicts per pr.conflicts, and review the resolution before the approver or the PR. |
| `stages/plan.ts` | Plan: the planner decides one job or a split, and a split waits on a human unless split is auto. |
| `stages/pr.ts` | PR: verify, open or update the PR (unless the push is held), follow interim deferrals and releases, then hold the merge on an open merge gate (the one escalation park listing every open rule, then a missing recall eval) until a person decides, merge, or wait on review. |
| `stages/review.ts` | Review: pick the panel, write the scope report, run the lenses, record their verdicts, move on. |
| `stages/spec.ts` | Spec: the spec-writer writes spec.md (or proposes a split for the planner), step records the panel, then the spec gate and the issue link. |
| `stages/verify.ts` | Verify: run the checks, then the repo's verifiers when it has some, then review or back to build. |
<!-- forge:map:end -->
