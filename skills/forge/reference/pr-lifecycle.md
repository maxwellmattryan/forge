# PR lifecycle: continuing, syncing, conflicts, feedback

A job can outlive a session. A PR can stay open for days, collect review comments, fall behind its base branch, or be continued by several sessions. The job folder plus `forge sync` / `forge pr sync` carry the state between sessions. Nothing depends on conversation memory.

## Resolve what to continue
- **Job id** → use it.
- **`#<n>` (a PR)** → find the job whose `pr.number` is n (`forge job list --all`, then `forge job get <id> pr.number`). If there is none, the PR was started elsewhere (by a human or older work): `gh pr view <n> --json title,headRefName,body`, then `forge job new --title "<PR title>" --branch <headRefName> --body "Continue PR #<n>: <body summary>" --session ${CLAUDE_SESSION_ID}`. The worktree will check out that branch, and `forge pr find` adopts the PR.
- **Tracker ref** → `forge job from-ref <ref>`. If an active job already exists for the ref, it is returned instead. `forge pr find` also discovers PRs linked to the issue.

Then `forge job claim <id> --session ${CLAUDE_SESSION_ID}` and `forge worktree create <id>` (a no-op when it exists, and it tracks the remote branch when not local).

A job waiting on `infra` needs no PR reading: the human's runbook steps are done, so `forge job human <id> approve --note "steps done"`, `forge job set <id> --stage integrate --state running`, and run the step loop.

## Read the situation
```bash
forge pr sync <id>
```
Act on the result, in this order. Each case either stops or sets the job's stage once and then runs the step loop (SKILL.md **Run a job**), which does the rest:
1. `state: MERGED` → the job is done (sync already set it). Report, and run `forge sync` to clean up.
2. `state: CLOSED` → ask the human whether to reopen, start a new PR, or cancel.
3. The job is already at `stage: integrate` (`forge sync` routed it) → run the step loop. With `daemon.enabled`, sync has already queued a `resume` for a job it routed, so the job's own session takes it from there. Otherwise, on `conflicts: true` or `behindBy > 0` → `forge job set <id> --stage integrate --state running`, then the step loop. Step runs `forge integrate <id>` (merge unless `pr.updateStrategy: rebase`, so no force-push is needed), applies `pr.conflicts` (`ask` waits on `conflicts`, `fix` spawns the integrator, re-verifies and runs the [integration review](#integration-review), `defer` notes it; conflicts only on `worktrees.generated` paths never reach the policy: `forge integrate` rebuilds them itself and returns `ok: true` with `regenerated`), re-verifies new commits, and runs `forge pr open <id>` (which pushes and reuses the PR).
4. `unresolvedThreads > 0`, `changesRequested > 0`, or a human note → a **rework round**: `forge job human <id> rework --note "<the human's note, or: address the PR feedback>"`, write the note to `feedback.md`, then `forge job set <id> --stage build --state running`. Step starts a new round and gives the builder `pr-feedback.md` (written by sync, containing reviews, unresolved threads and conversation) plus `feedback.md`.
5. `checks.state: failing` → a rework round as in 4, with `feedback.md` saying CI fails. The builder inspects it with `gh pr checks <n>` / `gh run view <run-id> --log-failed` and fixes it.
6. Nothing to do → report "PR #n is green and waiting on review" and stop.

## After a rework round
Step verifies, then reviews according to `review.onPrFeedback`:
- `changed` (default): the `always: true` lenses (step decides from recorded state, not the diff)
- `full`: the whole recorded panel
- `none`: skip straight to push

Then it opens the PR again (push + reuse), parks the job on `pr-review` and releases the claim. Report what was addressed, one line per thread.

`unlinked: true` in a `forge pr open` result is reported (step's `pr-review` tell carries it), never acted on: linking an issue is the human's call.

## Job repos
A job with member repos (`forge job repo add`) has one PR per non-verify-only member beside the root PR. `forge pr open` checks every repo first (verified HEADs, the secret scan of each PR body and each repo's commits, at least one commit ahead of each base, a GitHub slug for each member), then pushes each member's branch and opens or reuses its PR, then opens the root PR as usual; the result lists the members under `repos`. A failure names the repo, keeps the member PRs already opened, and a rerun reuses them. `forge pr sync` records each member PR's state and checks on the job for the dashboard, logging `repo-pr-sync-failed` when one can't be read, and never moves the job on a member PR. Merging and finishing stay root-only for now (#184): a human merges member PRs. Integrate, the integration review and PR feedback import cover the root repo only, so a member PR that falls behind or conflicts is a human's to resolve.

## Integration review
`forge job step` drives this review; the steps below are reference for humans reading a job's history. It runs only when `forge integrate` returned conflicts **and** the integrator resolved them (`INTEGRATE: done`), after `forge verify <id>` passed and before the approver decides (or, once it has decided or a PR is open, before `forge pr open`). Clean integrations, generated-only integrations (`forge integrate` rebuilt every conflicted path itself and returned `regenerated`) and the `ask` / `defer` policies skip it. Under `pr.integrationReview: code-only` (the default), a resolution whose conflicts, and every file it changed beyond git's automatic merge, were all docs (`*.md`, `docs/**`) or generated paths skips it too, with a note on the job (rule IG11).

1. Spawn one `forge:reviewer`, lens `code`, output `integrationReview` from `forge job paths <id>` (`review/integration/code.md`). The brief names the conflicted files from the `forge integrate` result and the diff to read, using the `Before:` / `Merge:` shas from the `## Integration` block in `build.md`:
   - merge: `forge git show --remerge-diff <merge sha>` (the resolution) plus `forge git diff <merge sha>..HEAD` (fallout fixes);
   - rebase: `forge git range-diff <remote>/<base> <before sha> HEAD` (how each job commit changed while replayed) plus `forge git diff <remote>/<base>...HEAD`.
2. `forge job verdicts <id> --round integration --compact` (reviewers default to `code`; it logs an `integration-review` event and leaves `job.verdicts` alone).
   - `PASS` → `decide`, or `forge pr open <id>` once the approver has decided or a PR is open.
   - `MALFORMED` → re-spawn the reviewer once; still malformed → re-run with `--malformed changes`.
   - `MISSING` (the reviewer ended without writing `missing.code`) → re-spawn it once; still missing → `--state waiting --waiting-on escalation --reason "integration review: no review written"` and report.
   - `CHANGES` → resume (or respawn) the integrator with `review/integration/code.md` as input, then `forge verify <id>` and re-review (it overwrites the same file). One fix attempt only. Still `CHANGES` → `forge job set <id> --state waiting --waiting-on escalation --reason "integration review: CHANGES"`, report, and don't open the PR. A human `approve` then sends the job to `decide`: the approver runs if it hasn't decided, otherwise step opens the PR.

## Parallel sessions on one PR
Only one session drives a job at a time (the claim). A second session that needs the same PR either waits, or the human passes `--force` to `forge job claim` when the first session is gone (claims go stale after 30 minutes without the owner's own activity: its `forge job step --session`, its worktree commands, or an agent marked running; sync, other sessions and the dashboard never refresh a claim). A `forge dash` daemon owner yields without `--force` when its session record proves it let go: the record has since replaced that session id (`moved-on`), the recorded child isn't running (`not-running`), or the owner is the inbox and the claimer is that job's own daemon session (`inbox-handoff`). The takeover is logged as a note. An owner in no record (an interactive session) and a live daemon session keep the claim. `forge requests add resume --job <id> --session <S>` releases the claim when `S` owns it. Separate pieces of follow-up work on the same PR should be separate jobs with `--parent <id>` and the same `--branch` (created unowned: claim each when you run it, as in `split.md`). Run them one after another, never at the same time on one branch.
