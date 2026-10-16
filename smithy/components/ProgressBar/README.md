A progress bar is a bright bar in a dark track: an 8px `line` track, cut at its top-right and bottom-left corners, recessed with a 1px `edge-dark` inset and filled with the surface it sits on, a brushed `gleam` fill (`--gleam-fill-bar`, brightening toward its end, with the specular top line) and `shadow-glow` (the one place sheen glows at rest), and `done/total` in `label`-size mono `muted` numerals.

Use it for a job's `tasks.md` progress on cards and in the drawer; budget rows use the same track with a solid `ok`, `warn` or `bad` fill that does not glow. Never animate the fill or label the track.

Static rendition in the Smithy direction, hand-written from `design/components/ProgressBar/preview.html` and `components/ProgressBar.svelte`.
