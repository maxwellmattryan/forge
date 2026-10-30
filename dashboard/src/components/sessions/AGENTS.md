# dashboard/src/components/sessions/

Daemon sessions as the board and the drawer show them: activity lines, controls and the Start/Stop toggle, the live dot, the lease chip, running agents and permission prompts.

- A session's state, its agents' activity and its permission prompts come from `src/lib/sessions/`; these only lay them out.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `AgentActivity.svelte` | A job's running agents as `<role> · <model> · running <elapsed> · <last thing>`, newest first. |
| `LeaseChip.svelte` | The owning session's lease as a chip ("lease live · renewed 6s ago"), toned by its liveness; nothing without a lease. |
| `LiveDot.svelte` | The live dot: a lit gleam sphere with a ping halo while a daemon session is working, a hollow dot otherwise. |
| `PermissionPrompts.svelte` | Tool calls daemon sessions are waiting on a human to allow: the whole pool's in the status bar's Needs-you popover, one job's in its Thread, one Foreman session's (named by `name`, which each card and the section's label then carry) in the Foreman popover. |
| `SessionActivity.svelte` | One daemon session's activity line, shared by the board card and the drawer: the live dot and "working · 4s ago", the warn chip "needs permission · 4s ago", or a hollow dot with "waiting" / "idle · 4s ago". |
| `SessionControls.svelte` | One daemon session's controls: in Auto, a flat warning icon (text on the surface, not a button) whose tooltip is the reminder, then the Permissions dropdown, a job's Effort dropdown and, with `toggle`, the Start/Stop icon toggle (SessionToggle), with the session's notes (its last error, a mode switch claude hasn't confirmed) under them, right-aligned. |
| `SessionToggle.svelte` | One daemon session's Start/Stop icon toggle. |
<!-- forge:map:end -->
