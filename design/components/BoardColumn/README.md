A board column is a `size-board-column` (276px) dashed sheet, no ticks and no fill (it is a container): a header with the stage in `label` `fg` and its count in mono `muted` over a dashed rule, then a `space-2` column of job cards with `space-2.5` padding. An empty column shows a centred `—`.

Use one per stage that has jobs, in a horizontally scrolling row with `space-3` gaps; columns cap at the viewport height minus the header and scroll inside. Stages keep the pipeline's order; headers are never coloured.

Static rendition in the Drafting direction; replaces the board section of `views/Pipeline.svelte`.
