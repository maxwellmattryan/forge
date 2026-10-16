A table is `.tbl` inside a plate: `label`-style headers over a `line` rule, cells `space-3`/`space-2` inset over `line-soft` rules, numbers right-aligned and tabular, a title in `card-title` with its ref in `mono` `muted` beneath, chips inline, `—` for empty. A clickable row washes with `raised` on hover, at once.

Use it for the pipeline's table layout, verdict matrices, usage and lens stats. In the pipeline table the title is a `<button>`, so Tab plus Enter opens the drawer (a click anywhere else on the row does too); the Stage cell is the card's stepper followed by the stage and round (`Review · round 2/3`), so there is no separate Round column; and rows follow the board's urgency order. No zebra stripes, no sticky headers, no sort affordances; wide tables scroll inside the plate.

Static rendition in the Smithy direction, hand-written from `design/components/Table/preview.html` and `components/JobsTable.svelte`.
