# PR lifecycle: continuing, syncing, conflicts, feedback

A job can outlive a session. A PR can stay open for days, collect review comments, fall behind its base branch, or be continued by several sessions. The job folder plus `forge sync` / `forge pr sync` carry the state between sessions. Nothing depends on conversation memory.

## Resolve what to continue
- **Job id** → use it.
- **`#<n>` (a PR)** → find the job whose `pr.number` is n (`forge job list --all`, then `forge job get <id> pr.number`). If there is none, the PR was started elsewhere (by a human or older work): `gh pr view <n> --json title,headRefName,body`, then `forge job new --title "<PR title>" --branch <headRefName> --body "Continue PR #<n>: <body summary>" --session ${CLAUDE_SESSION_ID}`. The worktree will check out that branch, and `forge pr find` adopts the PR.
- **Tracker ref** → `forge job from-ref <ref>`. If an active job already exists for the ref, it is returned instead. `forge pr find` also discovers PRs linked to the issue.

Then `forge job claim <id> --session ${CLAUDE_SESSION_ID}` and `forge worktree create <id>` (a no-op when it exists, and it tracks the remote branch when not local).

## Read the situation
```bash
forge pr sync <id>
```
Act on the result, in this order:
1. `state: MERGED` → the job is done (sync already set it). Report, and run `forge sync` to clean up.
2. `state: CLOSED` → ask the human whether to reopen, start a new PR, or cancel.
3. `conflicts: true` or `behindBy > 0` → `forge integrate <id>` (open PRs default to a merge strategy, so no force-push is needed). Conflicts follow `pr.conflicts`: `ask` → `--state waiting --waiting-on conflicts` and report the files, offering "fix now" or "later" · `fix` → integrator agent · `defer` → leave it and note it. After a successful integration with new commits, run `forge verify <id>`, then `forge pr open <id>` (which pushes and reuses the PR).
4. `unresolvedThreads > 0`, `changesRequested > 0`, or a human note → a **rework round**: `forge job set <id> --stage build --state running`, builder inputs `pr-feedback.md` (written by sync, containing reviews, unresolved threads and conversation) plus `feedback.md` with the human's note.
5. `checks.state: failing` → a rework round whose brief says CI fails. The builder inspects it with `gh pr checks <n>` / `gh run view <run-id> --log-failed` and fixes it.
6. Nothing to do → report "PR #n is green and waiting on review" and stop.

## After a rework round
`forge verify <id>` → review according to `review.onPrFeedback`:
- `changed` (default): only the lenses relevant to what changed this round (always `code`; `tests` if tests changed; UI lenses if UI changed; `security` if the feedback was security-related)
- `full`: the whole panel
- `none`: skip straight to push

Then `forge pr open <id>` (push + reuse), `--stage pr --state waiting --waiting-on pr-review`, `forge job release <id>`. Report what was addressed, one line per thread.

## Parallel sessions on one PR
Only one session drives a job at a time (the claim). A second session that needs the same PR either waits, or the human passes `--force` to `forge job claim` when the first session is gone (claims go stale after 30 minutes without activity). Separate pieces of follow-up work on the same PR should be separate jobs with `--parent <id>` and the same `--branch`. Run them one after another, never at the same time on one branch.
