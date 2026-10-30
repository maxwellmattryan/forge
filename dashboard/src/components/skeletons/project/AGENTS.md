# dashboard/src/components/skeletons/project/

The Project, Pipeline, Issues and Agents pages' loading shapes.

- Bones only, shaped like the real page, wrapped in one `Loading`.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `AgentsSkeleton.svelte` | The Agents view's shape while the project's first state loads (App.svelte). |
| `IssuesSkeleton.svelte` | The Issues view's shape while the project's first state loads (App.svelte). |
| `IssuesTableSkeleton.svelte` | The Issues table's shape while the backlog loads: the real column headers over rows of bones. |
| `PipelineSkeleton.svelte` | The Pipeline view's shape while the project's first state loads (App.svelte): the header with its filter and layout toggles, then the four stage columns, each holding a few card-shaped plates. |
| `ProjectEnvironmentsSkeleton.svelte` | The Project view's environments table while GET /api/environments loads: the real column headers, a few bone rows. |
| `ProjectGraphSkeleton.svelte` | The Project view's component graph while it loads: the job picker and legend rows around a plate of node-shaped bones in bands. |
| `ProjectSkeleton.svelte` | The Project view's shape while the project's first state loads (App.svelte). |
<!-- forge:map:end -->
