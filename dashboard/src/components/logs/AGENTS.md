# dashboard/src/components/logs/

Session and environment logs as the station shows them: a session's log and its items, an environment's log and the pilot lamp.

- Session log lines are untrusted: supervisor, stderr, tool input and result lines render as text, and assistant prose renders only through `md()`.
- Parsing and grouping lines lives in `src/lib/logs/`.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `EnvironmentLog.svelte` | The Environment card's log viewer: one source (`dev`, or `backing:<name>`) followed live from /api/jobs/:id/environment/logs. |
| `Lamp.svelte` | A pilot lamp (src/lib/logs/station.ts LampState): decorative, so aria-hidden; the pill or text beside it carries the meaning. |
| `LogItem.svelte` | One session log item, as SessionLog and a chat's replies (office/chats/ChatView.svelte) show it: text, collapsed thinking, tool calls with their input and result, sub-agent runs nesting their own items (this component, recursively), and every other line kind as one tagged line. |
| `SessionLog.svelte` | One session's structured log (a job's, or the inbox's in the status bar's Inbox popover): one compact control row (status facts, then SessionControls' Permissions and Effort dropdowns and Start/Stop toggle, the Filter button, the rendered/raw icon toggle, Follow and Load older; the filters sit in a MenuButton popover), and turns with tool calls and subagents, followed live. |
<!-- forge:map:end -->
