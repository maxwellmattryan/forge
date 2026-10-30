# dashboard/src/components/shell/statusbar/

The status bar's popover bodies: Needs you with its Shelved and Timed out lists, Workers, the Foreman, the inbox session, Models and Connection.

- Each renders inside `ui/overlay/Popover.svelte`, opened from `../StatusBar.svelte`; which one is open lives in `src/lib/ui/overlay/popover.svelte.ts`.
- Design: [Working on the dashboard](../../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `ConnectionPanel.svelte` | The Connection popover's body: what the last /api/state poll said, both API versions, when data last arrived, the error when offline or outdated, and Retry now. |
| `ForemanPanel.svelte` | The Foreman popover's body. |
| `InboxPanel.svelte` | The Inbox popover's body: the inbox session, which handles requests that belong to no job. |
| `ModelPanel.svelte` | The Models popover's body, read-only: the builder's summary, one row per configured role and one per review lens (GET /api/roster, fetched each time it opens). |
| `NeedsPanel.svelte` | The Needs-you popover's body (the page it replaced): every pending permission prompt in the pool, answered right here, the collapsed Timed out list (TimedOutPrompts: prompts denied because nobody answered in time, not counted), then decisions only a human can make (goal mandates' milestone drafts first, then jobs), PRs awaiting review (each row's actions follow why it waits, prActions: Re-run failed checks and Fix CI post to /api/jobs/:id/ci at the head the row shows, Address the PR feedback queues the fixed-text rework, and a PR with neither offers only Open PR), jobs parked on their dependencies (listed apart: they resume by themselves, but a human may unblock one), the Shelved list (ShelfSection: jobs a person set aside, not counted in the badge), and queued requests (a job-less one names its mandate when it has one). |
| `ShelfSection.svelte` | The Needs-you popover's Shelved list: the jobs a person set aside, which block nothing and don't count as waiting on you. |
| `TimedOutPrompts.svelte` | The Needs-you popover's Timed out list, collapsed: the tool calls the supervisor denied because nobody answered their prompt within daemon.permissionTimeoutMinutes, newest first, from every pool session's last 10. |
| `WorkersPanel.svelte` | The Workers popover's body: the daemon pool and its job sessions. |
<!-- forge:map:end -->
