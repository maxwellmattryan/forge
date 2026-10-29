# dashboard/src/lib/sessions/

The daemon pool's sessions: pills and the pool summary, permission prompts, the Agents page, what a job's agents are doing, and the live board.

- Session state, errors, prompts and transcript text are untrusted: these return plain strings the components render as text.
- Each file is the pure half of its components, so node:test can pin it.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `agent-activity.ts` | What a job's running agents are doing, as plain parts AgentActivity.svelte and the drawer's Agents tab render as text: `<role> · <model> · running <elapsed> · <last thing>`, the owner's liveness, and the round's agent rows. |
| `agents.ts` | The Agents page: the agents running now and the sessions driving jobs. |
| `daemon.ts` | The status bar's Workers and Inbox popovers' and the session log's pure, DOM-free half: session pills, the pool summary and POST /api/daemon. |
| `live.ts` | The live board's pure half: what each daemon session is doing, which jobs just changed, and the shared clock's visibility-aware interval. |
| `permissions.ts` | Permission prompts from daemon sessions: the pure half of PermissionPrompts.svelte, TimedOutPrompts.svelte and POST /api/daemon/permission. |
<!-- forge:map:end -->
