A KPI tile is a plate (grained, cut) with a `label` (uppercase mono, `muted`), a `kpi-value` (DM Mono 28px, tabular) and a `caption` detail line in `muted`; `space-4` padding, `space-1` gaps.

Use a grid of them (`repeat(3, minmax(0,1fr))`, `space-3` gaps) at the top of Analytics. Values are formatted (`4.2k`, `$12.80`, `38%`, `—`) and never coloured; no sparklines, no trend arrows.

Static rendition in the Smithy direction, hand-written from `design/components/Kpi/preview.html` and `views/Analytics.svelte (kpi)`.
