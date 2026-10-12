# Working on the factory itself

This repo is a Claude Code plugin and its own marketplace. Read `README.md` and `docs/ARCHITECTURE.md` first.

## Layout
- `bin/factory`: CLI entry (also on PATH when the plugin is enabled)
- `lib/`: the engine. `cli.mjs` (commands), `jobs.mjs` (state + events), `schema.mjs` (versions, normalisers, migrations), `config.mjs`, `worktree.mjs`, `pr.mjs`, `trackers/`, `stats.mjs`, `evals.mjs`, `retro.mjs`, `usage.mjs` + `pricing.json`, `server.mjs`, `detect.mjs`, `yaml.mjs`
- `dashboard/`: `index.html` + `app.js`, served by `factory dash`; no build step
- `skills/factory/`: the orchestrator (`SKILL.md`) and on-demand procedures (`reference/`)
- `agents/`: one prompt per role · `reviewers/`: lens checklists · `templates/`: files `init` seeds into `.factory/`
- `docs/`: user docs · `test/`: `node:test` suites

## Rules
- **Zero runtime dependencies.** Node ≥ 20 built-ins only, plain ESM with JSDoc types (`// @ts-check`). The dashboard may load only pinned, SRI-protected CDN assets.
- **The CLI is the only writer of state.** New state → a CLI command, never "the agent edits job.json".
- **Version every shape change.** Bump the constant in `lib/schema.mjs`, add a migration keyed by the old version, keep normalisers tolerant, and bump `API_VERSION` if `/api/state` changes. Never break reading older jobs.
- **Keep the orchestrator's context small.** New commands return compact JSON. Large outputs go to files in the job dir, and the CLI returns their paths.
- **Prompts are product.** Agent prompts and checklists are short, imperative, and end with a one-line reply contract. Measure prompt changes with evals where possible. Their hashes show up in the roster.
- Comments explain why, not what.
- Keep `README.md`, `docs/*.md` and `skills/factory/**` in sync with CLI behaviour.

## Check
```bash
node --test "test/*.test.mjs"
claude plugin validate . --strict
```
For dashboard changes, run `factory dash` in a scratch repo, then check light and dark themes, a phone-width viewport, and that agent-authored markdown can't inject HTML.

## Release
Bump `version` in `package.json` and `.claude-plugin/plugin.json` together (they must match), and add a line to `CHANGELOG.md`.
