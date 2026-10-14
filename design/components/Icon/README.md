An icon is a 24-grid line drawing at `stroke-icon` (1.25px), round caps and joins, rendered inline so it takes the text colour, at `size-icon` (18px) in navigation and 15px in buttons. Most glyphs keep a trace of their construction: a dashed pitch circle on the cog, a centre line on the chart, a construction circle around the close and plus marks, drawn at 60% opacity with a 2/2 dash (`.cx`).

Twenty-three names: six views (pipeline, inbox, backlog, agents, analytics, evals), nine settings tabs (general, review, tracker, dashboard, daemon, diagnostics, about plus pipeline and agents again), eight controls (close, command, search, play, stop, refresh, copy, settings) and the two layouts (board, table). The same drawings are in `assets/Icons/` as files.

Colour follows the text: `muted` at rest, `fg` when active, `ink` on a live control. Never fill a glyph, never thicken a stroke; add a new icon as one path on the same grid with its own construction mark.

Static rendition in the Drafting direction; replaces `Icon.svelte` and `lib/icons.ts`.
