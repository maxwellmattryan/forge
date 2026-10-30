# Design note: lean exploration

Status: not measured. No child ran, so there are no numbers here and no model reported one. The spike could not start from the builder's job session (see [Method](#method) › Why it did not run). Claude Code 2.1.311 (`claude --version`) was on the machine. A person runs the [Appendix](#appendix-rerunning) from their own terminal, and a later round fills in Results, Decision and Recommendation from those runs.

## Why

Agents keep everything they read for the rest of a run, and 96% of a job's tokens are cache reads, so a whole-file Read early on is paid again on every later turn. #576 gives the roles lean reading rules: a Reading paragraph, `Lines` ranges in the spec-writer's **file map** (#379) that the builder starts from, and reviewers that read the round's hunks (beside #293, where round 2+ sees what changed). It measures them, and an exploration subagent, against today's prompts before any of it becomes the default. #376's context session changes where context comes from, not how much an agent reads, so it is out of this comparison.

## Method

**Why it did not run.** The builder runs as a Forge daemon job session, and Forge refuses what the spike needs from inside one:

- `forge job new` against a scratch clone (`FORGE_ROOT` and `FORGE_HOME` inside the scratch root) exited 1 with: `forge refuses to run in this daemon session: a file Forge trusts (...) changed since a human started the daemon (or this is another checkout).` `forge job agent run` refuses the same way, and also refuses any job but the session's own (`lib/cli/commands/job/agent-run.ts`).
- The write guard refused the scratch config overrides: `a daemon session may write only inside a job folder under .forge/jobs/<id>/ ... or a job worktree`.

Both are deliberate confinement. The builder did not unset `FORGE_DAEMON` or its scope to get around them: the spec forbids changing permissions to make a run work. So the spike needs a person's terminal. The scratch root was removed, no `claude` child was started, and the spend was $0.

**Jobs.** Three merged jobs of different sizes from the main checkout's `.forge/jobs/`. Each base is the parent of the job's squash commit on `develop`:

| Size | Job | Title | PR | Base | Merge | Files changed |
|---|---|---|---|---|---|---|
| S | `295-tests-fail-when-a-version-2` | Tests fail when a version bump leaves the docs behind | #661 | `f5de4b21` | `374dad39` | 8 |
| M | `285-spec-approval-notes-reach-the-2` | Spec-approval notes reach the builder | #667 | `374dad39` | `ede09b00` | 23 |
| L | `380-fewer-agent-hops-on-a` | Fewer agent hops on a clean run: no planner for one job, no approver on a clean pass | #671 | `01128bc4` | `6b19d6d7` | 42 |

All three have a `request.md`. It is untrusted data, so the runs read a read-only copy and this note quotes only the titles.

**Arms.** Each arm is a plugin dir, a scratch `git clone` of the repo, never a worktree of the main checkout:

| Arm | Plugin dir | What differs |
|---|---|---|
| A, today | `<plugin-a>`: develop at `git merge-base origin/develop HEAD` (`6b19d6d7`) | nothing |
| B, lean reading | `<plugin-b>`: this branch at the Phase 1 commit | the Reading paragraph, the `Lines` hand-off, the builder's ranges first, the reviewer's hunks |
| C, lean + explorer | `<plugin-c>`: B's clone plus the uncommitted edits in the Appendix | an `explorer` subagent (haiku, Read/Grep/Glob) for the spec-writer and the builder |

**Route.** Every run goes through the arm's own `forge` (`<plugin-x>/bin/forge`): `job new`, `job advance --session`, then `job agent run --cold` for each spawn. That records usage, composition and timing in the scratch `job.json`. `--cold` keeps each run one child. Without it a review lens forks a context session, and the context child's reads would land in the fork's peak. A **role run** loads only its `--plugin-dir` plugin (`--setting-sources ''` in `roleArgv`, [`argv.ts`](../../lib/integrations/claude/argv.ts)), so a user-installed Forge can't stand in for an arm's prompts.

**Runs per job** (10 per job, 30 in all):

1. The spec-writer in each arm.
2. The builder on that arm's own spec, end to end.
3. `forge verify` (with any verifier spawns it brings).
4. A round-1 code-lens review of each arm's diff by **arm A's reviewer prompt**, a fixed quality judge.
5. Arm B's reviewer on arm A's round-1 diff, with the same brief, worktree HEAD and inputs as step 4's arm-A review. This is the reviewer measurement: A against B on identical input.

The models are the configured defaults: opus for the spec-writer and builder, sonnet for reviewers, and never haiku for a role. One job's three arms run concurrently, so they share conditions. The jobs run one after another. The runs stop when the summed spend reaches $150.

**Measures, per run:**

- **wall minutes**: agent start to agent end (`wallMs` in `forge job agent run`'s result).
- **time to first edit** (builder only): seconds from the transcript's first line to its first `Edit` or `Write` tool_use.
- **turns**: distinct main-loop assistant `message.id`s in the transcript.
- **peak context**: the run's `composition.total` in `runHistory`, the size of its last request.
- **totalTokens**: the run's `usage.totalTokens`. Arm C adds its explorer transcripts (`<session>/subagents/agent-*.jsonl`, read as `importClaudeCodeTranscript` in [`usage.ts`](../../lib/engine/metrics/usage.ts) reads them) and states the explorer's share.
- **Read+Bash share**: the `Read` and `Bash` parts of `composition.tools` over `composition.total`.

**Quality cells:**

- spec-writer: `forge job acs --json` `incomplete` is empty, and the **file-map recall**: the share of the merged PR's changed files (`git diff --name-only <base> <merge>`) that `specFileMapPaths` ([`acs.ts`](../../lib/engine/pipeline/acs.ts)) finds in the arm's spec.
- builder: the verify result, and the fixed judge's verdict with its blocker + major count.
- reviewer: the verdict, and the blocker + major count.

**Spend.** $0. No child ran. The cap for the spike is $150, summed over each run's `result.total_cost_usd`.

## Results

Not measured: no run took place. The three tables (spec-writer, builder and reviewer:code, a row per job × arm and a median row per arm) are filled in from the Appendix's runs.

## Decision

The rule below is pre-registered and quoted verbatim from the spec. It has not been applied because there are no runs. Until it is, the branch carries arm B's prompts as they stood at the Phase 1 commit.

> **Decision rule** (pre-registered; restate verbatim in the note). For role R and lean arm X (B for spec-writer, builder and reviewer:code; C for spec-writer and builder), compared with arm A over the three jobs:
> 1. *Not slower*: the median over jobs of wall(X)/wall(A) is ≤ 1.10.
> 2. *Lighter*: the median over jobs of peak(X)/peak(A) is ≤ 0.95, and of totalTokens(X)/totalTokens(A) is ≤ 1.00.
> 3. *Not worse*:
>    - spec-writer: on every job X's spec has empty `incomplete`, and its file-map recall is ≥ A's − 0.15;
>    - builder: on every job where A's verify passed, X's passed, and X's summed judge blocker + major over the jobs is ≤ A's + 1;
>    - reviewer:code: the verdict equals A's on at least 2 of 3 jobs, and the summed blocker + major is ≥ A's − 1.
>
> X passes for R when all three hold. A missing or failed cell fails the rule.

The outcomes, also from the spec:

- B passes for R: R's lean changes stay.
- B fails for R: R's Phase 1 hunks in `agents/<R>.md` go back to develop's text, its Reading paragraph included.
- The spec-writer fails: the builder's `Lines` instruction goes back to "open those files first", even if the builder passes.
- The eight unmeasured agents keep the paragraph only when B passes for both the spec-writer and the builder.
- C passes for the spec-writer or the builder, and is not slower than B by rule 1's ratio: the Recommendation proposes a follow-up issue. Otherwise it recommends against, citing rows.

## Appendix: rerunning

Run all of this from a person's own terminal, not from a Forge daemon session (`FORGE_DAEMON` unset). The builder never changes Claude Code settings, credentials or permissions to make a run work, and neither does this procedure.

**Placeholders.**

- `<main>`: the Forge main checkout.
- `<scratch>`: `mktemp -d "${TMPDIR:-/tmp}/forge-576.XXXXXX"`, outside both checkouts.
- `<plugin-a>`, `<plugin-b>`, `<plugin-c>`: `<scratch>/plugin-a`, `-b` and `-c`.
- `<clone>`: `<scratch>/t-<size>-<arm>`, one per job × arm (nine).
- `<base>`, `<merge>`: the Jobs table's columns.
- `<phase-1>`: this branch's Phase 1 commit, the one titled `feat(prompts,stats): …` in its log.
- `<job>`: the scratch job id `job new` prints.

Every command runs with `FORGE_ROOT=<clone>` and `FORGE_HOME=<scratch>/home`.

**1. Plugins.**

```
git clone -q <main> <plugin-a> && git -C <plugin-a> checkout -q --detach 6b19d6d7 && git -C <plugin-a> remote remove origin
git clone -q <main> <plugin-b> && git -C <plugin-b> checkout -q --detach <phase-1> && git -C <plugin-b> remote remove origin
git clone -q <plugin-b> <plugin-c> && git -C <plugin-c> remote remove origin
```

**2. Arm C's scratch edits** (in `<plugin-c>`, never committed):

- New `agents/explorer.md`:

  ```
  ---
  name: explorer
  description: Scratch explorer for the lean-exploration spike. Answers one broad question about the code with paths, line ranges and one-line conclusions.
  model: haiku
  tools: Read, Grep, Glob
  ---

  You answer exactly one broad question about the repository in your working directory, such as what touches X or where Y is defined. Find with Grep and Glob, and Read only the ranges you need to confirm an answer.

  Return at most 40 lines, each `<path>:<start>-<end> — <one-line conclusion>`. Never paste file contents, and never change a file.
  ```

- `agents/spec-writer.md` and `agents/builder.md`: append `, Agent` to the `tools:` line. Append this sentence to the end of each one's Reading paragraph: "For a broad search (what touches X, where is Y defined), ask the `explorer` agent with the Agent tool, then Read only the ranges it returns."
- The CLI: no patch is expected. `forge job agent run` passes the agent's `tools:` as `--tools`, `Agent` matches `BUILTIN_TOOL` in `argv.ts`, and `daemon.allowedTools` already allows `Agent`. Check that the first arm-C spec-writer's `system`/`init` event lists `Agent` in `tools` and `forge:explorer` in `agents`. If it doesn't, write down here the smallest patch that makes it so.

**3. Target clones**, for each size and each arm (`a`, `b`, `c`):

```
git clone -q --no-checkout <main> <clone> && git -C <clone> checkout -q -B develop <base> && git -C <clone> remote remove origin
git -C <clone> remote -v        # prints nothing; keep the output for build.md
```

Before any run, set these overrides in `<clone>/.forge/config.yml` and commit them to `develop` (`git -C <clone> commit -qam "spike: scratch overrides"`). Verify reads the base branch's config.

- `tracker.kind: local`
- `pipeline.plan: never`, `pipeline.specApproval: never`, `pipeline.maxRounds: 1`
- `review.panel`: only the `code` entry

Run `npm ci` once per base in its arm-a clone, then copy that `node_modules` to the base's other two clones. Copy each job's `request.md` from `<main>/.forge/jobs/<job id>/` to `<scratch>/requests/<size>.md`, then `chmod a-w` it.

**4. Drive one job × arm** with the arm's own CLI, `F=<plugin-x>/bin/forge`:

```
export FORGE_ROOT=<clone> FORGE_HOME=<scratch>/home
$F job new --title "<title>" --body-file <scratch>/requests/<size>.md --session spike
$F job advance <job> --session spike               # repeat: runs the run actions (worktree, verify, ...) up to the next spawn
$F job agent run <job> --session spike --cold      # for each spawn that is not a reviewer: spec-writer, builder, verifiers
```

Stop at the first reviewer spawn. Keep every `agent run` result line (`wallMs`, `usage`, `agentId`, `jobCostUsd`). For the first spec-writer, check that its `forge` calls resolved under `<scratch>`: its transcript's Bash results name only `<scratch>` paths. If verify fails, no review is spawned: that run's judge cell is `not run`.

**5. Reviews.** For arm A's job, at its reviewer spawn, run step 5's measurement first:

```
cp -Rp <clone>/.forge/jobs/<job> <scratch>/snap-<size>
$F job step <job> --json > <scratch>/brief-<size>-1.json
<plugin-b>/bin/forge job agent run <job> --session spike --cold     # arm B's reviewer on arm A's diff
# keep review/round-1/code.md and the run's runHistory entry, then restore:
rm -rf <clone>/.forge/jobs/<job> && cp -Rp <scratch>/snap-<size> <clone>/.forge/jobs/<job>
$F job step <job> --json > <scratch>/brief-<size>-2.json              # must equal brief-<size>-1.json
```

Then, for each arm's job, run the fixed judge: `<plugin-a>/bin/forge job agent run <job> --session spike --cold`.

**6. Read the measures.**

- `<clone>/.forge/jobs/<job>/job.json` › `agents.<role>.runHistory` (last entry): `composition.total`, `composition.tools`, `usage.totalTokens`.
- The transcript, `~/.claude/projects/<slug of the worktree>/<agentId>.jsonl`, gives turns and time to first edit. Arm C's explorer transcripts sit under `<agentId>/subagents/`.
- `review/round-1/code.md`: its `VERDICT:` line, plus the count of `[blocker]` and `[major]` findings.
- File-map recall: `git -C <main> diff --name-only <base> <merge>` against `specFileMapPaths` of the arm's `spec.md`.
- Spend: the sum of each job's last `jobCostUsd`, plus step 5's extra review. Stop at $150.

**7. Clean up.**

```
rm -rf <scratch>
test ! -e <scratch>
ls ~/.claude/projects | grep forge-576          # check the list, remove each folder, then:
ls ~/.claude/projects | grep -c forge-576       # 0
git -C <main> worktree list                     # no scratch path
```
