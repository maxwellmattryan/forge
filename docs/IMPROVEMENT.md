# Measuring and improving Forge

"Better" means different things for a firmware repo and a web app. What every repo shares is **Forge's own behaviour**: how often work passes review first time, how often a human has to step in, how much humans still catch on PRs, and what it all costs. Forge measures those, tests changes against eval suites, and improves its repo-local layer through reviewed experiments.

## 1. Live metrics (`forge stats`, Analytics view)

| Metric | Reading |
|---|---|
| first-pass review rate | share of jobs whose first review round passed |
| avg rounds | build→review rounds per job |
| verify first-pass rate | build/lint/test green before any review |
| first-round verifier block rate | `quality.verifierFirstRoundBlockRate`: of the jobs whose first round-1 verifiers record has results, the share that blocked (CHANGES). Re-runs and later rounds don't count; null without verifiers. JSON and `/api/stats` only |
| escalation rate | approver escalations / decisions |
| human feedback on PRs | PRs where humans still left unresolved threads or requested changes: what the panel was asked about, not what humans actually changed |
| **human delta after push** | the escape rate: merged PRs where humans committed file changes after Forge's last push, out of the merged PRs that could be measured. The median lines changed shows how big the escapes are, and coverage (`measured/merged`) shows how many merges were measured: PRs opened before this metric existed, adopted PRs and rewritten branches are not. Measured once, on the first `forge pr sync` that sees the merge; merges of the base branch into the PR are not counted |
| **autonomy rate** | merged jobs with a final outcome that shipped with no person's rework, revision, decision outside a required gate, escalation approval, PR feedback or edit, and were neither reverted nor followed by a bug, out of every final outcome: Forge 1.0's test, a weekend unattended run with no human fixes. One definition, `judgeAutonomy` in `lib/engine/evals/autonomy.ts`. An escalation forced by `approver.alwaysEscalate` counts against it too, since the park doesn't say why the approver escalated |
| **autonomy rate (strict)** | the same, and no person approved a gate config or policy requires (spec, split, repos, release, issue link, infra, protected paths). The foreman's decisions count against neither |
| revert rate | final outcomes whose merge was reverted inside `outcomes.windowDays`, by a `This reverts commit <sha>` commit on the base branch or a merged `Revert "<title>"` / `Reverts o/r#N` PR, out of those whose revert check completed |
| follow-up rate | final outcomes with at least one `bug` issue created in the window that cites the job's PR or issues, out of those with a count (GitHub tracker only: other trackers record `unsupported`) |
| churn rate | final outcomes with later non-Forge base-branch commits on the files the merge changed, inside the window: a soft signal, never counted against autonomy |
| outcome coverage | `merged`, `final` and `open`: how many merged jobs have a settled outcome. Open outcomes and merged jobs not measured yet are in no denominator; `forge sync` measures up to 10 per run, so the first syncs after an upgrade backfill older merges |
| `medianScore` | the median post-merge judge score (0-5) over scored jobs: the judge rates a sampled merged job's diff against its spec's acceptance criteria, without the build log or reviews. Off until `scoring.sample` is set or a mandate scores its jobs; `scoreByBuilderModel` splits it by builder model, and `forge eval compare` sets real-job scores (`realJobs`) beside the eval judge's |
| `scoreCoverage` | `merged`, `sampled` (any score), `scored`, `held` (over a budget, never run), `failed` (no valid `score.md`) and `queued`: how much of the merged work the median stands for |
| human reworks, spec first-try approval | how often humans had to redirect |
| median minutes to PR / to done | throughput |
| tokens, API-equivalent cost (by role, by model), usage coverage | spend, and how trustworthy the spend numbers are |
| per-lens change rate | lenses that never find anything are candidates to narrow or drop |
| **per-lens dispute rate** | share of the lens's answered findings the builder disputed (`→ disagree:` in build.md's `Findings addressed`, over fixed plus disputed): a reviewer-precision signal. A lens builders often dispute may need a sharper checklist |
| **recurring findings** | (lens, path) pairs the same lens raised in two consecutive review rounds of one job, ignoring line numbers and severity: oscillation, where a fix didn't hold or the reviewer keeps moving the goalposts. Across jobs, `forge retro prepare` groups findings by finding key (§3) |
| **per-lens miss rate** | `reviewers.<lens>.missRate`: of the merged jobs a lens reviewed whose escape status is known (a measured human delta or a final outcome), the share with an escape it covered. A revert or a follow-up bug counts against every lens that reviewed the job; a human-delta file counts against a lens only when today's panel entry covers it (`always`, its `paths`, or unless `pathsOnly` the path tokens of its `when`). A lens no longer on the panel, or a member repo's lens, covers nothing |
| **per-lens blocker/major share** | `reviewers.<lens>.blockerMajorShare`: blocker and major findings over all of the lens's findings, with `blockers` and a weekly `severityTrend` (UTC Monday of each job's creation, the last 12 weeks with findings). Archive records written before severities were counted are left out of it |

`forge job findings <id>` shows one job's counts: findings raised, fixed and disputed per round and per lens (with each lens's findings by severity), and its recurring findings. It reads the review files and the builder's answer lines (`- <lens> <severity> <path:line> → fixed | disagree: <reason>`, defined in `agents/builder.md`). Integration reviews, verify, PR feedback and `feedback.md` are not counted.

### Prompt cohorts (`forge stats --by prompt`)

Every `agent-start` event records what the agent ran on: `pluginHash` (the running plugin's prompts, checklists, skill, step and brief), `promptHash` (the role's hash as `forge roster` reports it; for `reviewer:<lens>`, the reviewer prompt and the lens's checklist together) and `configHash` (the repo layer and the job's effective config). Events from before this have none of them.

`forge stats --by prompt [--role R] [--since DATE] [--include-evals]` groups jobs into **prompt cohorts**: each job is keyed by the `promptHash` on its last start for the role (`builder` by default; any `agents/*.md` role or `reviewer:<lens>`), because a job is judged on the prompts it finished with. Each cohort has its jobs (the first 20 ids), the first and last of those starts, up to 5 plugin and config hashes, and a full `stats` object over its jobs only, oldest cohort first. `mixed` counts jobs whose starts carried more than one hash (they straddled a change) and `unrecorded` the jobs with no hashed start. Archived jobs count. It prints JSON only: `--csv` is a usage error, as is an unknown role.

### Mandate report card (`forge stats --mandate`)

A mandate's **report card** says how good its work was, in one fixed shape: `{ mandate, at, jobs, scores, review, interventions, spend, outcomes }`. `forge stats --mandate <id>` prints it live, for a mandate of any status, and `GET /api/mandates` carries it on every readable row. When the Office pass closes a mandate, its closing summary (`summary.json`, which `forge mandate show` returns as `summary`) records the card at the close; a summary written before the card reads `card: null`. The card is built from the mandate's jobs as the CLI records them (the live records, the archive, the CLI copy of their events and the spend ledger), with no tracker call. One builder, `buildReportCard` in `lib/engine/metrics/report-card.ts`, makes all three, and it uses the same per-job rules as `forge stats` and `forge sync`. "Merged" means the job's PR is `MERGED`.

| Section | Fields |
|---|---|
| `jobs` | `total` (live and archived, split children included), `reached` (at the mandate's `until`), `merged`, `inFlight` |
| `scores` | over the merged jobs, each in exactly one bucket: `scored` (a value from 0 to 5), `held`, `failed`, `pending` (a live job whose score run is queued, or that `forge sync` would still queue under the mandate's `scoring`: inside the 7-day lookback, sampled under `sample`, never under `off`, never with `pr.enabled` false) and `unscored` (everything else: not sampled, scoring off, past the lookback, archived, PRs disabled, a malformed value). `median` (2 decimals) and `below3` (scored values under 3) |
| `review` | over the settled jobs (not in flight) with verdicts: `reviewed`, `avgRounds` (the mean last round, 2 decimals) and `firstPassRate` (the share whose first round's verdicts were all `PASS`, 3 decimals), the per-job rules of `quality.avgRounds` and `firstPassReviewRate`; null when none is reviewed |
| `interventions` | every person's `human` event on the mandate's jobs (never the foreman's): `total`, the closing summary's `humanInterventions`, and `byGate`, keyed by the `waitingOn` of the job's latest transition before the decision when it went to `waiting`, else `none`. Only keys above 0 appear |
| `spend` | `usd` (every ledger bucket of its jobs) against `budgetUsd`, and `started` (split children don't count) against `budgetJobs` |
| `outcomes` | over the merged jobs, each in exactly one bucket: `final`, `open` (live with `pr.enabled`, not measured yet or still open: `forge sync` will measure it) and `unmeasured` (it will never be final: archived, or PRs disabled). `reverted` and `followedUp` count final outcomes that were reverted or drew a follow-up bug. `finalAt` is when the last window closes: the latest `closesAt` over final and open outcomes, or for an open job not yet measured its merge plus `outcomes.windowDays` |

**The pending rule.** A count of what has happened (jobs, interventions, spend, the rounds of settled jobs) is a running total and is never `pending`. A figure over a post-merge measurement (`scores.median`, `scores.below3`, `outcomes.reverted`, `outcomes.followedUp`) reads `pending` while its section's `pending` (scores) or `open` (outcomes) count is above 0, `null` when it counts nothing and awaits nothing, and otherwise its value. So an empty or new mandate reads `median: null`, never 0, and one whose only merged job waits on its judge reads `median: pending`. Held and failed scores are final and never make a figure pending; in-flight jobs are in neither section. A mandate's quality floor (docs/CONFIG.md "Mandates") reads the running median instead (`runningScore`): the same scored values, with no pending rule, since under continuous work some score is nearly always queued and a floor on `scores.median` would never fire.

The card carries no free text (no titles, ids, reasons, issue refs or logins): only counts, finite numbers, `pending`, `null`, `byGate` keys from the `waitingOn` values, and the `at` and `finalAt` times it builds itself. A malformed stored value counts as unscored, keys as `none` or is skipped.

### Measuring a spend change

A change meant to cut spend (a prompt rule, `runtime.modelByComplexity`, `runtime.reworkModel`, `review.onRework`, effort defaults) must not cost quality. Measure it before and after:

1. Before merge, take the baseline over the last N done jobs: `forge stats --csv --by role --since <date>`, and note `forge stats`' first-pass review rate and avg rounds.
2. After N jobs have run on the new config and prompts, run the same with `--since <merge date>`. For a prompt change, `forge stats --by prompt --role <role>` puts the old and new prompts' jobs side by side, each cohort with its own first-pass review rate and avg rounds.
3. Compare usd and tokens per job by role.
4. Keep the change only if first-pass review rate and avg rounds did not get worse; otherwise revert it.
5. For a controlled comparison, run `forge eval` twice on one suite, the second with an overlay such as `--set runtime.reworkModel=sonnet` or `--set review.onRework=full`, and `forge eval compare` the runs.

Forge's own repo pins the gatekeepers and lowers effort for low-complexity jobs with this block under `runtime:` in `.forge/config.yml` (a human applies it on the base branch: `policy.protectedPaths` refuses the file to jobs):

```yaml
efforts:
  planner: medium
  approver: medium
  integrator: low
effortByComplexity:
  low: low
```

## 2. Evals (`forge eval …`, Evals view)

An eval task is a request, a base commit, and a hidden acceptance check:

- **Replays** (`forge eval mine --pr <n>`): a merged PR becomes a task. It starts from the PR's base, the request is the PR description plus its linked issues, and the hidden check is the PR's own test changes. Your repo's history becomes a benchmark.
- **Hand-written** tasks with hidden test files or a patch.
- **Rubric** tasks scored 0-5 by the judge agent, for repos without tests or for qualities tests miss.

Before a hidden patch is applied, the candidate's versions of the files it touches are replaced by the base versions (or deleted when the base has none), so the grade measures the code rather than a merge conflict with the builder's own copy of a test. The candidate's other tests stay and still run, and `check.replaced` in `forge eval report <run>` lists what was replaced.

Eval jobs get a standalone shallow clone that holds only the task's base commit, with no remotes and no objects shared with the main checkout, and `.forge/evals/` sparse-excluded, so neither the files nor git history reveal the check or the real fix. Limits: the builder's model may remember a public PR, and this is not a filesystem sandbox, so an agent that deliberately reads the main checkout can still find both. Briefs point every agent at the main checkout's instruction files (docs/CONFIG.md "Instruction files"), so an eval job follows today's conventions, which may postdate the task's base. Each run records the Forge version, a `pluginHash` of the plugin's prompts, checklists, skill, step and brief (so two dev builds with one version string tell apart), and a hash of the repo layer (config, checklists, notes). A run can repeat each task (`--repeat N`) and run under a config overlay (`--set key=value`) without editing `.forge/config.yml`. Graded results carry minutes per stage, agent and orchestrator time, and reviewer runs. An eval job that runs out of `pipeline.maxRounds` is graded rather than parked, with no approver, and the run summary's `roundsExhaustedRate` shows how often that happened, so a tighter `--set pipeline.maxRounds=…` variant finishes and its cost shows up in the comparison. `forge eval compare A B` shows what moved, with the sample count behind every mean, per task as well, and whether the plugin or configuration changed between runs.

### Reviewer recall evals

The cheap tier, for changes to reviewer prompts: no build, just reviews of frozen diffs. **Recall fixtures** live in the main checkout's `.forge/evals/recall/<name>/` (at most 50; `runs/` is reserved). Each has a `diff.patch` and a `fixture.yml`:
```yaml
title: an unquoted git revision reaches argv
lenses: [security, code]      # required; each lens reviews this fixture
diff: diff.patch              # optional, the default
defects:                      # optional; none makes a clean fixture
  - id: git-option-injection  # slug, unique in the fixture
    lens: security            # one of lenses
    path: lib/engine/pr/open.ts                # a file the diff's +++ b/ headers name
    line: 42                  # optional new-file line
```
Both files must be regular files of at most 256 KiB. An unknown key, a bad slug or lens, a defect lens outside `lenses`, a path no header names, a line that isn't a positive integer, or a linked, missing or oversized file makes `list` and `start` exit 1, naming the fixture and the problem. Fixtures are read from the main checkout only: a branch that edits or deletes its own copy changes nothing.

`forge eval recall start [--job <id>]` copies each fixture's diff into a run directory (`<job dir>/recall/<run>/`, or `.forge/runtime/recall/<run>/` without a job) and returns one `forge:reviewer` brief per fixture and lens, pointing at the prompt root's `agents/reviewer.md`: the job worktree's (or the repo's) when it has one, else the installed plugin's. The brief asks the reviewer to cite new-file line numbers, counted from the hunk headers. `skills/forge/reference/recall.md` spawns the reviews, then `forge eval recall record <run> [--tokens N]` grades them. A planted defect is caught when that lens's review has a blocker, major or minor finding on its path and, when `line` is set, within 5 lines of `line` (the new-file line) or of the line in the run's `diff.patch` that shows it, which `start` works out from the hunk headers; nits never count, and a missing or malformed review catches nothing. Every finding at a `review.blockOn` severity on a clean fixture is a false positive. Per lens and in total: `recall` (caught over planted) and `precision` (caught over caught plus false positives). A run without a job is copied to `.forge/evals/recall/runs/<run>.json`, tracked like eval runs; a job's run is compared with the newest such run on the job's base branch.

**The gate.** At decide, when the main checkout has a fixture and the job's committed diff touches `evals.recall.paths` (`agents/`, `reviewers/`, `lib/engine/pipeline/brief.ts` by default), step runs the recall procedure before the approver (RC1) until a `recall` record exists for the worktree's current `pluginHash`. After two starts with no record it parks on a human (RC2, reason `recall eval: no recorded run for prompts <hash>`): they run it again or approve to waive it. A main-checkout fixture that does not load parks it there at once, since `start` could never log a run: the human fixes the fixture on the base branch or waives the check. Only a person's approve at that park, for those prompts, waives it; a later prompt edit needs a new run. If git fails reading the diff, the gate counts as required. The approver's brief gets a `Reviewer recall:` line with each lens's recall and precision beside the base run's, and a lens whose recall dropped is a reason to escalate. Recall is a regression signal for the approver and a human, not a security boundary: a builder can read the fixtures.

## 3. Retros (`/forge retro`)

With `foreman.enabled`, `forge sync` (which `forge dash` runs every two minutes) queues one `retro` request for the inbox once `forge retro due` says a retro is due, unless a retro request is pending or in progress or a retro job is still open. With the foreman off, the orchestrator tells the human once. Either way a retro job's spec gate stays with a human: no gate request reaches the gate runner, and `--actor foreman` is refused there.

The retro agent reads the metrics (per-lens dispute, miss and blocker/major rates and recurring findings among them), a digest of human interventions, the human delta after Forge's last push and each job's recurring findings as oscillation signals, and from `forge retro prepare`'s `signals.md`: `## Experiment verdicts` (a dry run of `forge experiment evaluate`), `## Per-lens recall`, `## Recurring findings across jobs` (findings that share a **finding key**, the lens and the first four words of the title, in 2 or more jobs, with counts, job ids and one example) and `## Learnings past review-by`. It then:
1. proposes reverting changes whose experiment was `reverted`
2. retires expired learnings and addenda whose experiment did not keep
3. finds patterns (not anecdotes) across jobs
4. turns each mechanical recurring finding into a check (an invariant test, lint rule or `mode: warn` verifier) instead of a learning, and deletes the learnings it enforces
5. proposes at most five small edits to `.forge/notes/learnings.md`, role addenda, reviewer checklists, verifiers, config or the checks of step 4, each with evidence, a target metric and a baseline

Its proposals become a normal Forge job that always waits for spec approval and ships as a PR. The job's first task is `forge experiment evaluate <job>`, committed, and new changes are logged in `.forge/notes/experiments.md` as open entries. Generic lessons are flagged as candidates for upstreaming into the plugin.

**Learnings expire.** `learnings.md` and every role addendum (`.forge/notes/<role>.md`) are read on agent runs, so each entry names the experiment that justifies it and a date to check it by:
```
- **<rule>** — why, evidence: <job ids>. (added YYYY-MM-DD · experiment: <id> · review-by: YYYY-MM-DD)
```
The id points at a ledger line in `experiments.md`, whose metric is a stats path:
```
- <date> · id <slug> · <change> · metric <stats path> (<up|down>) · baseline <value> · evidence <job ids> · status open
```
Once an entry's review-by is today or earlier, `forge retro prepare` lists it in `signals.md` under `## Learnings past review-by`, prefixed with its file (`(notes/builder.md)`), with the baseline, the metric's current value and its experiment's verdict: `kept`, `reverted`, `inconclusive` or `pending` for an open entry, the written status for a closed one. Entries without the fields never expire. `forge roster` reports `learningCount` and `oldestReviewBy`.

### Settling experiments

A **settled experiment** is a ledger entry whose status `forge experiment evaluate [<job>] [--dry-run]` wrote; nothing else writes one. For each `status open` entry it takes the done or cancelled jobs, neither eval nor retro, created after the entry's date (`jobsAfter`), computes the metric over each job alone, and drops jobs with no value (`n` is what is left):
- An entry whose metric is no stats path, or with no direction or no numeric baseline, is closed at once: `status inconclusive (<date>, metric is not a stats path | no direction | no baseline)`.
- With fewer than `improve.experiments.minJobs` values it is `pending`.
- Otherwise a metric whose last segment ends in `Rate` or `Share` is a rate: `two-proportion` (Newcombe's interval for the difference, when the baseline carries its sample, `0.344 (11/32)`) or `wilson` (the Wilson interval of the mean, minus the baseline). Any other metric is a mean: `bootstrap` (2000 resamples seeded from the entry id, so the same inputs always give the same interval). All at 95%, as the difference from the baseline, to 3 decimals.
- `kept` when the whole interval is on the improving side, `reverted` when it is on the worsening side, else `inconclusive`. Kept and reverted are written at once; inconclusive and pending only once `jobsAfter` reaches `improve.experiments.maxJobs`: `status <verdict> (<date>, n <n>, <method>, diff <lo>..<hi>)`, or `status inconclusive (<date>, n <n> below minJobs <m> after <jobsAfter> jobs)`.

It replaces only the entry's `status open` text and writes the one ledger file atomically: the job worktree's with `<job>`, else the repo's. It reads jobs from the repo and writes no event, lease, lock or request, so it needs no job lease. `--dry-run` writes nothing and shows the status a real run would write. Kept and reverted record a verdict only: the next retro proposes the revert.

**The notes check.** `forge experiment check [<job>]` validates the layer, and verify runs it (a `notes` step, which fails the round but is no gate) whenever the committed diff touches `learnings.md`, `experiments.md` or a role addendum. With a job it compares each file at the verified commit with the merge base; without one it audits every entry on disk. A file over 1 MiB fails the check unparsed, and with no merge base to compare against, verify fails the step when a notes file differs from the main checkout's HEAD. An added or edited learning or addendum entry needs `experiment:` naming a ledger id and a valid `review-by:`. Ledger entries are matched by id: a new entry needs an id, `status open`, a stats-path metric, a direction and a baseline; an existing open entry may change only its status, and only to one of evaluate's written forms that agrees with the entry's method, direction and the configured `minJobs` and `maxJobs`; a settled entry never changes, and no entry is removed or shares an id with another. An agent can still forge a well-formed, consistent status by hand; the ledger diff is in the PR, and a retro's spec gate is a human's.

The loop: **metrics and prompt cohorts → scheduled retro → PR (settled ledger, new open experiments, recall-checked prompts) → live metrics → the next retro's evaluate keeps or reverts.**
