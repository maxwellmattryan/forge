# Retro: improving Forge

Forge improves its **repo-local layer**: `.forge/notes/learnings.md`, per-role addenda `.forge/notes/<role>.md`, reviewer checklists `.forge/reviewers/<lens>.md`, and `.forge/config.yml`. Every improvement ships as a reviewed PR and is logged as an experiment with a baseline, so a later retro can tell whether it helped.

You get here from `/forge retro`, from a `retro` request in the inbox (the dashboard, `forge sync` when the foreman is on and `forge retro due` says a retro is due, or a mandate's close, by the Office pass or the owner, when the foreman is on). An existing retro job needs nothing from here: its step loop runs it.

## Run
```bash
forge retro due                                  # how many jobs since the last retro
forge job new --title "Forge retro <YYYY-MM-DD>" --kind retro --session ${CLAUDE_SESSION_ID}
```
For a `retro` request with `args.mandate`, run the lines in **A mandate's retro** below instead. Then run the step loop (SKILL.md **Run a job**); step does the rest:
- K1b creates the worktree, and K1c runs `forge retro prepare <id>`, which writes stats.json and signals.md (experiment verdicts, per-lens recall, recurring findings across jobs, learnings past review-by) and transcripts.json into the job dir, and the worst runs' fenced logs into `digest/batch-<n>.md`.
- K1d spawns one `forge:digest` per batch, in order, each once: its brief names only that batch and its `friction-<n>.md`. A digest that fails or writes no file is skipped. Their usage lands on the retro job and counts toward its budget.
- K1 spawns `forge:retro`, which writes `retro.md` and `spec.md` from stats.json, signals.md, transcripts.json, each `friction-<n>.md` that exists, `.forge/notes/` (learnings, addenda, experiments.md), `.forge/reviewers/`, `.forge/config.yml` and the configured `improve.maxLearnings`; never a transcript, `digest/runs.json` or a batch. A retro that failed or was lost runs again.
- K1e cancels the job when the retro proposed nothing (it wrote no `spec.md`); report that.

From there the step loop goes on as for any job. Step records the panel (`code` and `docs`) and always stops at the spec gate, whatever `pipeline.specApproval` says, and a retro's spec gate is never the foreman's: no gate request reaches the gate runner. The human sees `retro.md` (evidence) and `spec.md` (exact edits). Build: the builder runs `forge experiment evaluate <id>` first and commits the ledger it writes (the only way a ledger status changes), then edits only `.forge/` files, plus the test or lint files of any check the spec proposes, in the worktree and appends new entries to `.forge/notes/experiments.md`. Verify's `notes` step refuses a hand-written status, an entry whose metric is no stats path, and a learning or addendum entry without `experiment:` and `review-by:`. Then decide, PR, and merge as usual.

## A mandate's retro
A `retro` request with `args.mandate` is a closed mandate's retro, over only that mandate's jobs (live and archived, with no date window). Skip `forge retro due` and run:
```bash
forge job new --title "Forge retro: mandate <args.mandate>" --kind retro --session ${CLAUDE_SESSION_ID}
forge retro prepare <id> --mandate <args.mandate>
```
Then run the step loop like any retro: stats.json is there, so step goes on from the worktree and the digests. The scope is recorded on the job, so a later `forge retro prepare <id>` with no `--mandate` keeps it, and a mandate retro never counts as the last retro for `forge retro due`.

## Measure
If eval tasks exist, suggest running the same eval subset on the base branch (baseline) and on the retro branch's config before merging, then `forge eval compare`. Otherwise `forge experiment evaluate` settles each entry from the jobs created after it.

## Upstream lessons
When a lesson is clearly generic (useful for every repo, not just this one), the retro lists it under "Upstream" in `retro.md`. Offer to open an issue on the Forge repository (maxwellmattryan/forge). It is the human's call, so never file it automatically.
