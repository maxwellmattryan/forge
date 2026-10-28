# lib/engine/pr/

A job's pull requests: open, update, sync, merge and adopt them, and the human delta after Forge's last push.

- Never adopt a fork PR. PR text and review threads are untrusted: fence them as data before an agent reads them.
- `openPr` is the one enforcer of the held push (`lib/engine/guard/push-hold.ts`): every check runs before any push, member push or `create`, `--force` or not. Step only parks on the `push-held` event it logs (PR13), and `syncPrGate` (`forge pr gate`) reads the merge gate from step's own input, never a reason a session passes in.
- Policy lives here: when to adopt, open, rework, retarget or merge. Every GitHub call goes through the `GitHub` adapter the caller passes; no file here imports `gh.ts` or the gh adapter. What it returns is already checked (`lib/integrations/github/pull-requests.ts`), so no file here reads raw gh JSON.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md), [Job repos](../../../docs/architecture/job-repos.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `adopt.ts` | Adopting a PR that already exists for a job's work: same repository, safe ref names, trusted closing PRs only. |
| `body.ts` | The PR title and body Forge sends: summary, the gate section (why the merge waits on a person, or the escalation approval), sibling links and issue lines. |
| `branch.ts` | The job branch against its remote and its base: the base refresh before the secret scan, the base's tip for a merge's checks, the push of the checked commit, pulling a PR head that moved, and bringing the branch up to date with its base (merge or rebase, generated-path rebuilds, and finishing a kept conflict). |
| `ci.ts` | CI on a parked PR: re-running a head's failed GitHub Actions runs, for forge sync's CI re-run and a person's Re-run failed checks, a person's Fix CI rework, and the fixed CI feedback.md. |
| `delta.ts` | The human delta: what people changed on a PR branch after Forge's last push. |
| `eligible.ts` | Whether a job's PR may merge without a person: the recorded decision, not superseded and bound to its head, recomputed protected paths and the escalate floor. |
| `feedback.ts` | pr-feedback.md: people's PR feedback rendered as quoted data, filtered by tracker.github.comments. |
| `members.ts` | Member-repo PRs of a linked job: check, open, record and sync them, and keep their sibling links current. |
| `merge.ts` | Merging a job's PRs once CI allows it, in dependency order for a linked job, forge sync's hint for which deferred merges to continue, and marking drafts ready. |
| `open.ts` | Opening a job's PRs: the checks before anything leaves the machine (the held push among them), interim deferrals and drafts, the pushes and the PRs, the gate section and label `forge pr gate` syncs while the merge waits on a person, and retargeting a stacked PR. |
| `required.ts` | Required checks: which checks a PR's merge needs, from merge.requiredChecks or its base's protection, and whether its head satisfies them, each bound to its source. |
| `sync.ts` | Syncing a job with its PR on GitHub: the state it leaves the job in, CI reworks and re-runs, reopening deferred PRs, the human delta and pr-feedback.md. |
<!-- forge:map:end -->
