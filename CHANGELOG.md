# Changelog

## 0.7.0

- Job dependencies: `dependsOn` on a job, recorded from the planner's `Depends on`. `forge job claim` exits 4 while a dependency is unfinished; `--force` stacks the job on the dependency's branch and `forge sync` retargets its PR once the dependency merges. The dashboard shows `after <job>` chips and a depends-on/blocks list in the job drawer.
- `forge run <job> dev --background` is idempotent, so UI, UX and accessibility reviewers get a running dev server and its port.
- Acceptance-criteria traceability: `forge job acs` compares the spec's ACs with the builder's proof table, and the approver gets it in its brief. Verify can run `commands.e2e` for UI changes (`verifyE2e`), and the job drawer shows screenshots.
- Reviewer model diversity: `runtime.diversity` warns when the approver or a lens shares the builder's model family. `/forge init` offers Balanced, Economy and Max quality model profiles.
- Verify reports test integrity: deleted or moved test files, added skip/focus markers, the test-count delta, and edits to test, build or CI config. `verifyIntegrity: block` fails verify on deletions and markers the spec does not name. Verify also refuses a worktree whose files can differ from HEAD through index flags or filters.

## 0.6.0

- README badges for dependencies, Node and license use the ember palette instead of grey.

## 0.5.0

Loop hardening before Forge drives its own development.

- `forge verify` refuses an uncommitted worktree (reviewers and the PR only see commits), records the HEAD sha it checked, and keeps every attempt in a round instead of overwriting the previous one. Job schema 2 adds `verifyRuns`; `verify first-pass` now means the first attempt. `forge pr open` refuses a HEAD the latest verify did not pass on (`--force` overrides and is logged). `forge job verdicts` records the sha reviewers saw.
- Claims survive long agent runs: `forge run` refreshes the owner heartbeat, and a job with an agent still running cannot be taken over without `--force` for up to two hours after the agent started.
- Dashboard requests are claimed before they are handled (`forge requests claim <id> --session S`, under a lock), so two orchestrator sessions cannot both act on one request. In-progress requests show in the dashboard with the session handling them.
- A review with no verdict line but a blocking finding counts as CHANGES; `forge job verdicts --malformed changes` gives a twice-malformed review an exit instead of a stall.
- `lib/cli.mjs` is split into `lib/commands/` by command group; `API_VERSION` 2.

## 0.4.0

- Steel and ember branding: the dashboard uses the Forge anvil icon (tab icon, sidebar, empty states), a steel and ember palette in light and dark (contrast-checked accents, ember progress bars and primary buttons), and a "Forge · <repo>" tab title. The CLI help and `forge dash` lead with the Forge mark. README now has the logo, an epigraph and badges.

## 0.3.0

- AI-attribution policy, on by default (`aiAttribution: forbid`). A Bash `PreToolUse` hook blocks commits, tags, PRs, issues, comments and releases that credit an AI. `forge pr open` scrubs attribution from branch commit messages and PR bodies before pushing, and the GitHub tracker strips it from issues and comments. Agent prompts forbid it. PR bodies no longer carry a visible Forge footer, only a hidden marker.

## 0.2.0

- Renamed the project from Factory to **Forge**. Every identifier changed with no compatibility aliases: plugin and marketplace `forge` (`forge@forge`), skill `/forge`, CLI `forge`, agents `forge:<role>`, per-repo folder `.forge/`, branch prefix `forge/`, `FORGE_*` env vars, `forge:` labels. "Software factory" remains the name of the concept.

## 0.1.0

- Initial release: orchestrator skill, nine agents (planner, spec-writer, designer, builder, reviewer, approver, integrator, retro, judge), eleven review lenses, zero-dependency `forge` CLI, worktree-per-job with shared Cargo target and port allocation, PR lifecycle sync, local/GitHub (labels + Projects) trackers with a custom adapter contract, usage and cost accounting, Forge metrics, eval suites with PR replays and hidden checks, retros with an experiment ledger, and the dashboard.
