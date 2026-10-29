# dashboard/src/lib/project/

The project around the jobs: its graph, environments and focus, and the Issues page.

- `focus.ts` also holds `post`, the shared JSON POST helper the gates, office and shell folders import.
- Environment log lines are untrusted text: they only ever reach `{line}`.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `backlog.ts` | The Issues view's readiness column, kept here so it is tested without the Svelte compiler. |
| `environment.ts` | A job's environment as the dashboard shows it (issue #199): the Environment card's dev server row, backing services list and log viewer, and the Project page's Running environments section, over the routes in lib/server/routes/environment.ts. |
| `focus.ts` | Focus and a job's environment as the dashboard shows them: the status bar's focus fact, the drawer's Environment section's header, and the POSTs behind it (lib/server/routes/). |
| `graph.ts` | The Project view's graph logic (issue #175): a deterministic layered layout of GET /api/project, the highlight of a job's components and their downstream consumers, and the job selector's options with where each job's list came from (the diff or the spec) and why an unmatched one is empty. |
| `issue-view.ts` | The issue panel's model, kept here so it is tested without the Svelte compiler: the jobs that name an Issues item, which of them holds it, and whether Start is offered. |
<!-- forge:map:end -->
