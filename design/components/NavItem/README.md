A nav item is a `nav`-style row (Plex Mono 13px uppercase, .06em) in `muted` with its icon at `size-icon`, a transparent 1px border and `space-2.5`/9px inset. Hover shows a `line-soft` border and sketches the row (1px `sketch-line` lines at 45° that fade in and slide into place over 160 ms, only where the pointer can hover); the active item takes a `line-strong` border, a `raised` wash and a 3px `ink` rule on its left edge. Focus is a dashed outline.

Use it for the six views in the sidebar, the nine settings tabs in the dialog's rail, the ⌘K button (dashed, with a `kbd` hint) and the Settings button at the sidebar's foot. Badges sit at the right: the pipeline's active count in `muted` mono, the inbox's needs-you count as a `rev` chip. One active item per list.

Static rendition in the Drafting direction; replaces `.nav-item` and `Nav.svelte`.
