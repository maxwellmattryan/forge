# lib/engine/pr/

A job's pull requests: open, update, sync, merge and adopt them, and the human delta after Forge's last push.

- Never adopt a fork PR. PR text and review threads are untrusted: fence them as data before an agent reads them.
- Policy lives here: when to adopt, open, rework, retarget or merge. Every GitHub call goes through the `GitHub` adapter the caller passes; no file here imports `gh.ts` or the gh adapter. What it returns is already checked (`lib/integrations/github/pull-requests.ts`), so no file here reads raw gh JSON.
- Design: [Untrusted input](../../../docs/architecture/untrusted-input.md), [Job repos](../../../docs/architecture/job-repos.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `adopt.ts` | Adopting a PR that already exists for a job's work: same repository, safe ref names, trusted closing PRs only. |
| `body.ts` | The PR title and body Forge sends: summary, escalation approval, sibling links and issue lines. |
| `branch.ts` | The job branch against its remote: the base refresh before the secret scan, the push of the checked commit, and pulling a PR head that moved. |
| `delta.ts` | The human delta: what people changed on a PR branch after Forge's last push. |
| `feedback.ts` | pr-feedback.md: people's PR feedback rendered as quoted data, filtered by tracker.github.comments. |
| `integrate.ts` | Bringing a job branch up to date with its base: merge or rebase, generated-path rebuilds, and finishing a kept conflict. |
| `members.ts` | Member-repo PRs of a linked job: check, open, record and sync them, and keep their sibling links current. |
| `merge.ts` | Merging a job's PRs once CI allows it, in dependency order for a linked job, and marking drafts ready. |
| `open.ts` | Opening a job's PRs: the checks before anything leaves the machine, interim deferrals and drafts, the pushes and the PRs, and retargeting a stacked PR. |
| `sync.ts` | Syncing a job with its PR on GitHub: the state it leaves the job in, CI reworks, reopening deferred PRs, the human delta and pr-feedback.md. |
<!-- forge:map:end -->
