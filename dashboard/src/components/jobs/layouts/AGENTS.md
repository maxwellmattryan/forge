# dashboard/src/components/jobs/layouts/

The Pipeline's Graph and Table layouts: the graph's plates and node blocks, and the table with its filter row.

- A job's state, tones and chip text come from `src/lib/jobs/`, and the graph's model from `src/lib/project/pipeline-graph.ts`; these only lay them out.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `GraphBlock.svelte` | One block of the Pipeline graph (lib/project/pipeline-graph.ts): a box of the block's size in its own sideways scroller, its edges as an aria-hidden SVG behind the nodes (dashed until the upstream merges, a heat run while `hot` holds the edge, hidden under reduced motion), then one button per node in layout order, so Tab walks it by column and row. |
| `JobsTable.svelte` | The pipeline's table layout. |
| `JobsTableFilters.svelte` | The Pipeline table's filter row: a search over ref, id and title, one removable chip per filter, + Filter offering the mandates, states and stages present among the table's jobs (src/lib/jobs/board.ts filterChoices), and the Group by mandate toggle when some job has a mandate. |
| `PipelineGraph.svelte` | The Pipeline's Graph layout (issue #714): a plate per open mandate, its plan's issues by dependency depth with each live job on its issue, then a "No mandate" plate of the other jobs as dependsOn chains and lone nodes. |
<!-- forge:map:end -->
