# Reviewer recall eval

The cheap eval tier for reviewer prompts: frozen diffs from the main checkout's `.forge/evals/recall/<name>/`, some with planted defects and some clean, reviewed under the prompts being changed and graded by recall (planted defects caught) and precision (clean fixtures left alone). Step returns this procedure (RC1) at decide when a job's diff touches `evals.recall.paths`; a human runs it without a job on the base branch to make the run jobs are compared with.

1. Start the run:
   ```bash
   forge eval recall start --job <id>    # a job's prompts: its worktree's agents/reviewer.md when it has one
   forge eval recall start               # the base branch: the checkout's own prompts, else the installed plugin's
   ```
   It returns `run`, `dir` and `reviews`: one `{ fixture, lens, agent, model, output, brief }` per fixture and lens. Exit 1 names an invalid fixture: stop and tell the human, who fixes it on the base branch (while a fixture does not load, the approver runs anyway and step holds the merge on a human after the push, PR17).
2. Spawn every review as `agent` (`forge:reviewer`) with its `model` and its `brief` verbatim, in parallel up to the session's limit. Do not run `forge job agent … start` for them: they review fixtures, not the job. Each writes only its `output`.
3. Record, with the reviews' total tokens when the runtime reports them:
   ```bash
   forge eval recall record <run> [--tokens N]
   ```
   It returns `summary` (`byLens` and `total`: planted, caught, recall, cleanReviews, falsePositives, precision, reviews, malformed, plus minutes and tokens) and `base`, the last base-branch run. With a job it logs the `recall` event that lets decide go on; resume the job with `forge job step <id>`.
4. Without a job, the record is copied to `.forge/evals/recall/runs/<run>.json`: commit it to the base branch so jobs compare against it.

Exit 1 from `record`: no such run, already recorded, or no review file at all (step 2 did not run). A missing or malformed review counts in `malformed` and catches nothing. After two starts with no record for the same prompts, or with a fixture that does not load, decide goes on to the approver and the PR opens; then step holds the merge on a human (PR17, `recall eval: no recorded run for prompts <hash>`): they approve to waive the check, or ask for rework.
