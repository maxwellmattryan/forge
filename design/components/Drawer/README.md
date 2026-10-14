The drawer is the job detail sheet: a right-anchored `bg` panel at `size-drawer-max` (768px) with a `line` left edge and `shadow-drawer` (a stacked sheet to its left), over the `backdrop`, padded `space-5` (`space-6` at md) with `space-5` between sections.

Its order is fixed: title in `sheet-title` with the id in `mono` and a close `.btn.icon`; a chip row (stage `ink`, `StateChip`, round `muted`, `PrChip`, kind `info`); the reason; the progress bar; a fact grid (three columns of `label` over `mono` values, links in `ink`); `DepSection`; the verdict matrix and usage tables; the budget sheet; screenshots; then the Files / Timeline / Thread tabs. Escape and the backdrop close it.

Static rendition in the Drafting direction (the top of the drawer); replaces `Drawer.svelte`.
