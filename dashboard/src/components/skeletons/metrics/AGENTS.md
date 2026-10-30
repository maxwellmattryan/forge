# dashboard/src/components/skeletons/metrics/

The Analytics and Evals pages' loading shapes.

- Bones only, shaped like the real page, wrapped in one `Loading`.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `AnalyticsPeriodMeterSkeleton.svelte` | The period meter's shape while the budget loads: title row, spend figure, track, remaining/projected line and today's meter. |
| `AnalyticsSkeleton.svelte` | The Analytics view's shape while the project's first state loads (App.svelte). |
| `AnalyticsStatsSkeleton.svelte` | The windowed stats body's shape while /api/stats loads: the KPI grid, the three usage tables, the lens table, the top-jobs table and the footnote. |
| `EvalsBodySkeleton.svelte` | The Evals body while its data loads: the run form plate, the five KPI tiles and the runs table. |
| `EvalsSkeleton.svelte` | The Evals view's shape while the project's first state loads (App.svelte). |
<!-- forge:map:end -->
