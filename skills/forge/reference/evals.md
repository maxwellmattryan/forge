# Evaluating Forge

Evals answer "is Forge getting better or worse?" with numbers, instead of impressions from the last few jobs. They cost real tokens, so always confirm scope (number of tasks × typical job cost from `forge stats`) with the human before a run. An `eval-run` request from the dashboard is that confirmation: the human chose its tags and tasks there, so run it as given.

## Tasks
Each task lives in `.forge/evals/<name>/`: a `task.yml` with the request, a base commit, and a **hidden check** the builder can't see (eval jobs get a standalone shallow clone of just the base commit, with no remotes and without `.forge/evals`, so neither the check nor the real fix is reachable through git). This is not a filesystem sandbox. `forge worktree remove <eval job>` deletes the clone's directory and needs `--force` if it has uncommitted changes.
- **Replay a merged PR** (best: real work with real tests): pick candidates with `gh pr list --state merged --limit 30 --json number,title,files`. Prefer PRs that touched tests and were self-contained. Then:
  ```bash
  forge eval mine --pr <n>        # base = the PR's base commit; request = PR + linked issues; hidden check = the PR's test changes
  ```
  Read the generated `task.yml` request and remove anything that gives away the implementation verbatim.
- **Hand-written**: `forge eval new <name> --title "…" --body-file request.md`, then put hidden test files under `check/files/` (copied into the worktree before the check runs) or a `check/tests.patch`, plus `check.command` if it differs from `commands.test`.
- **Rubric** (repos without tests, or for quality): add `rubric.md`. The judge agent scores it 0-5.

Grading a `check/tests.patch`: before the patch is applied, the candidate's versions of the files it touches are replaced by the base versions, or deleted when the base has none, so a builder's own copy of a hidden test or golden never turns the grade into a merge conflict. Every other file the candidate wrote stays, including its other tests, which still run. This covers source files too if a hand-written patch touches them. A patch that does not apply to its own base, or a base the clone lacks, fails the check with the reason in `check.reason`.

Aim for 5-15 tasks with tags (`replay`, `ui`, `bugfix`, `refactor`, …) so subsets can run cheaply.

## Run
```bash
forge eval start [--tags a,b] [--tasks x,y] [--label "<what changed>"]
```
It returns a run record whose tasks map to eval jobs with worktrees ready. Drive each job with the step loop (SKILL.md **Run a job**); step applies **eval mode** from the job's `kind: eval`:
- no tracker, no PR, no integrate, and no spec approval (no human gates); a `NEEDS-INPUT` from any agent fails the task
- design: references only, no mockups
- after **Decide** (APPROVE or ESCALATE alike): if the task has `rubric.md` or `reference.patch`, it spawns the **judge** (output `eval-judge.md` in the job dir), then runs `forge eval grade <job>`
- an eval job past `pipeline.maxRounds` is not parked on rounds-exhausted: step (B6) sends it to decide, which skips the approver and goes straight to the judge and `forge eval grade`, with `roundsExhausted: true` on its result
Run up to `runtime.maxParallelJobs` tasks at once.

## Read results
```bash
forge eval runs
forge eval report <run>          # every task's result; check.replaced lists the candidate files the hidden patch replaced
forge eval compare <runA> <runB>
```
Each run is stamped with the Forge version, a `pluginHash` (the plugin's agent prompts, checklists, skill, `lib/step.ts` and `lib/brief.ts`) and a `configHash` (config + reviewer checklists + notes), so a difference can be traced to what changed. The summary's `roundsExhaustedRate` (in `eval runs`, `eval report` and `eval compare`'s delta) is the share of graded tasks that ran out of rounds; `escalationRate` counts approver decisions only, so it leaves those tasks out. Treat small task counts carefully: a single task flipping is noise. When a change looks promising, run the same tasks again before believing it. The dashboard's Evals view shows all of this.

## A/B runs
- `--repeat N` (1–10) makes N eval jobs per task, so a run costs tasks × N jobs: confirm that with the human. Read each delta's `na`/`nb` and the per-task `n`, mean, min and max (`eval report` → `perTask`) before believing a difference.
- `--set key=value` (repeatable) runs the variant without touching `.forge/config.yml`: `runtime.models.<role>`, `runtime.effort(s)`, `runtime.effortByComplexity.*`, `runtime.modelByComplexity.*`, `runtime.reworkModel`, `review.onRework`, `pipeline.*`, `review.panel` or `verify`. Anything else is refused, the overlay is in `configHash`, and a daemon session may not pass `--set`. Example: one run on main, one with `--set runtime.models.builder=sonnet`, then `forge eval compare`.
- Graded results add `stages` (minutes per stage), `agentMinutes`, `orchestratorMinutes` and `reviewerRuns`, and `eval compare` has a `stages` delta.
- Trap: under `claude --plugin-dir <checkout>` with the installed plugin still enabled, the `forge` on PATH is the installed one, so agents run the checkout's prompts while `pluginHash` and `forgeVersion` describe the installed plugin. Disable the installed plugin, or put the checkout's `bin/` first on PATH, before an A/B run.
