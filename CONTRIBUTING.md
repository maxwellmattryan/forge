# Contributing to Forge

Forge is a Claude Code plugin that is also its own marketplace. Read [AGENTS.md](AGENTS.md) first: it holds the essentials and the verify list. [docs/DEVELOPING.md](docs/DEVELOPING.md) maps where each kind of change goes, the rules every change follows and the gotchas already paid for. This page covers what you need on top of it to get a change merged.

## Setup

You need Node ≥ 22.18, git ≥ 2.38 and the GitHub CLI (`gh`). Clone the repository, then run `npm ci`. It installs only the dashboard's build toolchain, all exact-pinned devDependencies; the engine itself needs nothing installed. Forge's own `package.json` has no install scripts, but two toolchain packages run their own: esbuild, and fsevents on macOS. A test of `package.json` and its lockfile fails if any other package starts to (being rewritten: [docs/test-rewrite/modules/dashboard.ui.md](docs/test-rewrite/modules/dashboard.ui.md) B7).

Before you open a PR, run every command in [the verify list](AGENTS.md#verify-before-claiming-it-works) in AGENTS.md. The pull-request template repeats it as a checklist. Check engine changes on Node 22.18 itself, not only on a newer 22.x.

## Running Forge from a checkout

Run `npm ci` once. After that, the dashboard and the CLI run your local source, with no release or version bump.

- **`npm run dev [-- --port N] [--scenario NAME]`** builds the dashboard from `dashboard/` into `node_modules/.cache/forge/dashboard-dev/` and rebuilds it on every save. This checkout's `forge dash --dev` serves that build on `dashboard.port` (7400), or the next free port, and prints its URL. Edit a component, then reload the page. Until the first build lands (about 10 s), the page answers 503. One Ctrl-C stops both.
  - Start from `npm run dev -- --scenario <name>`: it seeds a scratch repo with that dashboard scenario (`busy`, `gates`, `failures`, `costs` or `empty`; [docs/TESTING.md](docs/TESTING.md#dashboard-scenarios-and-the-render-check)), prints `[dev] scenario <name> at <path>`, serves it, and removes it when you stop dev.
  - Without `--scenario`, it serves the `.forge/` of the repo you ran it from. To keep a real repo's state out of it, run `FORGE_ROOT=<scratch> npm run dev`, or `cd <scratch> && npm --prefix <checkout> run dev`.
  - It refuses to start while a dashboard is already running for that repo. Stop that one with `forge dash --stop`, or point it at a scratch repo.
  - The daemon stays off until you press Start, even with `daemon.enabled: true`. Its sessions then run this checkout's code.
  - `dashboard/dist/` is never written. The verify list builds it before the tests, and the tests that read it skip without it; it is gitignored, so never commit it.
- **`npm run scenario -- <name> | --list`** seeds a scenario into a fresh scratch repo under the temp dir, prints its path, and waits; Ctrl-C removes it. Point `FORGE_ROOT` at that path to run the CLI or a second tool against it. `--list` names each scenario with its description.
- **`npm run dev:claude [-- <claude args>]`** opens Claude Code on this checkout's plugin (`claude --plugin-dir <checkout>`, with the checkout's `bin/` first on PATH), from the directory you ran it in. The plugin, its skills, agents and hooks, and every `forge` call run the checkout. For that session it overrides an installed Forge. From another repo, run `npm --prefix <checkout> run dev:claude`.
- In any Claude Code session with Forge enabled, `forge` is the loaded plugin's CLI: a SessionStart hook puts that plugin's `bin/` first on PATH, ahead of an `npm link` or another install.
- `npm link`, then `forge help`, runs the CLI on its own.
- Point any of these at a scratch git repo in a temp dir, or set `FORGE_ROOT=<scratch>`, never at a real repo's `.forge/`. Delete the scratch repo and its `<repo>.worktrees` sibling afterwards.
- For dashboard changes, follow the steps under Verify in [dashboard/AGENTS.md](dashboard/AGENTS.md) and check both themes and a phone-width viewport.

## Issues and pull requests

- **One PR per issue.** Find or open the issue first, keep the PR to that one change, and write `Closes #<n>` in its description.
- **PRs are squash-merged**, so the PR title becomes the commit title. Write it as a sentence that says what changes.
- **No AI attribution** in commits, PR descriptions, issues or comments: the human who makes the change is its author (see [Authorship](README.md#authorship)). While the plugin is enabled, its hook blocks a commit or `gh` command that carries it.
- **Leave versions and the changelog alone.** Don't touch the `version` fields in `package.json` and `.claude-plugin/plugin.json`, or `CHANGELOG.md`: the release commit at the end of a wave adds them. Describe user-visible changes in the PR description instead.
- **Branch from `develop` and open PRs into `develop`.** `main` takes only the main update, which the maintainer's `npm run release` pushes with the CI-built `dashboard/dist/`, and hotfixes; leave `dist/` out of every other PR.
- Paths listed in [.github/CODEOWNERS](.github/CODEOWNERS) need the maintainer's review.
- Forge never adopts a PR from a fork (see [Untrusted input](docs/architecture/untrusted-input.md)), so the maintainer reviews those by hand.

## Dependencies

Forge has zero runtime dependencies by rule, so a PR that adds one is closed. Dependabot proposes devDependency updates weekly. Before merging one, the maintainer commits on the Dependabot branch, as the comment in [.github/dependabot.yml](.github/dependabot.yml) describes. Every update changes the dashboard build stamp, which hashes the resolved versions in `package-lock.json`, so the next main update carries a rebuilt `dashboard/dist/`.

## Security and conduct

Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes, never in a public issue. Everyone who takes part in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
