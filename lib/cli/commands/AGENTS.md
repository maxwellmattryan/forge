# lib/cli/commands/

One module per command group, each with its `HELP` table, and the human-mode renderers.

- A command or JSON output change edits its group's module and `HELP` table (`CORE` in `help.ts` for what `main.ts` routes), then `npm run docs` regenerates README's CLI table and docs/CLI.md's command reference. New commands return compact JSON; large outputs go to files in the job dir, and the CLI returns their paths.
- Only this folder and `lib/cli/main.ts` import it (`test/invariants/layers.test.ts`). It is a registry, so it may hold more than 12 entries; so is `render/`.
- **`job/`** holds `forge job`'s help table (`help.ts`) and one handler function per subcommand, grouped by concern; `job.ts` only routes, through `JOB_HANDLERS`.
- **CLI output**: string results print raw (e.g. `forge worktree path`), everything else prints compact JSON.
- **`--field` values** are not comma-split, because JSON arrays contain commas. Other list flags are.
- Design: [Why a CLI does the bookkeeping](../../../docs/architecture/cli-bookkeeping.md), [Audit trail](../../../docs/architecture/audit-trail.md), [Untrusted input](../../../docs/architecture/untrusted-input.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `advance.ts` | `forge job advance`: step's executor. |
| `args.ts` | Argument parsing and output helpers shared by every command module. |
| `audit.ts` | `forge audit`: the audit trail across every job and the repo-level log, for a period. |
| `backing.ts` | `forge backing up\|down\|stop\|status`: a job's backing services on demand (lib/engine/environment/backing.ts, docs/CONFIG.md "Backing services"). |
| `budget.ts` | `forge budget`: repo spend against the day and month caps (config `budget:`), and a human's acknowledgement that grants one more period. |
| `config.ts` | `forge config show\|get\|set\|validate`: read the effective config, and write one editable key. |
| `daemon.ts` | `forge daemon status\|log`: the terminal's view of the session pool. |
| `dash.ts` | `forge dash`: the machine's one dashboard for every registered project, started in the foreground or as a detached, pid-tracked process, registering the repo it runs in. |
| `doctor.ts` | `forge doctor`: is this machine and repo ready for Forge, and with --bundle, a redacted support bundle (lib/engine/ops/bundle.ts) a user can attach to a bug report. |
| `environment.ts` | `forge environment up\|stop\|down\|list`: a job's environment on demand (lib/engine/environment/lifecycle.ts, docs/CONFIG.md "Backing services" › Lifecycle). |
| `eval.ts` | `forge eval …`: lists, mines, starts, grades and reports eval tasks, and the reviewer recall evals. |
| `experiment.ts` | `forge experiment evaluate\|check`: settling the experiment ledger and validating the notes layer (lib/engine/evals/experiments.ts, docs/IMPROVEMENT.md). |
| `focus.ts` | `forge focus`: which job the human is QA-ing in its worktree. |
| `git.ts` | `forge git diff\|log\|show\|range-diff …`: read-only history for agents (`add`/`commit`, which write, are further down). |
| `help.ts` | `forge help`, `--help` and the CLI's error contract (docs/CLI.md). |
| `human.ts` | A person at this terminal confirming a human-only operation: the CLI's half of the human channel; the dashboard's routes are the other (docs/architecture/daemon-security.md). |
| `init.ts` | `forge init write` and `forge migrate`: setting a repo up and keeping its files current. |
| `job.ts` | `forge job …`: every write to a job's state goes through here. |
| `job/agent.ts` | `forge job agent start\|end\|attach`: recording an agent's run, its usage and the secret scan of what it wrote. |
| `job/create.ts` | `forge job new\|from-ref\|link`: creating a job, starting one from a tracker item, and the issues it carries. |
| `job/decide.ts` | `forge job human\|handoff\|assist`: recording a human's or the foreman's decision at a gate, a Foreman hand-off, and the office's assistant spawn. |
| `job/help.ts` | `forge job`'s help table: every subcommand's usage, flags and exits, which `forge help job` prints and `npm run docs` reads. |
| `job/lease.ts` | `forge job claim\|release\|step`: a job's lease and its driver's epoch, and the `--epoch` fence other handlers share. |
| `job/read.ts` | `forge job list\|show\|get\|progress\|paths\|links\|scope\|panel\|acs\|findings\|audit`: the read-only views of one job, or of every job. |
| `job/repos.ts` | `forge job repo\|interim`: a job's member repos, their interim strategies, canary publishes and recorded releases. |
| `job/retention.ts` | `forge job archive\|delete\|prune`: archiving finished jobs, deleting a mistaken one, and pruning old jobs and session logs; never from a daemon session. |
| `job/review.ts` | `forge job round\|verdicts\|decision\|score`: review rounds, the reviewers' and approver's verdicts, and the post-merge score. |
| `job/state.ts` | `forge job set\|effort\|note\|refresh-request\|budget`: a job's stage, state, fields, effort, notes, request and budget limits. |
| `notify.ts` | `forge notify test\|send`: a sample notification to every configured target, and the detached sender lib/office/notify.ts queueNotify spawns. |
| `project.ts` | `forge project add\|remove\|list\|settings`: the machine index of registered projects and the machine settings (lib/engine/project/machine-index.ts). |
| `release.ts` | `forge release plan\|run\|status`: a release a human runs from the CLI, single- or multi-repo (lib/engine/release/plan.ts plans it, lib/engine/release/run.ts runs it; docs/RELEASES.md "Releasing a project"). |
| `render.ts` | Human output mode (docs/CLI.md "Output mode"): the generic renderer for results and errors. |
| `render/backing.ts` | `forge backing status` in human mode. |
| `render/config.ts` | `forge config show\|get\|validate` in human mode. |
| `render/doctor.ts` | `forge doctor` in human mode: what is broken first, each with its fix under it. |
| `render/job.ts` | `forge job list\|show\|step\|claim\|note` in human mode. |
| `render/kit.ts` | Shared pieces of the hand-written human-mode renderers (docs/CLI.md "Output mode"). |
| `render/pr.ts` | `forge pr open\|sync\|merge` in human mode. |
| `render/registry.ts` | The hand-written human-mode renderers, keyed by command path (docs/CLI.md "Output mode"). |
| `render/status.ts` | `forge status`, `forge stats` and `forge requests list` in human mode. |
| `render/sync.ts` | `forge sync` in human mode. |
| `render/update.ts` | `forge update` and `forge update --check` in human mode. |
| `render/verify.ts` | `forge verify` in human mode. |
| `render/version.ts` | `forge version` in human mode. |
| `render/worktree.ts` | `forge worktree create\|remove` in human mode. |
| `requests.ts` | `forge requests`: the dashboard inbox. |
| `run.ts` | `forge run <job> <command> [--repo R] [--tail N] [-- <args…>]` and `forge run <job> <command> --background`. |
| `secrets.ts` | `forge secrets scan`: what the secret scanner (lib/engine/guard/secrets.ts) finds in a job's branch and PR text, or in the main checkout's tracked files. |
| `status.ts` | Human-readable summaries: `forge status` and the text form of `forge stats`. |
| `tracker.ts` | Tracker commands, starting jobs from tracker refs, and `forge sync` (PRs + trackers for every job). |
| `update.ts` | `forge update [--check] [--keep-dash]`: routed before mainRoot(), so it needs no repo or .forge/. |
| `verifiers.ts` | `forge verifiers list\|run\|record`: the repo's yes/no checks between verify and the review panel (lib/engine/pipeline/verifiers.ts, docs/VERIFIERS.md). |
| `version.ts` | `forge version [--json]`: routed before mainRoot(), so it needs no repo or .forge/. |
<!-- forge:map:end -->
