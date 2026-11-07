# Foreman: ship policy and the merge queue

Part of [Foreman](../foreman.md).

## Ship policy

`foreman.ship` is ordered, `propose`, `merge`, `release`, each level including the one before (`shipAllows`, lib/core/config/load.ts, the only reader besides `effectiveContract`'s caps). `release` also lets a mandate run `until: released`; no level makes the Foreman decide a release, which stays `foreman.decides`, `foreman.reserved` and the mandate's `decides`. `foreman.ship: merge` or `release` (with the foreman on) counts as `merge.auto: true` in the approver brief's `Merge: auto` line and in step rule PR4 only. The approver still judges `merge.autoWhen` and writes `Auto-merge eligible`.

PR4 requires a recorded APPROVE marked eligible for the PR head (the `decision` event `forge job decision` binds to the worktree HEAD, never decision.md), and `forge pr merge` enforces it in code with the escalate floor and CI (docs/CONFIG.md "Merge"). CI there means the rollup plus the named required checks, each bound to its source, from `merge.requiredChecks` or else the base branch's protection: a required check that has not reported from its source waits, and one that fails, is `SKIPPED` or `NEUTRAL`, or reports from two sources refuses; with neither source, the rollup alone decides and `forge doctor` warns. The foreman itself never merges, and no daemon session can pass `--now`. `propose` changes nothing.

## Merge queue

When several open PRs of one mandate change the same code, whichever merges second must integrate, re-verify and maybe go back through review, which costs the most for the PR that took the most work. So `mergeQueue` (lib/engine/pipeline/moves/merge-queue.ts) splits a mandate's open root PRs into **overlap groups** (linked when either one's cached overlap report names the other, or by `dependsOn`, transitively) and ranks each group: an entry never above one it depends on, then ready before not ready (stage `pr`, running or waiting on `pr-review` or `overlap`, an open non-draft PR, checks passing or none, no changes requested, an eligible decision, and no refused or failed merge since the last push), then the most input + output tokens (`job.usage.byRole`, cache left out; tokens, never dollars), then the older PR, the lower issue number and the job id.

Each entry carries one fixed reason naming the rule that ordered it against its neighbour, built from job ids and integers only. A PR in no group with a readable report is `mergeNow`, one with no report `unchecked`; neither is ever held. `forge mandate show`, `GET /api/mandates` and the Office page's mandate card show the queue; with `hold` false (a person merges) it is a suggested order.

When Forge merges (`autoMerge`: `foreman.ship: merge` or `release` with the foreman on, or `merge.auto`), step rule PR20, right before PR4, parks a job whose merge PR4 would make on `overlap` while a ready entry ranked above it in its group is open (`merge queue: waits for <id> to merge first (ranked ahead in its overlap group)`), and `forge sync` asks the same before it continues a deferred merge (`mergeHeld`). After its PR loop, `forge sync` releases each held job with no live lease whose hold is gone back to `running` and queues one `resume` under `daemon.enabled` (`mergeQueueReleased`); PR20 or PR4 then runs again.

It cannot deadlock: a job only ever waits on a ready entry ranked strictly above it, so a group's top entry is never held, and an entry whose merge is refused or fails stops being ready, which frees everyone behind it. The hold only ever delays a merge Forge itself makes, never a person's `forge pr merge`, and never causes one.

An `overlap` wait asks nobody: Needs you lists it with the PRs, the machine summary's waiting count and the Office pass's bounce count leave it out, and under `until: merge-ready` it counts as reached. `forge pr open` refreshes a mandate job's overlap report after each push, so the queue reads the pushed head.
