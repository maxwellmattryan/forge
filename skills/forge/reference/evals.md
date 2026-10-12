# Evaluating Forge

Evals answer "is Forge getting better or worse?" with numbers, instead of impressions from the last few jobs. They cost real tokens, so always confirm scope (number of tasks × typical job cost from `forge stats`) with the human before a run.

## Tasks
Each task lives in `.forge/evals/<name>/`: a `task.yml` with the request, a base commit, and a **hidden check** the builder can't see (eval worktrees are sparse-checked-out without `.forge/evals`).
- **Replay a merged PR** (best: real work with real tests): pick candidates with `gh pr list --state merged --limit 30 --json number,title,files`. Prefer PRs that touched tests and were self-contained. Then:
  ```bash
  forge eval mine --pr <n>        # base = the PR's base commit; request = PR + linked issues; hidden check = the PR's test changes
  ```
  Read the generated `task.yml` request and remove anything that gives away the implementation verbatim.
- **Hand-written**: `forge eval new <name> --title "…" --body-file request.md`, then put hidden test files under `check/files/` (copied into the worktree before the check runs) or a `check/tests.patch`, plus `check.command` if it differs from `commands.test`.
- **Rubric** (repos without tests, or for quality): add `rubric.md`. The judge agent scores it 0-5.

Aim for 5-15 tasks with tags (`replay`, `ui`, `bugfix`, `refactor`, …) so subsets can run cheaply.

## Run
```bash
forge eval start [--tags a,b] [--tasks x,y] [--label "<what changed>"]
```
It returns a run record whose tasks map to eval jobs with worktrees ready. Drive each job through the normal pipeline in **eval mode**:
- no tracker, no PR, no integrate. Skip spec approval (no human gates); a `NEEDS-INPUT` from any agent fails the task (`forge job note` it)
- design: references only, no mockups
- after **Decide** (APPROVE or ESCALATE alike): if the task has `rubric.md` or `reference.patch`, spawn **judge** (role `judge`, output `eval-judge.md` in the job dir), then `forge eval grade <job>`
Run up to `runtime.maxParallelJobs` tasks at once.

## Read results
```bash
forge eval runs
forge eval compare <runA> <runB>
```
Each run is stamped with the Forge version and a `configHash` (config + reviewer checklists + notes), so a difference can be traced to what changed. Treat small task counts carefully: a single task flipping is noise. When a change looks promising, run the same tasks again before believing it. The dashboard's Evals view shows all of this.
