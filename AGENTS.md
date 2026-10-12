# Working on the factory itself

This repo is **the factory**: a Claude Code plugin that is also its own marketplace. This guide is for changing the factory. To *use* it in another repo, run `/factory` there. Read `README.md` first; for depth see `docs/ARCHITECTURE.md` (layers, versioning, concurrency, security) and `docs/CONFIG.md` (every config key).

## Layout
- `bin/factory`: CLI entry (also on PATH while the plugin is enabled)
- `lib/`: the engine. `cli.mjs` (commands), `jobs.mjs` (state + events), `schema.mjs` (versions, normalisers, migrations), `config.mjs`, `worktree.mjs`, `pr.mjs`, `trackers/`, `stats.mjs`, `evals.mjs`, `retro.mjs`, `usage.mjs` + `pricing.json`, `server.mjs`, `detect.mjs`, `yaml.mjs`
- `dashboard/`: `index.html` + `app.js`, served by `factory dash`; no build step
- `skills/factory/`: the orchestrator (`SKILL.md`) and on-demand procedures (`reference/`)
- `agents/`: one prompt per role · `reviewers/`: lens checklists · `templates/`: files `init` seeds into `.factory/`
- `docs/`: user docs · `test/`: `node:test` suites

## Where a change goes

| You're changing… | Touch | Also update |
|---|---|---|
| a CLI command or its JSON output | `lib/cli.mjs` (+ the domain module) | `skills/factory/SKILL.md` / `reference/*.md` if the orchestrator calls it; README command table; tests |
| `job.json`, an event or a config shape | `lib/schema.mjs` (bump version, add a migration), `lib/config.mjs` `defaults()` | `docs/CONFIG.md`; `API_VERSION` if `/api/state` changes; a test that reads the old shape |
| orchestrator behaviour | `skills/factory/SKILL.md` (keep it lean) or a `reference/*.md` loaded on demand | README "How it works" if user-visible |
| a role's behaviour | `agents/<role>.md` | its prompt hash changes (shown in the roster); CHANGELOG; measure with evals where possible |
| a review lens | `reviewers/<lens>.md` | `lib/detect.mjs` suggestions + `reference/init.md` presets if it should be offered |
| tracker behaviour | `lib/trackers/{local,github}.mjs`, contract in `index.mjs`, status mapping in `status.mjs` | `docs/TRACKERS.md` |
| the dashboard | `dashboard/app.js`, `dashboard/index.html`, endpoints in `lib/server.mjs` | `API_VERSION` on shape changes |
| prices or model ids | `lib/pricing.json` (bump `asOf`) | take prices from Anthropic's current pricing, never from memory |

`lib/cli.mjs` and `dashboard/app.js` are the largest files (~700+ lines). When adding to them, split by command group or view into new modules rather than growing them.

## Rules
- **Zero runtime dependencies.** Node ≥ 20 built-ins only, plain ESM with JSDoc types (`// @ts-check`). The dashboard may load only pinned, SRI-protected CDN assets. No Python tooling: Node, or Rust if a native binary is ever justified.
- **The CLI is the only writer of state.** New state means a new CLI command, never "the agent edits job.json".
- **Version every shape change.** Bump the constant in `lib/schema.mjs`, add a migration keyed by the old version, keep normalisers tolerant, and bump `API_VERSION` if `/api/state` changes. Never break reading older jobs.
- **Keep the orchestrator's context small.** New commands return compact JSON. Large outputs go to files in the job dir, and the CLI returns their paths.
- **Prompts are product.** Agent prompts and checklists are short, imperative, and end with a one-line reply contract. Prefer measuring a prompt or policy change (evals, `factory stats`) over arguing about it.
- **Preserve the security posture** (ARCHITECTURE.md "Untrusted input" and "Dashboard security"): never adopt fork PRs; the server answers loopback Hosts only; POSTs need the token, a matching Origin and JSON; tracker and PR text is fenced as data, and agents are told so. Anything new that ingests outside text follows the same pattern.
- Comments explain why, not what.
- Keep `README.md`, `docs/*.md` and `skills/factory/**` in sync with CLI behaviour.

## Verify before claiming it works
```bash
node --test "test/*.test.mjs"           # not `node --test test/`: Node 22 treats a directory arg as a module
for f in lib/*.mjs lib/trackers/*.mjs dashboard/app.js bin/factory; do node --check "$f"; done
claude plugin validate . --strict
```
- **Never point the CLI at a real repo's `.factory/` while developing.** Use a scratch git repo in a temp dir, or set `FACTORY_ROOT=<scratch>` (as `test/helpers.mjs` does). Delete scratch repos *and* their `<repo>.worktrees` siblings afterwards.
- **Dashboard:** in a scratch repo, seed a job or two (`factory job new`, `factory job set`), run `factory dash --background`, and open it in a browser. Check light and dark themes, a phone-width viewport, the job drawer, and that markdown containing `<script>` / `<img onerror>` renders escaped. Stop it with `factory dash --stop` from the same scratch repo.
- **The plugin inside Claude Code:** `claude --plugin-dir <this checkout>` loads it without installing. `claude plugin details factory` shows the component inventory and projected token cost, which is useful when trimming prompts.
- **GitHub code paths** (`pr.mjs`, `trackers/github.mjs`): read-only checks against real repos are fine. Anything that writes (PRs, labels, Project fields, comments, issues) goes only to a throwaway repo the maintainer approves.

## Gotchas already paid for
- **Tailwind v4 browser build**: `@apply` accepts only built-in utilities or classes declared with `@utility`; plain `.class {}` rules can't be `@apply`'d. Bumping the CDN version means recomputing the SRI hash: `curl -sS <url> | openssl dgst -sha384 -binary | openssl base64 -A`.
- **Escape everything the dashboard renders.** All interpolation goes through `esc()`, and markdown goes through the escape-first `md()`. Don't add a markdown library or `innerHTML` raw data. Job HTML (mockups) renders only in the sandboxed iframe (`/raw`).
- **Claude Code transcripts** (`~/.claude/projects/*/<session>/subagents/agent-<id>.jsonl`) log each content block as its own line sharing one `message.id`. Their `usage.output_tokens` is the stream's opening snapshot, not the final count, which is why `usage.mjs` dedupes by message id, counts tools by block id, and estimates output from content.
- **Plugin runtime**: `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_SESSION_ID}` are substituted in skill/agent *markdown*, not exported to the shell. `bin/` is on PATH while the plugin is enabled. Plugin agents are invoked as `factory:<role>`.
- **CLI output**: string results print raw (e.g. `factory worktree path`), everything else prints compact JSON.
- **`--field` values** are not comma-split, because JSON arrays contain commas. Other list flags are.
- **Local tracker refs** are title slugs, and the job id for a non-numeric ref is the ref itself. Numeric (GitHub) refs become `<n>-<slug>`.
- **Worktrees live outside the repo** on purpose: a nested worktree inside a Cargo workspace breaks Cargo, and bundlers and watchers pick up the copies. Don't "simplify" this to an in-repo `.worktrees/`.

## Publishing
This repo is public. Use the GitHub no-reply commit email, and never commit hostnames, home paths, tokens or real job state (`.factory/` is gitignored here). Bump `version` in `package.json` and `.claude-plugin/plugin.json` together (they must match), and add a `CHANGELOG.md` entry.
