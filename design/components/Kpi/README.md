A KPI tile is a ticked sheet with a `label` (uppercase mono, `muted`), a `kpi-value` (Plex Mono 24px, tabular) and a `caption` detail line in `muted`; `space-4` padding, `space-1` gaps.

Use a grid of them (`repeat(3, minmax(0,1fr))`, `space-3` gaps) at the top of Analytics. Values are formatted (`4.2k`, `$12.80`, `38%`, `—`) and never coloured; no sparklines, no trend arrows.

Static rendition in the Drafting direction; replaces the `kpi` utility.
