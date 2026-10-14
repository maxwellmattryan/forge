A job card is a clickable ticked sheet (`space-3` padding, `space-2` column). Every card has the same seven slots, in this order, whatever the job's state:

1. **Title** in `card-title`, at most two lines.
2. **Ref** in `mono` `muted`, one truncated line with the full id as its tooltip: `#89` for a numeric tracker ref, a non-numeric ref the id does not start with as-is (`ENG-4`), otherwise the id.
3. **State line**: the `StateChip`, `PrChip` and budget chip, then the `after <ref title>` dependency chips on their own wrapped line.
4. **Stage**: the stepper, then `VERIFY · ROUND 2/3` in `label` (the round only from round 1).
5. **Progress**: the hatched bar, when the job has tasks.
6. **Verdicts**: one `VerdictChip` per reviewer, when the job has reviewers.
7. **Footer** in `label` size: the running agent (`ink` dot plus role, or a count), then `{tokens} tok · {ago}` at the far right.

Progress and verdicts are left out when there is nothing to show, on every card alike; every other slot always renders, so cards never change shape with their state.

The stepper is nine 8px dots in three clusters of three, one each for Plan (plan, spec, design), Build (build, verify, review) and Ship (decide, integrate, pr): `space-1` inside a cluster, `space-2` between clusters. Past steps are filled `ink`, future steps hollow (`dot hollow`), and the current step is filled with a 1px outline at 1px offset. The current step is `redline` when the job needs a person, failed or is blocked, and `ink` otherwise. Queued and unknown stages show nine hollow dots; Done shows nine filled. It is one `role="img"` element whose label reads "Stage 5 of 9: Verify" (0 of 9 before Plan, 9 of 9 when done).

Use it only in board columns. A job that needs a person becomes a `redline` sheet with a `REV · <state>` tag as its state chip. A job parked until its dependencies finish is not redlined: its state chip is the muted `Dependencies` chip. Clicking anywhere opens the drawer; dependency chips open their own job.

Static rendition in the Drafting direction; replaces `JobCard.svelte` with `StageStepper`, `DepChips`, `ProgressBar`, `StateChip`, `VerdictChip`, `PrChip`.
