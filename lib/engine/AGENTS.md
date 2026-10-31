# lib/engine/

What Forge does: the pipeline, worktrees, PRs, tracker sync, guards, releases, environments, evals, metrics and operations.

- Engine holds policy and integrations hold mechanism: `lib/integrations/github/` opens a PR and reads its checks, while when to retarget, rework on a red CI or merge stays here.
- Engine runs the repo's own configured commands (verify, dev servers); Node built-ins and OS process tools stay in `lib/core/`.
- Engine treats its inputs as hostile: job state, repo files, git and `gh` output and config may all be written by an agent or a checkout.
- Design: [Job model](../../docs/architecture/job-model.md), [Untrusted input](../../docs/architecture/untrusted-input.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `environment/` | A job's runtime environment: backing services, ports, endpoints, the dev server's state and config sinks. |
| `evals/` | Evals and self-improvement: eval runs and stats, experiments, learnings, retros, recall, scoring and provenance. |
| `guard/` | The guards on what jobs write and publish: verify integrity, protected paths, secret scanning and redaction, and AI attribution. |
| `metrics/` | Stats, token usage, spend and budgets. |
| `ops/` | Operating Forge itself: doctor, support bundles, updates, versions, retention, deletion, audit, repo detection and titles. |
| `pipeline/` | The pipeline: `forge job step`, agent briefs, review panels, verifiers and the facts they read. |
| `pr/` | A job's pull requests: open, update, sync, merge and adopt them, and the human delta after Forge's last push. |
| `project/` | Multi-repo projects: member repos and trackers, a job's repos and their order, proposals, links and downstream checks, the machine index of registered projects, the machine's login service and uptime record, and the overlap check. |
| `release/` | Releases: plans, runs and approvals, and interim releases across member repos. |
| `trackers/` | Tracker sync: the adapter loader with its security wrappers, mirrors, issue links, triage and request refresh. |
| `verify/` | `forge verify` and the verify record: the gate's steps, and the one reader of `job.verifyRuns`. |
| `workspace/` | Job worktrees and what runs in them: checkouts, focus, the editor, regeneration and configured job commands. |
<!-- forge:map:end -->
