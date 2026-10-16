An icon is a machined glyph on the 24 grid: `stroke-icon` (1.5px), round caps and joins, every line the same weight, rectangles eased by a 1px radius, rendered inline so it takes the text colour, at `size-icon` (18px) in navigation and 15px in buttons. It is deliberately quiet: the plates, the cuts and the type carry the forge, and the icon only names the thing, the way a stamped marking on an instrument panel does.

Twenty-three names: six views (pipeline, inbox, backlog, agents, analytics, evals), nine settings tabs (general, review, tracker, dashboard, daemon, diagnostics, about plus pipeline and agents again), eight controls (close, command, search, play, stop, refresh, copy, settings) and the two layouts (board, table). The same drawings are in `assets/Icons/` as files.

Colour follows the text: `muted` at rest, `fg` when active, `gleam` on a live control. Never fill a glyph (the `general` knobs are masked with the surface, not filled), never thicken a stroke, never mix weights; add a new icon as one or two paths on the same grid at the same stroke.

Static rendition in the Smithy direction, hand-written from `design/components/Icon/preview.html` and `components/Icon.svelte, lib/icons.ts`.
