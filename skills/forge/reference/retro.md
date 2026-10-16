# Retro: improving Forge

Forge improves its **repo-local layer**: `.forge/notes/learnings.md`, per-role addenda `.forge/notes/<role>.md`, reviewer checklists `.forge/reviewers/<lens>.md`, and `.forge/config.yml`. Every improvement ships as a reviewed PR and is logged as an experiment with a baseline, so the next retro can tell whether it helped.

## Run
```bash
forge retro due                                  # how many jobs since the last retro
forge job new --title "Forge retro <YYYY-MM-DD>" --kind retro --session ${CLAUDE_SESSION_ID}
forge retro prepare <id>                         # writes stats.json + signals.md (incl. learnings past review-by) into the job dir
forge worktree create <id>
```
When `forge job step` sent you here for an existing retro job, skip the `forge job new` line; if its retro agent already ended without a `spec.md`, go straight to the cancel below.
Spawn **retro** (`forge:retro`), wrapped like any spawn: `forge job agent <id> start --role retro --model <runtime.models.retro> --output <job dir>/spec.md`, then `forge job agent <id> end --role retro …` when it completes. Its brief: the stats and signals paths, `.forge/notes/` (learnings, addenda, experiments.md), `.forge/reviewers/`, `.forge/config.yml`, the configured `improve.maxLearnings`, and `forge eval runs` output if any. It writes `retro.md` and `spec.md`.

If it proposes nothing (too little data, no `spec.md`), report that and cancel the job.

Otherwise run the step loop (SKILL.md **Run a job**). Step records the panel (`code` and `docs`) and always stops at the spec gate, whatever `pipeline.specApproval` says. The human sees `retro.md` (evidence) and `spec.md` (exact edits). Build: the builder edits only `.forge/` files in the worktree and appends to `.forge/notes/experiments.md`. Then decide, PR, and merge as usual.

## Measure
If eval tasks exist, suggest running the same eval subset on the base branch (baseline) and on the retro branch's config before merging, then `forge eval compare`. Otherwise the next retro evaluates the experiment from live metrics.

## Upstream lessons
When a lesson is clearly generic (useful for every repo, not just this one), the retro lists it under "Upstream" in `retro.md`. Offer to open an issue on the Forge repository (maxwellmattryan/forge). It is the human's call, so never file it automatically.
