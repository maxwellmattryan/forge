# dashboard/src/components/jobs/

A job on the Pipeline: its board card and table row, the chips, stepper and bar they show, the effort dropdown, and the graph layout's plates and node blocks.

- A job's state, tones and chip text come from `src/lib/jobs/`, and the graph's model from `src/lib/project/pipeline-graph.ts`; these only lay them out.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `DepChips.svelte` | A board card's `after <ref title \| id>` chips, one per dependency, each truncated to the card's width with the full id in its title. |
| `EffortChip.svelte` | A reasoning effort level as a chip ("High effort"): warn for xhigh and max, which cost the most. |
| `EffortSelect.svelte` | A job's reasoning effort, beside the Permissions dropdown in SessionControls (the job drawer's header): a small button Select naming the level. |
| `GraphBlock.svelte` | One block of the Pipeline graph (lib/project/pipeline-graph.ts): a box of the block's size in its own sideways scroller, its edges as an aria-hidden SVG behind the nodes (dashed until the upstream merges, a heat run while `hot` holds the edge, hidden under reduced motion), then one button per node in layout order, so Tab walks it by column and row. |
| `JobCard.svelte` | A board card. |
| `JobsTable.svelte` | The pipeline's table layout, in the board's urgency order. |
| `PipelineGraph.svelte` | The Pipeline's Graph layout (issue #714): a plate per open mandate, its plan's issues by dependency depth with each live job on its issue, then a "No mandate" plate of the other jobs as dependsOn chains and lone nodes. |
| `PrChip.svelte` | A job's PR number with its merge, conflict and checks state; nothing without a PR. |
| `ProgressBar.svelte` | tasks.md progress: a bar and done/total; nothing without tasks. |
| `StageStepper.svelte` | A job's place in the pipeline: nine dots in three clusters (Plan, Build, Ship). |
| `StateChip.svelte` | A job's state, or its waiting reason, as a tone chip. |
| `VerdictChip.svelte` | One reviewer's verdict for the current round. |
<!-- forge:map:end -->
