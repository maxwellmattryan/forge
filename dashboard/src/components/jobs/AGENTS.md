# dashboard/src/components/jobs/

A job on the board: its card and table row, the chips, stepper and bar they show, and the effort dropdown.

- A job's state, tones and chip text come from `src/lib/jobs/`; these only lay them out.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `DepChips.svelte` | A board card's `after <ref title \| id>` chips, one per dependency, each truncated to the card's width with the full id in its title. |
| `EffortChip.svelte` | A reasoning effort level as a chip ("High effort"): warn for xhigh and max, which cost the most. |
| `EffortSelect.svelte` | A job's reasoning effort, beside the Permissions dropdown in SessionControls (the job drawer's header): a small button Select naming the level. |
| `JobCard.svelte` | A board card. |
| `JobsTable.svelte` | The pipeline's table layout, in the board's urgency order. |
| `PrChip.svelte` | A job's PR number with its merge, conflict and checks state; nothing without a PR. |
| `ProgressBar.svelte` | tasks.md progress: a bar and done/total; nothing without tasks. |
| `StageStepper.svelte` | A job's place in the pipeline: nine dots in three clusters (Plan, Build, Ship). |
| `StateChip.svelte` | A job's state, or its waiting reason, as a tone chip. |
| `VerdictChip.svelte` | One reviewer's verdict for the current round. |
<!-- forge:map:end -->
