# Changelog

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
