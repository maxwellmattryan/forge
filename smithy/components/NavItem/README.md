A nav item is a `nav`-style row (DM Mono 13px uppercase, .04em) in `muted` with its icon at `size-icon`, a transparent 1px seam, cut `radius-nick` at the top-right and bottom-left corners, and `space-2.5`/9px inset. Hover warms the row: a 40% `gleam` seam and a 10% gleam tint over its own fill, only where the pointer can hover. The active item takes a `line` seam, a `raised` wash, the bevel and a 3px `gleam` rule down its left edge. Focus is the solid 2px ring.

Use it for the six views in the sidebar, the nine settings tabs in the dialog's rail and the Settings button at the sidebar's foot (the palette's input sits above the nav; see Sidebar). Badges sit at the right: the pipeline's active count in `muted` mono, the inbox's needs-you count as a `you` chip. One active item per list.

Static rendition in the Smithy direction, hand-written from `design/components/NavItem/preview.html` and `components/Nav.svelte (.nav-item)`.
