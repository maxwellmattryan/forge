A chip is an annotation: the `label`-size mono word in a 1px outline of its own colour, filled with the opaque surface it sits on (`panel` in sheets and overlays, `chrome` in the sidebar, `bg` on the ground and in board columns), so nothing behind it ever shows through. Tones: `ok`, `bad`, `warn`, `info`, `ink`, `muted` (dashed outline), `live` (ink text on an opaque 12% ink tint of its surface: an agent is working), `rev` (a `redline` outline and text: a human is needed) and `hl` (dark text on `highlight`: unsaved or selected).

Use a chip for a job's state (`StateChip`), a reviewer's verdict (`VerdictChip`, the lens name tinted by PASS/CHANGES/pending), a PR's state (`PrChip`), a stage, a round, a non-feature kind, a request status in the thread, a dependency, or a session pill. One or two words, uppercase, never wrapping, never with an icon. A chip that toggles something (the inbox log) is a `<button class="chip">`: it sketches on hover and takes a dashed outline while expanded. The sketch is never inherited, so a hovered card's chips stay plain.

Every tone is the same square-cornered rectangle with the same padding; `rev` differs only in colour. That holds wherever it appears: `StateChip`, `Banner`, `Toast`, the Inbox nav badge and the settings unsaved tag.

Tone meanings are fixed: `rev` is the only chip that means "you"; `live` the only one that means "working now". Every chip clears 4.5:1 on `bg`, `panel` and `chrome`, and on `panel` under the sketch, in both themes.

Static rendition in the Drafting direction; replaces `Chip.svelte` and `TONE_CLASS`.
