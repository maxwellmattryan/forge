# dashboard/src/lib/logs/

Session logs: one raw line parsed, lines grouped into turns, a session's or a chat's log streamed, a station's lamp, and who a line comes from.

- Every log line is session output, i.e. untrusted text: these return plain strings and never build markup. Prose reaches the page only through `md()`.
- `daemon-log.ts` and `chat-log.ts` stay DOM-free so node:test can drive them with a fake `EventSource` and `fetch`.
- Design: [Working on the dashboard](../../../AGENTS.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `chat-log.ts` | One chat's log data: GET /api/chats/<id>/log paged forward from the start, then /api/events?session=_chat-<id> for live updates. |
| `daemon-log.ts` | One session log's data: the latest history page, then /api/events?session=<scope> for live lines, merged by offset, with older pages on demand. |
| `sender.ts` | Who a Thread message or a session log line comes from, and how it shows at a glance: the log's faint tint, and each Thread sender's own colour and icon. |
| `session-log.ts` | A session log's structure, built from its raw lines (parsed by session-parse.ts): turns, text, thinking, tool calls with their results, subagents grouped by parent_tool_use_id, background task progress folded into the call it reports on, results, stderr and the supervisor's own events; plus the log pane's filters and follow rule. |
| `session-parse.ts` | One session log line, parsed: what a raw line of claude's stream (or a Claude Code transcript, or the supervisor's own events) says, before session-log.ts groups it into turns. |
| `station.ts` | A station terminal's life (SessionLog, EnvironmentLog, the status bar's lamps): the pilot lamp and when a line counts as live output. |
<!-- forge:map:end -->
