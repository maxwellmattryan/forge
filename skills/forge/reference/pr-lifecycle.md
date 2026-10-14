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
3. `conflicts: true` or `behindBy > 0` → `forge integrate <id>` (open PRs default to a merge strategy, so no force-push is needed). Conflicts follow `pr.conflicts`: `ask` → `--state waiting --waiting-on conflicts` and report the files, offering "fix now" or "later" · `fix` → integrator agent, `forge verify <id>`, then the [integration review](#integration-review) below · `defer` → leave it and note it. After a successful integration with new commits, run `forge verify <id>`, then `forge pr open <id>` (which pushes and reuses the PR).
4. `unresolvedThreads > 0`, `changesRequested > 0`, or a human note → a **rework round**: `forge job set <id> --stage build --state running`, builder inputs `pr-feedback.md` (written by sync, containing reviews, unresolved threads and conversation) plus `feedback.md` with the human's note.
5. `checks.state: failing` → a rework round whose brief says CI fails. The builder inspects it with `gh pr checks <n>` / `gh run view <run-id> --log-failed` and fixes it.
6. Nothing to do → report "PR #n is green and waiting on review" and stop.

## After a rework round
`forge verify <id>` → review according to `review.onPrFeedback`:
- `changed` (default): only the lenses relevant to what changed this round (always `code`; `tests` if tests changed; UI lenses if UI changed; `security` if the feedback was security-related)
- `full`: the whole panel
- `none`: skip straight to push

Then `forge pr open <id>` (push + reuse), `--stage pr --state waiting --waiting-on pr-review`, `forge job release <id>`. Report what was addressed, one line per thread.

`unlinked: true` in a `forge pr open` result is reported (SKILL.md step 10), never acted on: linking an issue is the human's call.

## Integration review
Runs only when `forge integrate` returned conflicts **and** the integrator resolved them (`INTEGRATE: done`), after `forge verify <id>` passed and before `forge pr open`. Clean integrations and the `ask` / `defer` policies skip it.

1. Spawn one `forge:reviewer`, lens `code`, output `integrationReview` from `forge job paths <id>` (`review/integration/code.md`). The brief names the conflicted files from the `forge integrate` result and the diff to read, using the `Before:` / `Merge:` shas from the `## Integration` block in `build.md`:
   - merge: `forge git show --remerge-diff <merge sha>` (the resolution) plus `forge git diff <merge sha>..HEAD` (fallout fixes);
   - rebase: `forge git range-diff <remote>/<base> <before sha> HEAD` (how each job commit changed while replayed) plus `forge git diff <remote>/<base>...HEAD`.
2. `forge job verdicts <id> --round integration --compact` (reviewers default to `code`; it logs an `integration-review` event and leaves `job.verdicts` alone).
   - `PASS` → `forge pr open <id>`.
   - `MALFORMED` → re-spawn the reviewer once; still malformed → re-run with `--malformed changes`.
   - `MISSING` (the reviewer ended without writing `missing.code`) → re-spawn it once; still missing → `--state waiting --waiting-on escalation --reason "integration review: no review written"` and report.
   - `CHANGES` → resume (or respawn) the integrator with `review/integration/code.md` as input, then `forge verify <id>` and re-review (it overwrites the same file). One fix attempt only. Still `CHANGES` → `forge job set <id> --state waiting --waiting-on escalation --reason "integration review: CHANGES"`, report, and don't open the PR. A human `approve` then proceeds to `pr open`.

## Parallel sessions on one PR
Only one session drives a job at a time (the claim). A second session that needs the same PR either waits, or the human passes `--force` to `forge job claim` when the first session is gone (claims go stale after 30 minutes without activity). A `forge dash` daemon owner yields without `--force` when its session record proves it let go: the record has since replaced that session id (`moved-on`), the recorded child isn't running (`not-running`), or the owner is the inbox and the claimer is that job's own daemon session (`inbox-handoff`). The takeover is logged as a note. An owner in no record (an interactive session) and a live daemon session keep the claim. `forge requests add resume --job <id> --session <S>` releases the claim when `S` owns it. Separate pieces of follow-up work on the same PR should be separate jobs with `--parent <id>` and the same `--branch`. Run them one after another, never at the same time on one branch.
