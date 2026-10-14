A nav item is a `nav`-style row (Plex Mono 13px uppercase, .06em) in `muted` with its icon at `size-icon`, a transparent 1px border and `space-2.5`/9px inset. Hover hatches the row and shows a `line-soft` border; the active item takes a `line-strong` border, a `raised` wash and a 3px `ink` rule on its left edge. Focus is a dashed outline.

Use it for the six views in the sidebar, the nine settings tabs in the dialog's rail and the Settings button at the sidebar's foot (the ⌘K button is in the page header; see PageHeader). Badges sit at the right: the pipeline's active count in `muted` mono, the inbox's needs-you count as a `rev` chip. One active item per list.

Static rendition in the Drafting direction; replaces `.nav-item` and `Nav.svelte`.
