The session log is a control row (status chip, turns and cost in mono `muted`, Start/Stop, a search input, Tools/Thinking/Subagents checks, a Rendered/Raw `seg`, Follow and Load older) above an outlined pane in `mono-log` with a sticky turn heading per turn, filled with `panel` so lines scroll under it. Items are chip-tagged lines, `details` blocks for tool calls (`→ name` in `ink`, summary in `muted`, input and result as `pre` inside a `line-soft` box) and `info`-outlined blocks for subagents; errors are a `bad` chip and `bad` text.

Use it in the drawer's Thread and, compact (288px), under the daemon bar for the inbox. All text is untrusted output: assistant text, thinking and a subagent's prompt and report render as `prose compact` only through the escape-first `md()` (as text in Raw); tool input, results and every other line render as text.

Static rendition in the Drafting direction; replaces `SessionLog.svelte`.
