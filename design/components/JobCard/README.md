A job card is a clickable ticked sheet (`space-3` padding, `space-2` column): the title in `card-title` with a `StateChip` at its right, ref and id in `mono` `muted`, `after <id>` dependency chips, the hatched progress bar, one `VerdictChip` per reviewer and a `label`-size footer with the round, the running agent (`ink` dot plus role) and `{tokens} tok · {ago}` at the far right.

Use it only in board columns. A job that needs a person becomes a `redline` sheet with a `REV · <state>` tag instead of a state chip. Clicking anywhere opens the drawer; dependency chips open their own job.

Static rendition in the Drafting direction; replaces `JobCard.svelte` with `DepChips`, `ProgressBar`, `StateChip`, `VerdictChip`, `PrChip`.
