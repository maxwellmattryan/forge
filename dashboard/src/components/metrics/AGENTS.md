# dashboard/src/components/metrics/

Usage and cost: a job's budget chip, cell and panel, Analytics' period meter, the Overview's stacked bars and the Evals compare table.

- The figures, limits and tones these show come from `src/lib/metrics/`; these only lay them out.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `BudgetCell.svelte` | The jobs table's Budget cell: the budget chip when there is one, else the worst row's muted percent, else a dash. |
| `BudgetChip.svelte` | A board card's budget chip: `budget N%` at 80% of a limit, `over budget` past it, with the worst row in its title; nothing below 80%, or for a finished job or one already waiting on its budget. |
| `BudgetPanel.svelte` | A job's budget, one row per limit: used / limit with a bar in the row's tone. |
| `CompareTable.svelte` | The Evals compare result: config and version line, then one row per metric. |
| `PeriodMeter.svelte` | Analytics' period meter: repo spend this UTC month against the effective budget.usdPerMonth, remaining and the projected month-end, with today's spend against usdPerDay underneath. |
| `StackedBars.svelte` | The Overview's stacked bars: one column per UTC day, stacked by project in its series colour, each column titled with its day and every project's value; then the legend table with each project's swatch, total, share and any error reading its stats. |
<!-- forge:map:end -->
