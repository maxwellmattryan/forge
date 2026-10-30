# Design note: lean exploration

Status: measured 2026-10-30 on Claude Code 2.1.311 (`claude --version`), with Node 22.18.0 for every `forge` call and verify. The runs reported these models: `claude-opus-5-5` for the spec-writer and builder, `claude-sonnet-5-5` for reviewer:code (effort high) and for S's discarded builder attempts 1–2, and `claude-haiku-5-5` for verifiers. A person ran the [Appendix](#appendix-rerunning) from their own terminal, because the builder's daemon job session can't run `forge` against another checkout (see [Method](#method)). The builder wrote this note from their numbers.

## Why

Agents keep everything they read for the rest of a run, and 96% of a job's tokens are cache reads, so a whole-file Read early on is paid again on every later turn. #576 proposed lean reading rules: a Reading paragraph, `Lines` ranges in the spec-writer's **file map** (#379) that the builder starts from, and reviewers that read the round's hunks (beside #293, where round 2+ sees what changed). This note measures them, and an exploration subagent, against today's prompts before any of it becomes the default. #376's context session changes where context comes from, not how much an agent reads, so it is outside this comparison.

## Method

**Who ran it.** The builder runs as a Forge daemon job session, and Forge refuses what the spike needs from inside one. When pointed at a scratch clone, `forge job new` exits 1 with `forge refuses to run in this daemon session: a file Forge trusts (...) changed since a human started the daemon (or this is another checkout).` The write guard also refuses writes outside the job's folder and worktree. The builder did not get around either. A person ran the Appendix with `FORGE_DAEMON` unset.

**Jobs.** Three merged jobs of different sizes from the main checkout's `.forge/jobs/`. Each base is the parent of the job's squash commit on `develop`:

| Size | Job | Title | PR | Base | Merge | Files changed |
|---|---|---|---|---|---|---|
| S | `295-tests-fail-when-a-version-2` | Tests fail when a version bump leaves the docs behind | #661 | `f5de4b21` | `374dad39` | 8 |
| M | `285-spec-approval-notes-reach-the-2` | Spec-approval notes reach the builder | #667 | `374dad39` | `ede09b00` | 23 |
| L | `380-fewer-agent-hops-on-a` | Fewer agent hops on a clean run: no planner for one job, no approver on a clean pass | #671 | `01128bc4` | `6b19d6d7` | 42 |

Each `request.md` is untrusted data, so the runs read a read-only copy and this note quotes only the titles.

**Arms.** Each arm is a plugin dir, a scratch `git clone` of the repo and never a worktree of the main checkout:

| Arm | Plugin dir | What differs |
|---|---|---|
| A, today | `<plugin-a>`: develop at `git merge-base origin/develop HEAD` (`6b19d6d7`) | nothing |
| B, lean reading | `<plugin-b>`: this branch's Phase 1 commit (`edd5b7ed`) | the Reading paragraph, the `Lines` hand-off, the builder's ranges first, the reviewer's hunks |
| C, lean + explorer | `<plugin-c>`: B plus the uncommitted edits in the Appendix | an `explorer` subagent (haiku, Read/Grep/Glob) for the spec-writer and the builder |

Arm C's children got `--tools …,Agent` and had the explorer's description in context. Still, **no arm-C run called the Agent tool**: its 6 runs left 0 subagent transcripts. So arm C measured "B plus an unused explorer".

**Scratch shape.** Nine target clones, one per job × arm, at the Jobs table's bases. Each printed nothing for `git remote -v` (9 of 9 checked). Each had these overrides committed to `develop` before any run: `tracker.kind: local`, `pipeline.plan: never`, `pipeline.specApproval: never`, `pipeline.maxRounds: 1`, `pr.enabled: false`, and a `review.panel` of only `code`. Every command and child ran with `FORGE_ROOT` and `FORGE_HOME` inside the scratch root.

**Route.** Every run went through the arm's own `forge` (`<plugin-x>/bin/forge`): `job new`, `job advance --session`, then `job agent run --cold` for each spawn. `--cold` keeps each run one child, so no context session's reads land in a review's peak. A **role run** loads only its `--plugin-dir` plugin (`--setting-sources ''` in `roleArgv`, [`argv.ts`](../../lib/integrations/claude/argv.ts)), so a user-installed Forge can't stand in for an arm's prompts.

**Runs per job:**

1. The spec-writer in each arm.
2. The builder on that arm's own spec.
3. `forge verify` with its verifiers.
4. A round-1 code-lens review of each arm's diff by **arm A's reviewer prompt**, a fixed quality judge.
5. Arm B's reviewer on arm A's round-1 diff, with the same brief, worktree HEAD and inputs as step 4's arm-A review. The two briefs were byte-identical. Each job's three arms ran concurrently, and the jobs ran one after another.

**Measures, per run:**

- **wall minutes**: agent start to agent end.
- **time to first edit** (builder only): seconds from the transcript's first line to its first `Edit` or `Write` tool_use.
- **turns**: distinct main-loop assistant `message.id`s.
- **peak context**: the run's last request (input, cache read and cache write). `forge job agent run` records no `composition`, so this and the Read+Bash share came from each transcript through `composeContext` ([`composition.ts`](../../lib/engine/metrics/composition.ts)), arm A's code for every arm.
- **totalTokens**: the run's usage from its result line. Arm C's explorer share is 0 everywhere, because no explorer ran.
- **Read+Bash share**: the `Read` and `Bash` parts of the composition's `tools` over its total.

**Quality cells:**

- spec-writer: `forge job acs --json` `incomplete`, and the file-map recall. That is the share of the merged PR's changed files (`git diff --name-only <base> <merge>`) that `specFileMapPaths` ([`acs.ts`](../../lib/engine/pipeline/acs.ts)) finds in the arm's spec.
- builder: the verify result, plus the fixed judge's verdict with its blocker + major count.
- reviewer: the verdict, plus the blocker + major count.

**Spend.** $74.97 in all, under the $150 cap. That is the sum of each scratch job's last `jobCostUsd`, plus $9.45 of discarded runs (see [Limits](#limits)) and $0.63 for step 5's extra review.

## Results

### Spec-writer (opus, effort high)

| Job | Arm | wall min | turns | peak context | totalTokens | Read+Bash | incomplete | file-map recall |
|---|---|---|---|---|---|---|---|---|
| S | A | 3.64 | 24 | 79,774 | 1,225,820 | 0.53 | [] | 0.750 |
| S | B | 3.91 | 26 | 80,139 | 1,223,219 | 0.51 | [] | 0.875 |
| S | C | 2.99 | 20 | 73,918 | 1,004,453 (explorer 0) | 0.24 | [] | 0.750 |
| M | A | 7.86 | 50 | 151,245 | 4,395,011 | 0.57 | [] | 0.652 |
| M | B | 5.92 | 43 | 112,333 | 3,046,389 | 0.50 | [] | 0.391 |
| M | C | 11.48 | 59 | 154,906 | 5,036,528 (explorer 0) | 0.36 | [] | 0.696 |
| L | A | 10.71 | 43 | 212,216 | 5,413,450 | 0.75 | [] | 0.762 |
| L | B | 12.32 | 61 | 220,227 | 7,883,443 | 0.72 | [] | 0.762 |
| L | C | 14.73 | 67 | 232,048 | 8,284,449 (explorer 0) | 0.57 | [] | 0.762 |
| median | A | 7.86 | 43 | 151,245 | 4,395,011 | 0.57 | | 0.750 |
| median | B | 5.92 | 43 | 112,333 | 3,046,389 | 0.51 | | 0.762 |
| median | C | 11.48 | 59 | 154,906 | 5,036,528 | 0.36 | | 0.750 |

### Builder (opus; S is attempt 3)

| Job | Arm | wall min | first edit s | turns | peak context | totalTokens | Read+Bash | commits | verify | judge (A's reviewer) |
|---|---|---|---|---|---|---|---|---|---|---|
| S | A | 0.08 | – | 1 | 17,293 | 17,472 | 0 | 0 | not run (contract-stop) | not run |
| S | B | 1.61 | 20 | 12 | 46,220 | 454,046 | 0.45 | 1 | pass | PASS · 0 blocker+major |
| S | C | 0.10 | – | 1 | 21,940 | 22,217 (explorer 0) | 0 | 0 | not run (contract-stop) | not run |
| M | A | 13.61 | 123 | 75 | 267,284 | 13,687,188 | 0.62 | 3 | fail (base test + docs:map) | not run |
| M | B | 6.10 | 41 | 50 | 100,166 | 3,563,697 | 0.48 | 2 | fail (base test + layout cap) | not run |
| M | C | 17.80 | 84 | 80 | 199,794 | 10,648,146 (explorer 0) | 0.56 | 2 | fail (stray untracked file) | not run |
| L | A | 31.15 | 185 | 119 | 441,465 | 35,059,086 | 0.67 | 3 | pass | PASS · 0 |
| L | B | 29.29 | 86 | 127 | 344,583 | 27,454,953 | 0.51 | 2 | pass | PASS · 0 |
| L | C | 27.56 | 165 | 125 | 350,654 | 28,930,123 (explorer 0) | 0.46 | 3 | pass | PASS · 0 |
| median | A | 13.61 | 154 (n 2) | 75 | 267,284 | 13,687,188 | 0.62 | | | |
| median | B | 6.10 | 41 | 50 | 100,166 | 3,563,697 | 0.48 | | | |
| median | C | 17.80 | 124.5 (n 2) | 80 | 199,794 | 10,648,146 | 0.46 | | | |

For reference, S attempt 2's arm-B builder (sonnet, effort low) took 2.26 min and 10 turns, peaked at 39,940, used 327,972 tokens, and passed verify.

### Reviewer:code (sonnet), step 5: A and B on arm A's L round-1 diff

| Job | Arm | wall min | turns | peak context | totalTokens | Read+Bash | verdict | blocker+major |
|---|---|---|---|---|---|---|---|---|
| S | A, B | not run | | | | | | |
| M | A, B | not run | | | | | | |
| L | A | 2.43 | 14 | 108,088 | 1,008,968 | 0.74 | PASS | 0 |
| L | B | 2.37 | 12 | 121,057 | 1,030,090 | 0.78 | PASS | 0 |
| median | A | 2.43 | 14 | 108,088 | 1,008,968 | 0.74 | | |
| median | B | 2.37 | 12 | 121,057 | 1,030,090 | 0.78 | | |

S has no step-5 cell because arm A's S builder never reached review. M has none because its base fails verify (see [Limits](#limits)).

## Decision

The rule, pre-registered in the spec and quoted verbatim:

> For role R and lean arm X (B for spec-writer, builder and reviewer:code; C for spec-writer and builder), compared with arm A over the three jobs:
> 1. *Not slower*: the median over jobs of wall(X)/wall(A) is ≤ 1.10.
> 2. *Lighter*: the median over jobs of peak(X)/peak(A) is ≤ 0.95, and of totalTokens(X)/totalTokens(A) is ≤ 1.00.
> 3. *Not worse*:
>    - spec-writer: on every job X's spec has empty `incomplete`, and its file-map recall is ≥ A's − 0.15;
>    - builder: on every job where A's verify passed, X's passed, and X's summed judge blocker + major over the jobs is ≤ A's + 1;
>    - reviewer:code: the verdict equals A's on at least 2 of 3 jobs, and the summed blocker + major is ≥ A's − 1.
>
> X passes for R when all three hold. A missing or failed cell fails the rule.

Ratios per job are X over A, listed as S / M / L → median:

| Role | Arm | wall | peak | totalTokens | 3. Not worse | Outcome |
|---|---|---|---|---|---|---|
| spec-writer | B | 1.074 / 0.753 / 1.150 → **1.074** ✓ | 1.005 / 0.743 / 1.038 → **1.005** ✗ | 0.998 / 0.693 / 1.456 → **0.998** ✓ | ✗ `incomplete` is empty on all three, but M's recall is 0.391 < 0.652 − 0.15 = 0.502 | **fails** (rules 2, 3) |
| spec-writer | C | 0.821 / 1.461 / 1.375 → **1.375** ✗ | 0.927 / 1.024 / 1.093 → **1.024** ✗ | 0.819 / 1.146 / 1.530 → **1.146** ✗ | ✓ recall 0.750 / 0.696 / 0.762 against floors 0.600 / 0.502 / 0.612 | **fails** (rules 1, 2) |
| builder | B | 20.1 / 0.448 / 0.940 → **0.940** ✓ | 2.673 / 0.375 / 0.781 → **0.781** ✓ | 25.99 / 0.260 / 0.783 → **0.783** ✓ | ✓ A's verify passed only on L, and B passed there. Judge blocker + major: B 0 (S, L) ≤ A 0 (L) + 1 | **passes** |
| builder | C | 1.250 / 1.308 / 0.885 → **1.250** ✗ | 1.269 / 0.748 / 0.794 → **0.794** ✓ | 1.272 / 0.778 / 0.825 → **0.825** ✓ | ✗ its S cell failed (contract-stop, no build). On L verify passed, judge 0 ≤ 0 + 1 | **fails** (rule 1, failed cell) |
| reviewer:code | B | – / – / 0.975 → **0.975** ✓ | – / – / 1.120 → **1.120** ✗ | – / – / 1.021 → **1.021** ✗ | ✗ the verdict matches on 1 job; the rule needs 2 of 3. S and M are missing | **fails** (rules 2, 3, missing cells) |

How the rule was read where cells are missing:

- **S's builder ratios.** Arm A's S builder stopped after one message and made no change, so its S ratios compare a build with no build. Over the three jobs, as the rule says, builder B's medians are 0.940, 0.781 and 0.783, and C's wall median is 1.250. Over M and L alone they are 0.694, 0.578 and 0.522 for B, and 1.096, 0.771 and 0.802 for C. Builder B passes and builder C fails either way: C on rule 1 over three jobs, and on its failed S cell in both readings.
- **M's judge cells.** They are missing for every arm, A included, because M's base fails a test of its own before any arm's change. A cell missing for all arms, for a reason outside the arms, is read as not comparing that job. It does not fail every arm. A literal reading would fail every role and arm, the builder's B included, and leave develop's prompts unchanged.

**Applied to `agents/*.md`:**

- builder (B passes): its Reading paragraph stays, and so does the removal of "Read a file whole, once". The spec-writer failed, so there are no ranges to start from: Read first item 2 goes back to develop's "open those files first".
- spec-writer and reviewer (B fails): every Phase 1 hunk goes back to develop's text, the Reading paragraph included. The file map stays `| Path | Symbols | Change | Tests |`.
- The eight unmeasured agents (approver, assistant, designer, drafter, integrator, judge, planner, retro) lose the paragraph, because B did not pass for both the spec-writer and the builder.
- The `forge stats` peak-context figure ships regardless. It is not a prompt.

## Recommendation

**Against an exploration-subagent follow-up.** Arm C failed for both roles it was measured on:

- The spec-writer was slower and heavier, with medians of 1.375 for wall, 1.024 for peak and 1.146 for tokens.
- The builder stopped on S and was slower over the three jobs (wall median 1.250).

More to the point, no arm-C run ever called the explorer: 0 subagent transcripts in 6 runs, and an explorer share of 0 in every row. The spike says nothing for or against an explorer an agent actually uses. It only shows that offering one, unused, didn't help. A `forge explore` child and a `runtime.models.explore` key would add a launch surface and a schema bump for no measured gain. This job adds no config key and files no issue.

Three things the runs turned up that are worth their own issues, for a person to file:

- **Builders contract-stop on a small job.** Every arm-A and arm-C S builder (3 of 3 each) ended after one message, reading the brief's last line, "Reply with your one-line contract.", as the whole task. They made 0 commits, and verify passed the empty diff. Arm B did it 0 of 2 times, and M and L builders never did. It reproduced on opus and on sonnet. The production run of the same request built in one run, so the trigger is unclear.
- **Builders can't remove a file they created.** M arms A and C and L arm A each created a file, were denied `rm`/`mv`, and ended NEEDS-INPUT asking a person to delete it.
- **`forge job agent run` records no `composition`.** So `cost.byRole.<role>.peakContext` gets samples only from runs that end through `forge job agent end` (the subagent route). Role runs read n 0 until the child's transcript composition is recorded too. The after-merge 10-job check (spec › Infra & rollout) depends on this.

## Limits

- n = 3 jobs per role, and one for the reviewer. One run per cell, so run-to-run noise is unmeasured, and the builder-B pass rests mostly on M and L.
- A job's three arms ran concurrently on one machine and one login, so they shared rate limits and cache conditions. The jobs ran one after another, on opus (spec-writer, builder) and sonnet (reviewer). Sizes and cache behaviour differ by model.
- Reviews ran `--cold`. Production reviewers fork the round's context session, so a reviewer's peak there includes the context child's reads.
- Arm C measured an explorer that was never called.
- Deviations from the Appendix as first written (the Appendix below is corrected):
  1. The scratch root had to be addressed by its real path (`/private/var/…`, not `/var/…`), because the write allowlist is keyed by the real path. The first S attempt was discarded for this (about $3.50).
  2. Each clone also needed `pr.enabled: false`, because `forge pr find` fails with no remote. The issue-link gate was answered with `forge job human <job> approve --link none`.
  3. Peak context and the Read+Bash share came from transcripts through `composeContext`, because `forge job agent run` records no composition.
  4. S builder attempts 1–2 ran on sonnet at effort low (`runtime.modelByComplexity.low: sonnet`). Attempt 3 set `runtime.modelByComplexity.low: null` in the S clones so builders ran on opus, as the Method's models say. The S table is attempt 3. Attempts 1–2 are among the discarded runs.
  5. For L arm A, the person deleted the builder's stray untracked file (`lib/engine/pipeline/step/split-check.ts`), logged a note, and moved the job to verify without a second builder run. Its builder row is its one run.
  6. `test/invariants/version.test.ts` › "version bumps are documented" fails on M's base `374dad39` itself (API version 76 undocumented), so verify fails in every M arm. The person ran `forge verify` on M arms A and C after their NEEDS-INPUT, to fill the verify cell.
  7. Step 5's restore must also copy `.forge/runtime/job-records/<job>/`, the job record that the job folder only mirrors. Restoring only the job folder left `forge job step` at X1 ("no rule for stage review"). With the record restored, the two briefs were byte-identical.

## Appendix: rerunning

Run all of this from a person's own terminal, not from a Forge daemon session (`FORGE_DAEMON` unset). Never change Claude Code settings, credentials or permissions to make a run work.

**Placeholders.**

- `<main>`: the Forge main checkout.
- `<scratch>`: `realpath "$(mktemp -d "${TMPDIR:-/tmp}/forge-576.XXXXXX")"`. It must be the real path, outside both checkouts.
- `<plugin-a>`, `<plugin-b>`, `<plugin-c>`: `<scratch>/plugin-a`, `-b` and `-c`.
- `<clone>`: `<scratch>/t-<size>-<arm>`, one per job × arm (nine).
- `<base>`, `<merge>`: the Jobs table's columns.
- `<phase-1>`: this branch's Phase 1 commit, the one titled `feat(prompts,stats): …` in its log.
- `<job>`: the scratch job id that `job new` prints.

Every command runs with `FORGE_ROOT=<clone>`, `FORGE_HOME=<scratch>/home`, and Node 22.18 first on PATH.

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
- The CLI: no patch was needed. `forge job agent run` passes the agent's `tools:` as `--tools`, `Agent` matches `BUILTIN_TOOL` in `argv.ts`, and `daemon.allowedTools` allows `Agent`. Check that the first arm-C child's `system`/`init` event lists `Agent` in `tools`.

**3. Target clones**, for each size and each arm (`a`, `b`, `c`):

```
git clone -q --no-checkout <main> <clone> && git -C <clone> checkout -q -B develop <base> && git -C <clone> remote remove origin
git -C <clone> remote -v        # prints nothing; keep the output
```

Before any run, set these overrides in `<clone>/.forge/config.yml` and commit them to `develop` (`git -C <clone> commit -qam "spike: scratch overrides"`). Verify reads the base branch's config.

- `tracker.kind: local`
- `pipeline.plan: never`, `pipeline.specApproval: never`, `pipeline.maxRounds: 1`
- `pr.enabled: false`
- `review.panel`: only the `code` entry
- `runtime.modelByComplexity.low: null`, so a low-complexity job's builder runs on the role's own model (opus)

Run `npm ci` once per base in its arm-a clone, then copy that `node_modules` to the base's other two clones. Copy each job's `request.md` from `<main>/.forge/jobs/<job id>/` to `<scratch>/requests/<size>.md`, then `chmod a-w` it.

**4. Drive one job × arm** with the arm's own CLI, `F=<plugin-x>/bin/forge`:

```
export FORGE_ROOT=<clone> FORGE_HOME=<scratch>/home
$F job new --title "<title>" --body-file <scratch>/requests/<size>.md --session spike
$F job advance <job> --session spike               # repeat: runs the run actions (worktree, verify, ...) up to the next spawn
$F job agent run <job> --session spike --cold      # for each spawn that is not a reviewer: spec-writer, builder, verifiers
$F job human <job> approve --link none             # when the job parks on the issue-link gate
```

Stop at the first reviewer spawn. Keep every `agent run` result line (`wallMs`, `usage`, `agentId`, `jobCostUsd`). For the first spec-writer, check that its `forge` calls resolved under `<scratch>`. If verify fails, no review is spawned, and that run's judge cell is `not run`.

**5. Reviews.** For arm A's job, at its reviewer spawn, take step 5's measurement first:

```
cp -Rp <clone>/.forge/jobs/<job> <scratch>/snap-<size>
cp -Rp <clone>/.forge/runtime/job-records/<job> <scratch>/snap-<size>-record
$F job step <job> --json > <scratch>/brief-<size>-1.json
<plugin-b>/bin/forge job agent run <job> --session spike --cold     # arm B's reviewer on arm A's diff
# keep review/round-1/code.md and the run's result line, then restore both copies:
rm -rf <clone>/.forge/jobs/<job> && cp -Rp <scratch>/snap-<size> <clone>/.forge/jobs/<job>
rm -rf <clone>/.forge/runtime/job-records/<job> && cp -Rp <scratch>/snap-<size>-record <clone>/.forge/runtime/job-records/<job>
$F job step <job> --json > <scratch>/brief-<size>-2.json              # must equal brief-<size>-1.json
```

Then, for each arm's job, run the fixed judge: `<plugin-a>/bin/forge job agent run <job> --session spike --cold`.

**6. Read the measures.**

- The `agent run` result line gives `wallMs` and `usage.totalTokens`.
- The transcript is `~/.claude/projects/<slug of the worktree>/<agentId>.jsonl`. From it take turns and time to first edit, plus peak context and the Read+Bash share through `composeContext` in `lib/engine/metrics/composition.ts`. Arm C's explorer transcripts sit under `<agentId>/subagents/`.
- `review/round-1/code.md` gives the `VERDICT:` line and the count of `[blocker]` and `[major]` findings.
- File-map recall: `git -C <main> diff --name-only <base> <merge>` against `specFileMapPaths` of the arm's `spec.md`.
- Spend: the sum of each job's last `jobCostUsd`, plus step 5's extra review and any discarded runs. Stop at $150.

**7. Clean up.**

```
rm -rf <scratch>
test ! -e <scratch>
ls ~/.claude/projects | grep forge-576          # check the list, remove each folder, then:
ls ~/.claude/projects | grep -c forge-576       # 0
git -C <main> worktree list                     # no scratch path
```
