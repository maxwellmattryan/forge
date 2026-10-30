# dashboard/src/components/drawer/

The drawer: its shell, the job panel and the issue panel, and the job panel's header controls, Agents tab and Thread.

- `DrawerShell.svelte` owns the drawer's width, backdrop and closing for both panels; `JobPanel.svelte` and `IssuePanel.svelte` render inside it. The job panel's tabs and width rules live in `src/lib/jobs/drawer.ts`.
- `JobPanel.svelte` holds the one sandboxed mockup `<iframe>` and renders markdown only through `{@html md(…)}`; the dashboard invariants pin both to this file.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `AgentRuns.svelte` | The Agents tab's runs panel for one role: every ended agent run, oldest first, with its billing split and, when recorded, the estimated context composition at its last request, each as a stacked bar and a legend of tokens and shares. |
| `AgentsTab.svelte` | The drawer's Agents tab: the current round's agents (plus any still running), newest first, and the chosen agent's Claude Code transcript below the list, followed live while it runs. |
| `CommandTrigger.svelte` | "Command for this job" in the drawer header: opens the command palette scoped to `job`. |
| `DrawerShell.svelte` | The drawer's shell, which the job panel and the issue panel share: it slides in from the right over a backdrop, over the whole viewport height (the status bar included), and the view keeps its centred width underneath. |
| `IssuePanel.svelte` | The issue panel, inside the drawer's shell (DrawerShell.svelte, shared with the job panel): an Issues item's text and facts beside the Forge work on it. |
| `JobPanel.svelte` | The job panel, inside the drawer's shell (DrawerShell.svelte, shared with the issue panel). |
| `ThreadLive.svelte` | The Thread's live line, pinned under the conversation: the newest running agent as `<role> · running <elapsed> · <last thing>` (with `+N more`), else the session's state and age, and the job's cost so far. |
| `ThreadPanel.svelte` | A job's Thread in the drawer: its request and the requests about it with the session's replies. |
| `TriageMissing.svelte` | What readiness triage found missing from an item, as one muted line: the Issues row and the issue panel share it. |
| `details/` | The job panel's Details tab cards: the environment, repos, dependencies, screenshots, Merge now and Delete job cards. |
<!-- forge:map:end -->
