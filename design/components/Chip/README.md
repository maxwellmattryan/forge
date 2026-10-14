A chip is an annotation: the `label`-size mono word in a 1px outline of its own colour, no fill. Tones: `ok`, `bad`, `warn`, `info`, `ink`, `muted` (dashed outline), `live` (ink text over hatching: an agent is working), `rev` (a `redline` outline and text: a human is needed) and `hl` (dark text on `highlight`: unsaved or selected).

Use a chip for a job's state (`StateChip`), a reviewer's verdict (`VerdictChip`, the lens name tinted by PASS/CHANGES/pending), a PR's state (`PrChip`), a stage, a round, a non-feature kind, a request status in the thread, a dependency, or a session pill. One or two words, uppercase, never wrapping, never with an icon. A chip that toggles something (the inbox log) is a `<button class="chip">` and takes a dashed outline while expanded.

Every tone is the same square-cornered rectangle with the same padding; `rev` differs only in colour. That holds wherever it appears: `StateChip`, `Banner`, `Toast`, the Inbox nav badge and the settings unsaved tag.

Tone meanings are fixed: `rev` is the only chip that means "you"; `live` the only one that means "working now". Every chip clears 4.5:1 against the sheet in both themes.

Static rendition in the Drafting direction; replaces `Chip.svelte` and `TONE_CLASS`.
