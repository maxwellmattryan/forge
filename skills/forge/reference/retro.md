# Retro: improving Forge

Forge improves its **repo-local layer**: `.forge/notes/learnings.md`, per-role addenda `.forge/notes/<role>.md`, reviewer checklists `.forge/reviewers/<lens>.md`, and `.forge/config.yml`. Every improvement ships as a reviewed PR and is logged as an experiment with a baseline, so the next retro can tell whether it helped.

## Run
```bash
forge retro due                                  # how many jobs since the last retro
forge job new --title "Forge retro <YYYY-MM-DD>" --kind retro --session ${CLAUDE_SESSION_ID}
forge retro prepare <id>                         # writes stats.json + signals.md into the job dir
forge worktree create <id>
```
Spawn **retro** (role `retro`) with: the stats and signals paths, `.forge/notes/` (learnings, addenda, experiments.md), `.forge/reviewers/`, `.forge/config.yml`, the configured `improve.maxLearnings`, and `forge eval runs` output if any. It writes `retro.md` and `spec.md`.

If it proposes nothing (too little data), report that and cancel the job.

Otherwise continue the normal pipeline from the **Spec gate**. Retro jobs **always** wait for spec approval, whatever `pipeline.specApproval` says. The human sees `retro.md` (evidence) and `spec.md` (exact edits). Build: the builder edits only `.forge/` files in the worktree and appends to `.forge/notes/experiments.md`. Review lenses: `code` and `docs`. Then decide, PR, and merge as usual.

## Measure
If eval tasks exist, suggest running the same eval subset on the base branch (baseline) and on the retro branch's config before merging, then `forge eval compare`. Otherwise the next retro evaluates the experiment from live metrics.

## Upstream lessons
When a lesson is clearly generic (useful for every repo, not just this one), the retro lists it under "Upstream" in `retro.md`. Offer to open an issue on the Forge repository (maxwellmattryan/forge). It is the human's call, so never file it automatically.
