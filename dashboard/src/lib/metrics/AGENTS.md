# dashboard/src/lib/metrics/

Usage and cost: the Analytics, Evals and Overview pages, per-job and repo budgets, and agent runs' billing.

- `budget.ts` and `repo-budget.ts` mirror the engine's `lib/engine/metrics/` rules, because the dashboard can't import `lib/`: change both sides together.
- Tool and MCP server names come from transcripts: they stay plain strings the components render as text.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `agent-runs.ts` | The Agents tab's runs panel as plain parts: each agent run's billing split and context composition as bar segments with their tokens and share, and the run's duration and status tone. |
| `analytics.ts` | The Analytics and Evals pages: the stats query, KPI lines, usage bars, top jobs and the eval compare table. |
| `budget.ts` | Per-job budget use, derived client-side from fields /api/state already serves. |
| `overview.ts` | The Overview page: project cards sorted by what waits on you, and the stacked bars of jobs shipped and cost per UTC day across projects (GET /api/projects/stats). |
| `repo-budget.ts` | The repo budget's numbers for the Analytics meter and the Needs-you section, from /api/state.budget (repoBudgetStatus in lib/engine/metrics/repo-budget.ts). |
<!-- forge:map:end -->
