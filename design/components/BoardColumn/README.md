A board column is a sheet drawn dashed, no ticks and no fill (it is a container, so the grid shows between its cards): a `plain` header row (text never sits on the grid) with the group in `label` `fg` and its count in mono `muted` over a dashed rule (an open column puts *N working* in `label` `ink` before the count while N of its jobs have a busy daemon session; Done never does), then a `space-2` column of job cards with `space-2.5` padding. An empty column shows a centred `—` on a `plain` strip.

The board always shows four columns, one per stage group: Queued (backlog), Plan (plan, spec, design), Build (build, verify, review) and Ship (decide, integrate, pr). They sit in a grid with `space-3` gaps: 1 column below `lg` (1024px), 2 at `lg` and 4 at `xl` (1280px and up). The board never scrolls sideways; a column is `min-w-0` so a long title or chip truncates instead of widening its track. At `xl` each column caps at the viewport height minus the header and scrolls inside itself. Headers are never coloured.

Within a column, cards sort by urgency: needs-you, failed and blocked first, then running, PR review, queued and dependency parks, then finished; ties go to the most recently updated, then the id. A job whose stage no group knows lands in Queued, so it is never invisible.

Done and cancelled jobs go to a full-width Done section below the grid, a sheet drawn dashed, with the same header over an auto-fill grid of cards (`minmax(236px, 1fr)`). It appears only when the filter holds such a job, so the default Active filter never shows it.

Static rendition in the Drafting direction; replaces the board section of `views/Pipeline.svelte`.
