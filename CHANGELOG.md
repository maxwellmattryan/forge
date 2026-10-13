# Changelog

## 0.8.1

- One PR per issue: the planner shapes a single job into ordered phases that each leave the branch green, and a split proposal is a human gate. New `pipeline.split` (`ask` by default, or `auto` | `never`) parks a `PLAN: SPLIT` on `split-approval` until `/forge approve` creates the child jobs or `/forge revise` keeps it as one; `/forge issue <ref>` and dashboard starts always plan as `never`. `API_VERSION` 5.
- Forge's own config: scoped ui, accessibility and ux lenses in the review panel.

## 0.8.0

- Daemon: `forge dash` can supervise one headless `claude -p` session that handles dashboard requests without a human session open (`daemon.enabled`, off by default). Config schema 2 replaces `dashboard.launcher` with a `daemon:` block; the dashboard gets a daemon status pill, start/stop buttons and a live log pane over SSE; `API_VERSION` 4.
- Daemon security: the default allowlist is scoped to the git and gh forms Forge uses, git hooks are off inside the session, and validation refuses permission-widening flags and entries. New `forge git diff|log|show|range-diff` wraps reads so `--output` and driver options cannot write into `.git/`; `forge integrate --keep-conflicts` and `--continue` replace `git merge|rebase --continue` on the allowlist. Every `forge` command in a daemon session checks a trust digest of `.forge/config.yml` and `.forge/trackers/`, and the supervisor stops the session when they change.
- Dashboard: ported to Svelte 5 in strict TypeScript, built with Vite into the committed `dashboard/dist/` (Tailwind compiled in, no CDN). The server serves only files the build manifest lists. Same UI and escaping guarantees.
- Engine: `lib/`, `hooks/` and the tests are strict TypeScript that Node runs by type stripping, with no build step and still no runtime dependencies. Node ≥ 22.18 is required; standalone install is `git clone` + `npm link`.

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
