The daemon bar is a plain sheet strip (`space-4`/`space-2.5` inset) summarising the session pool in one wrapping row: a pool chip, the inbox chip (a button; dashed outline while its log is expanded), the live count in mono `muted`, held and waiting as `warn` chips, one `ink`/`info` chip per live job (`id · state`), the last error truncated in `muted`, and Start/Stop `.btn.sm` at the right.

It hides itself when there is nothing to show; job chips open the drawer on its Thread; the inbox chip expands a compact `SessionLog` under a `line` rule.

Static rendition in the Drafting direction; replaces `DaemonBar.svelte`.
