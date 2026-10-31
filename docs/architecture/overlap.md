# Overlap check

`forge overlap <job>`, `forge overlap '#<n>'` or `forge overlap --pr <n>` (`lib/engine/project/overlap.ts`) answers "is now a good time to merge this?" before two pieces of work collide. It checks one **subject**, a job or an open PR, against everything else in flight, and gives one **timing** from a fixed rule, never a model call. It only reads: it runs no agent, fetches, checks out or adopts nothing, and writes only its own report. The shepherd and the PR assessment build on it.

## What it reads

**The subject's changes.** For a job: its branch's committed diff against its merge base, when `refs/heads/<branch>` exists in the main checkout (`source: diff`); else, when GitHub lists an open same-repo PR with the job's branch as its head, that PR's files and diff (`diff`); else the paths in its spec's `Files:` table (`file-map`). A job with none of these fails (`job <id> has no diff and no file map yet`, exit 1). For a PR: the PR's file list and its `gh pr diff`. A same-repo PR whose head is a job's branch is that job, and the report is the job's.

**Counterparts**, each `{ kind, ref, source, human, stage, url, files, sharedHunks }`, listed only when they share a file with the subject (a file-map entry ending in `/` covers every path under it):

- `job`: every other job in flight (state not `done` or `cancelled`, stage not `backlog` or `done`, kind not `eval`), read the same way as a job subject. A job's open PR is reported as the job, never again as a `pr`.
- `pr`: every other open PR into the subject's base, same-repo and fork, read through `gh` only (the first 50; a full page is a `truncated` gap). Every one is an **outside PR** (`human: true`) unless it is same-repo and its head is a Forge job's branch.
- `push`: a person's commits in the last `overlap.recentHours` hours (docs/CONFIG.md "Overlap check"), one counterpart per branch, ref `<branch>@<newest sha, 12 characters>`.

`files` holds the shared paths, sorted, at most 100. `sharedHunks` holds at most 50 `{ path, start, end }` base-side line spans (1-based, inclusive; an insertion after line k is `[k, k+1]`) where both sides change overlapping lines, and is empty when either side is a file map. Spans come from `git diff -U0` for a job's branch and from the 3-line-context `gh pr diff` or commit diff for GitHub's side (`lib/integrations/git/hunks.ts`).

**Forge's work or a person's.** A commit on the base branch is Forge's when GitHub associates it with a same-repo PR whose head is a Forge job's branch (done jobs included, since their PRs merged there); every other one in the window is a person's, except one already in a job subject's branch (`git merge-base --is-ancestor`). On a Forge job's open PR, commits after `job.pr.pushedSha` (the last push Forge recorded; all of them when it is missing or GitHub no longer lists it) are a person's. Commits on an outside PR's branch make no `push`: the `pr` covers them. Each person's commit is read with one `gh api` commit diff, at most 50 in all.

**`idle`** is true only when no other job is in flight, no person's commit falls in the window (base branch or any open PR branch other than a PR subject's own), and GitHub was read.

## Timing

The first matching row wins:

| # | Condition | Timing | Refs | Reason codes |
|---|---|---|---|---|
| 1 | GitHub could not be read (gap `github-unread`) | `needs-human` | human counterparts' refs | `github-unread` |
| 2 | any `human` counterpart | `needs-human` | those refs | `outside-pr`, `human-push` |
| 3 | any job counterpart that is **ahead** | `wait-for` | those refs | `job-ahead` |
| 4 | any other job counterpart | `merge-first` | those refs | `job-early`, `job-building`, `job-behind` |
| 5 | none | `merge-now` | none | `no-overlap` |

A job is **ready** at `review`, `integrate` or `decide`, or at `pr` with its PR open and checks `passing` or `none`; **early** at `plan`, `spec` or `design`; **building** anywhere else. A ready counterpart is **ahead** when the subject is not ready, or when it was created before the subject (ties go to the smaller ref); otherwise it is `job-behind`. A PR subject counts as ready, created when the PR was. `reasons` names every category present, in the table's order, even those that did not decide the timing; `no-overlap` only when there are no counterparts and GitHub was read.

## Gaps

What the check could not read, each `{ code, ref }`: `github-off` (`pr.enabled: false`, so GitHub is skipped and the timing is not forced), `github-unread` (gh missing, `repoSlug`, a list or history read failing, or a person's commit whose diff could not be read), `job-unread` (a job with no diff and no file map: not a counterpart), `hunks-unread` (a diff that failed or was over its cap; files still count), `paths-dropped` (an unsafe path dropped) and `truncated` (a read hit its cap). For a PR subject a failed GitHub read is an error (`external`, exit 5) instead.

## Output and cache

Agent mode prints `{ subject, timing, idle, reasons, counterparts: [{ kind, ref, source, human, stage, files: <first 5>, fileCount, sharedHunks: <count> }], gaps, report }`; human mode the same, with one fixed sentence per reason. Every run writes the full report atomically to `.forge/runtime/overlap/jobs/<id>.json` or `prs/<n>.json` with its own `schemaVersion` (`lib/core/versions/overlap.ts`). `GET /api/jobs/:id` serves the job's report as `overlap` (null when there is none, it is malformed or a newer Forge wrote it), and the drawer's Details tab shows it as the **Overlaps with** card. Nothing refreshes the report but `forge overlap`.

## Limits

Only files and line spans count, never meaning. Only the root repo of a multi-repo job is checked. Only committed history counts: uncommitted or untracked work in a worktree is invisible. A job's PR counts only when it targets the subject's base, since only those PRs are listed. Push spans from several commits are unioned against different bases, so they are approximate.

## Threat model

The check reads text from people outside the repo and from agents, and runs git and gh as the user, outside any sandbox.

- **A fork PR's author** controls paths, branch names, logins and diff text. Paths with C0 or C1 controls or DEL, absolute paths, `..` paths and paths over 300 characters are dropped and counted (`safePath` in `lib/integrations/github/activity.ts`), so the CLI's human output never prints a terminal escape (the dashboard escapes anyway). Refs that fail `SAFE_REF`, oids that fail `isSha`, logins `sanitizeLogin` would change and non-https urls become null in the parsers. A fork whose head is named like a job's branch stays an outside PR. Its diff is parsed only for paths and line numbers and is never written where an agent reads it, and nothing fetches, checks out or adopts a PR.
- **A builder agent** controls `job.json` (`worktree`, `base`, `pr`) and `spec.md`. `job.worktree` is never read; git runs in the main checkout on `refs/heads/<branch>` (a plain `SAFE_REF` name) with `historyEnv`, so replace objects and grafts can't move a merge base; only commits are diffed, so a worktree's clean filter or config never runs; and `job.pr.number` is never trusted: a job's PR is the one GitHub lists with its branch as a same-repo head. File-map paths pass `specFileMapPaths`' checks and never reach argv, and no pathspec is ever passed, so `:(…)` magic can't apply. `spec.md` is read through one no-follow, non-blocking descriptor, so a planted FIFO can't hang the check.
- **Option injection.** A PR number, sha, slug or ref is checked before it reaches argv (`createGhGitHub`), and the branch reaches GraphQL as a `-f` variable, never inside the query text.
- **A false all-clear.** When GitHub was tried and failed, the timing is `needs-human` and `idle` is false, so a shepherd can never read silence as safety.
