# Measuring and improving Forge

"Better" means different things for a firmware repo and a web app. What every repo shares is **Forge's own behaviour**: how often work passes review first time, how often a human has to step in, how much humans still catch on PRs, and what it all costs. Forge measures those, tests changes against eval suites, and improves its repo-local layer through reviewed experiments.

## 1. Live metrics (`forge stats`, Analytics view)

| Metric | Reading |
|---|---|
| first-pass review rate | share of jobs whose first review round passed |
| avg rounds | build→review rounds per job |
| verify first-pass rate | build/lint/test green before any review |
| escalation rate | approver escalations / decisions |
| human feedback on PRs | PRs where humans still left unresolved threads or requested changes: what the panel was asked about, not what humans actually changed |
| **human delta after push** | the escape rate: merged PRs where humans committed file changes after Forge's last push, out of the merged PRs that could be measured. The median lines changed shows how big the escapes are, and coverage (`measured/merged`) shows how many merges were measured: PRs opened before this metric existed, adopted PRs and rewritten branches are not. Measured once, on the first `forge pr sync` that sees the merge; merges of the base branch into the PR are not counted |
| human reworks, spec first-try approval | how often humans had to redirect |
| median minutes to PR / to done | throughput |
| tokens, API-equivalent cost (by role, by model), usage coverage | spend, and how trustworthy the spend numbers are |
| per-lens change rate | lenses that never find anything are candidates to narrow or drop |

## 2. Evals (`forge eval …`, Evals view)

An eval task is a request, a base commit, and a hidden acceptance check:

- **Replays** (`forge eval mine --pr <n>`): a merged PR becomes a task. It starts from the PR's base, the request is the PR description plus its linked issues, and the hidden check is the PR's own test changes. Your repo's history becomes a benchmark.
- **Hand-written** tasks with hidden test files or a patch.
- **Rubric** tasks scored 0-5 by the judge agent, for repos without tests or for qualities tests miss.

Eval worktrees are sparse checkouts without `.forge/evals/`, so builders can't see the checks. Each run records the Forge version and a hash of the repo layer (config, checklists, notes). `forge eval compare A B` shows what moved and whether the configuration changed between runs.

## 3. Retros (`/forge retro`)

The retro agent reads the metrics, a digest of human interventions and the human delta after Forge's last push (`forge retro prepare`), and the experiment ledger. It then:
1. evaluates earlier experiments against their baselines (kept, reverted, or inconclusive)
2. finds patterns (not anecdotes) across jobs
3. proposes at most five small edits to `.forge/notes/learnings.md`, role addenda, reviewer checklists or config, each with evidence, a target metric and a baseline

Its proposals become a normal Forge job that always waits for spec approval and ships as a PR. Merged changes are logged in `.forge/notes/experiments.md`. Generic lessons are flagged as candidates for upstreaming into the plugin.

The loop: **metrics → retro → PR (experiment + baseline) → evals and live metrics → next retro keeps or reverts.**
