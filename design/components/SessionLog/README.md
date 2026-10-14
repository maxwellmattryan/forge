The session log is a control row (status chip, turns and cost in mono `muted`, Start/Stop, a search input, Tools/Thinking/Subagents checks, Follow and Load older) above an outlined pane in `mono-log` with a sticky turn heading per turn. Items are chip-tagged lines, `details` blocks for tool calls (`→ name` in `ink`, summary in `muted`, input and result as `pre` inside a `line-soft` box) and `info`-outlined blocks for subagents; errors are a `bad` chip and `bad` text.

Use it in the drawer's Thread and, compact (288px), under the daemon bar for the inbox. All text is untrusted output rendered as text.

Static rendition in the Drafting direction; replaces `SessionLog.svelte`.
