# Verifiers

The review panel is the expensive part of a round: broad lenses, full agents, the whole diff. A **verifier** is the opposite: one yes/no question your repo's maintainers wrote, scoped to file globs. After `forge verify` passes and before any reviewer starts, a small model (`runtime.models.verifier`, `haiku` by default) answers each matching verifier against only the hunks of the files it covers. A `block` verifier that fails sends the builder back without spawning the panel; a `warn` verifier only annotates, so a new check can prove itself before it gates anything.

```
build ─► verify ─► verifiers ─► review panel
  ▲         │          │ block failure
  └─────────┴──────────┘
```

## Writing one

A verifier is `.forge/verifiers/<name>.md`. The directory is the on/off switch: with no `*.md` file there, nothing changes, no command runs and no event is written.

```markdown
---
paths: [lib/cli/commands/**]
severity: major
mode: block
---
Does every new `forge` subcommand in this diff have a row in its group's HELP table?

`forge help` and docs/CLI.md's command tables are generated from HELP, so a missing row hides the command.
```

- **`<name>`** matches `^[a-z0-9][a-z0-9-]{0,63}$`.
- **`paths`** (required): a non-empty list of globs, relative to the repo, not starting with `-`, `!` or `:`, with no `..` segment. A glob matches like the spec's Approach paths (`inSpec` in `lib/core/glob.ts`): an exact path, a directory prefix (`docs/`), `**`, `*` and `?`, and a slash-free glob (`'*.md'`, quoted because YAML reads a bare `*` as an alias) also matches the basename at any depth.
- **`severity`**: `blocker`, `major` (default) or `minor`.
- **`mode`**: `warn` (default) or `block`.
- **The body** (at most 2,000 characters): its first non-empty line is **the question** (at most 300 characters), and the rest is the rationale the model also reads. Phrase it so that **yes means the change is fine**.

Any other frontmatter key, a missing or empty `paths`, an invalid value, an empty body, a long question, a bad file name, a symlink, a subdirectory or a file over 16 KiB makes the file a **problem**: it never runs, never blocks a job, and is listed by `forge verifiers list`, in `forge verifiers run`'s output (`problems: <n>`) and at the end of the round's report. Only the first 50 files by name are read; the rest are problems too.

`forge verifiers list` prints what will run and what won't: `{ dir, verifiers: [{ name, paths, severity, mode, question }], problems: [{ file, problem }] }`.

## Where they are read from

Always the **main checkout**, never a job's worktree or branch, the same rule as `.forge/config.yml` and `.forge/secrets-allow.txt`. A job that adds or edits a verifier on its branch changes nothing until that change is merged and lands in the main checkout. `forge job step` counts the main checkout's `.forge/verifiers/*.md` to decide whether the gate runs at all.

## Before the build

The builder sees the questions before it writes code. A fresh builder brief (round 1, or a round whose only rework input is an answered question) carries a `Verifier questions (JSON)` line: `<name> · <question>` for each of the main checkout's valid verifiers with a `paths` glob matching a path in the spec's Approach › `Files:` table, the same glob match the round uses on the diff, at most 20 with ` (+<k> more)` past that. Problem files and a worktree's `.forge/verifiers/` never appear, and a spec without a `Files:` table gets no line. Above it, a `Review checklists (JSON)` line maps each lens on the job's panel to the checklist that lens reviews against. Both lines carry paths and the parsed one-line questions only, never a checklist or a verifier's rationale, and a findings-first rework brief carries neither. The builder prompt asks the builder to meet them as standards, not to copy them into `tasks.md`.

## What happens in a round

Inside the verify stage, after the round's last verify passed (`forge job step` rules VF1–VF3):

1. **`forge verifiers run <id>`** (VF1) diffs the job's merge-base against the commit the passing verify checked (not HEAD), selects every verifier with at least one glob matching a changed file, and writes:
   - `verify/round-<n>-verifiers-input.md`: the model's input, one section per selected verifier (severity, mode, its files, its whole body) and one per diff file;
   - `verify/round-<n>-verifiers-run.json`: a snapshot of the selection;
   - a `verifiers` event with `phase: run`.

   When nothing matches, it writes the PASS report straight away instead, with a `phase: record` event, and the job moves on to review.
2. **The verifier agent** (VF2, `forge:verifier`, tools `Read` and `Write` only) reads the input and writes `verify/round-<n>-verifier-answers.md`, one line per verifier: `- <name>: YES` or `- <name>: NO — <path>:<line> <reason>`. It answers NO only for a concrete violation it can point to, and YES when unsure: the panel still reads the whole change. An agent that ends without the file gets one retry (VF2b).
3. **`forge verifiers record <id>`** (VF3) writes `verify/round-<n>-verifiers.md` in the review file format:
   ```
   VERDICT: PASS | CHANGES

   Round <n> · <sha12> · <k> of <m> verifiers matched · model <model> · <time>

   ## Findings
   - [<severity>] <location> — <name>: <question> · answer: NO, <reason>
   ## Warnings (warn mode, never blocks)
   - warn <severity> <location> — <name>: <question> · answer: …
   ## Passed
   - <name>
   ## Problems
   - problem "<file>": <problem>
   ```
   A block verifier answered NO, or not at all, goes under Findings; a warn verifier under Warnings; a YES under Passed.

### Modes and `blockOn`

The verdict comes from the same counting a reviewer's file gets: `CHANGES` when a Findings line carries a severity in `review.blockOn` (default `[blocker, major]`), else `PASS`. So a `mode: block`, `severity: minor` failure is reported but doesn't block under the default policy, exactly like a reviewer's minor finding. Warnings never block.

**On CHANGES** the failure is a failed verify attempt of the same round, bound to the same commit: `record` appends `{ ok: false, failure: 'verifiers', file: 'verify/round-<n>-verifiers.md' }` to the job's verify runs, sets the round's verify to `FAIL` and counts a verify retry. The job goes back to build (V3b), and the builder's brief says `Rework: verifiers` with the report as its input. The rework stays in the same round, so `pipeline.maxRounds` isn't spent on it, but `pipeline.budget.verifyRetries` bounds a verifier the builder keeps failing. A PR can't open on that commit, since its last verify run failed. After the fix, verify runs again and then the verifiers run again.

**On PASS** the job goes to review (or to `pr` for a PR rework under `review.onPrFeedback: none`). Reviewers and the approver get the report in their inputs, so warnings reach the panel.

Verifiers run only in the verify stage: the verifies inside integrate and the `pr` stage don't run them.

### Answers fail closed

The answers file counts only if it is a regular file (not a symlink) of at most 64 KiB. Only lines outside code fences count, matching `- <name>: YES|NO` (case-insensitive). For each selected verifier the answer is `yes` when every line naming it says YES, `no` when any says NO, and `none` (`no valid answer from the verifier model` in the report) when no line names it or the file is missing or unreadable. Lines naming a verifier that wasn't selected are ignored. `forge verifiers run` deletes any earlier answers file, so a stale answer never counts. The reason is forced onto one line and capped at 300 characters; its first token becomes the finding's location when it names one of that verifier's files.

### Files

Each round's `verify/` directory holds the input, the snapshot, the answers and the report, beside `round-<n>.md`. A second `verifiers run` in the same round (after a rework) renames the earlier report to `round-<n>-verifiers-attempt-<k>.md`, where `<k>` is the attempt of the verify run that report checked. They show in the dashboard's Files tab like the other `verify/` files, and the drawer's verdict matrix gains a **Verifiers** column (PASS, PASS with warnings, CHANGES) once a job has a record.

## Commands

| Command | Does | Exits |
|---|---|---|
| `forge verifiers list` | the valid verifiers and the problems; needs no job | 0 |
| `forge verifiers run <id>` | selects and writes the input (or the PASS report) | 1: no job, no worktree, or no passing verify in the round; 5: git failed |
| `forge verifiers record <id>` | turns the answers into the report; on CHANGES, the failed verify run | 1: no job, or no pending run in the round; 5: git failed |

`forge job advance` runs `run` and `record` inline, like `forge verify`.

## Stats and retro

`forge stats` (and `/api/stats`) reports `verifiers.<name>` from the window's record events: `runs`, `fails` (NO), `unanswered` (no valid answer), `blocks` (NO or no answer in block mode) and `hitRate` (`fails / runs`, null at 0 runs). The text form prints one `verifiers:` line.

`quality.verifierFirstRoundBlockRate` (JSON and `/api/stats` only) is the share of jobs whose first round-1 verifiers record blocked: of the jobs whose first `verifiers` record event of round 1 has results, those whose outcome was CHANGES, null when none has. Re-runs after a verifiers rework and later rounds don't count, so it measures what the first build got right.

The retro proposes verifiers as part of the repo layer: a new one, always `mode: warn` first, for a class of issue that recurs in PR feedback or review findings across two or more jobs and fits one yes/no question over file globs; promoting a warn verifier to `block` once its hits were fixed rather than disputed; and deleting one with `runs` ≥ 10 and `hitRate` 0. Its metric is a `stats.json` path such as `verifiers.<name>.hitRate`. Promotion is never automatic: a human merges it.

Verifier files feed `configHash` (eval runs) and the `verifier` agent's prompt hash on the roster, so a changed verifier shows up as a changed configuration.

## Security

- **The diff is hostile data.** The builder wrote it, possibly with text aimed at the model. The input fences every question and hunk in a backtick run longer than any inside it, after CR, U+2028, U+2029 and NEL became line feeds, and paths appear only JSON-encoded, so nothing in the diff, a file name or a question can close a fence or start a section. The agent's brief carries paths and a count, never verifier or diff text.
- **Git can't reshape the diff.** It runs with the integrity report's pinned config (`core.quotepath=off`, `diff.relative=false`, …), `--no-ext-diff --no-textconv --text --no-renames -U3`, and replace objects and grafts ignored, so attributes, drivers, worktree config and `git replace` can't hide hunks or move paths. A rename counts as its deleted and its added path, so globs on either side match.
- **The job dir isn't trusted either.** `record` re-derives the selection, modes and severities from the main checkout and the verified diff, not from the snapshot an agent could edit.
- **A daemon session can't weaken one.** `Edit(.forge/verifiers/**)` is in the daemon's disallowed tools, and `.forge/verifiers/` is part of the trust digest (symlinks hash as links), so a change while the daemon runs stops it.

**Residual risk.** A model persuaded to answer YES makes a verifier useless, but never weaker than having no verifier: the panel still reviews the change. The verifier agent has only `Read` and `Write`, but like every agent it is not a security boundary.

## Limits

- At most 50 verifier files of 16 KiB each; a body of at most 2,000 characters and a question of at most 300.
- Each diff file's hunks are cut at a line boundary at 40,000 characters (`… <k> more lines not shown`), and files are added in path order until the input holds 200,000 characters of diff; later files are listed as `omitted (diff too large)`. A verifier with a cut or omitted file is marked `truncated` in the snapshot, and the agent is told to answer YES where it can't see the code.
- Each diff file appears once in the input, however many verifiers match it.
- A file whose diff has no hunk (a mode change, an empty file) is never matched.
