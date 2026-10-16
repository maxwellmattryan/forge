A job card is a clickable plate (`space-3` padding, `space-2` column). Every card has the same seven slots, in this order, whatever the job's state:

1. **Title** in `card-title`, at most two lines.
2. **Ref** in `mono` `muted`, one truncated line with the full id as its tooltip: `#89` for a numeric tracker ref, a non-numeric ref the id does not start with as-is (`ENG-4`), otherwise the id.
3. **State line**: the `StateChip`, `PrChip` and budget chip, then the `after <ref title>` dependency chips on their own wrapped line.
4. **Stage**: the stepper, then `VERIFY · ROUND 2/3` in `label` (the round only from round 1).
5. **Progress**: the bar, when the job has tasks.
6. **Verdicts**: one `VerdictChip` per reviewer, when the job has reviewers.
7. **Footer** in `label` size: the job's daemon session activity first when it has one (`LiveDot` plus *working · 4s ago*, the `warn` chip *needs permission · 4s ago*, or a hollow dot with *waiting* or *idle · 4s ago*), then the running agent (`gleam` dot plus role, or a count), then `{tokens} tok · {ago}` at the far right. A 6px `dot spark` sits before that time for 3 s after a poll changes the job (its event count, state or stage); its space is always reserved, so the card never shifts. The times tick every second.

Progress and verdicts are left out when there is nothing to show, on every card alike; every other slot always renders, so cards never change shape with their state.

The stepper is nine 8px dots in three clusters of three, one each for Plan (plan, spec, design), Build (build, verify, review) and Ship (decide, integrate, pr): `space-1` inside a cluster, `space-2` between clusters. Past steps are filled `gleam` without glow (`dot gleam plain`), future steps hollow (`dot hollow`), and the current step is filled with a 1px outline at 1px offset. The current step is `ember` when the job needs a person, failed or is blocked, and `gleam` otherwise. Queued and unknown stages show nine hollow dots; Done shows nine filled. It is one `role="img"` element whose label reads "Stage 5 of 9: Verify" (0 of 9 before Plan, 9 of 9 when done).

Use it only in board columns. A job that needs a person becomes an ember plate with a `YOU · <state>` chip as its state chip. A job parked until its dependencies finish is not an ember plate: its state chip is the muted `Dependencies` chip. Clicking anywhere opens the drawer; dependency chips open their own job.

Static rendition in the Smithy direction, hand-written from `design/components/JobCard/preview.html` and `components/JobCard.svelte with StageStepper, DepChips, ProgressBar, StateChip, VerdictChip, PrChip`.
