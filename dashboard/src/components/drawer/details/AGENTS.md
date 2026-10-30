# dashboard/src/components/drawer/details/

The job panel's Details tab cards: the environment, repos, dependencies, screenshots, Merge now and Delete job cards.

- Each card renders inside the job panel's Details tab and takes the job it shows as a prop; its model lives in `src/lib/jobs/` or the module for its concern.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `DeleteJobSection.svelte` | The drawer's Delete job card, at the foot of Details: for a job started by mistake. |
| `DepSection.svelte` | The drawer's Dependencies card: "Depends on" and "Blocks" rows, each only when non-empty. |
| `EnvironmentSection.svelte` | The drawer's Environment card, for active jobs only: Focus or Unfocus (a pointer, POST /api/focus), Open in editor (the worktree in FORGE_EDITOR on the machine running forge dash), the job's component endpoints (an Open link, the dev server's with a live dot), the dev server row and the backing services list (GET /api/jobs/:id/environment, polled every 5 s while the tab is visible) with their Start, Stop, Restart and Logs controls, and one log viewer at a time. |
| `MergeNowSection.svelte` | The drawer's Merge now card, above Delete job, for a job whose PR is open: a person's override of the merge checks. |
| `RepoSection.svelte` | The drawer's Repos table for a job with member repos: one row per job repo, root first. |
| `ScreenshotsPanel.svelte` | The drawer's Screenshots card: a tile per file in the job's screenshots/ dir, each opening the image in a new tab; nothing without files. |
<!-- forge:map:end -->
