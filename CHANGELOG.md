# Changelog

## 0.4.0

- Steel and ember branding: the dashboard uses the Forge anvil icon (tab icon, sidebar, empty states), a steel and ember palette in light and dark (contrast-checked accents, ember progress bars and primary buttons), and a "Forge · <repo>" tab title. The CLI help and `forge dash` lead with the Forge mark. README now has the logo, an epigraph and badges.

## 0.3.0

- AI-attribution policy, on by default (`aiAttribution: forbid`). A Bash `PreToolUse` hook blocks commits, tags, PRs, issues, comments and releases that credit an AI. `forge pr open` scrubs attribution from branch commit messages and PR bodies before pushing, and the GitHub tracker strips it from issues and comments. Agent prompts forbid it. PR bodies no longer carry a visible Forge footer, only a hidden marker.

## 0.2.0

- Renamed the project from Factory to **Forge**. Every identifier changed with no compatibility aliases: plugin and marketplace `forge` (`forge@forge`), skill `/forge`, CLI `forge`, agents `forge:<role>`, per-repo folder `.forge/`, branch prefix `forge/`, `FORGE_*` env vars, `forge:` labels. "Software factory" remains the name of the concept.

## 0.1.0

- Initial release: orchestrator skill, nine agents (planner, spec-writer, designer, builder, reviewer, approver, integrator, retro, judge), eleven review lenses, zero-dependency `forge` CLI, worktree-per-job with shared Cargo target and port allocation, PR lifecycle sync, local/GitHub (labels + Projects) trackers with a custom adapter contract, usage and cost accounting, Forge metrics, eval suites with PR replays and hidden checks, retros with an experiment ledger, and the dashboard.
