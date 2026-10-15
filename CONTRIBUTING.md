# Contributing to Forge

Forge is a Claude Code plugin that is also its own marketplace. Read [AGENTS.md](AGENTS.md) first: it maps where each kind of change goes, the rules every change follows and the gotchas already paid for. This page covers what you need on top of it to get a change merged.

## Setup

You need Node ≥ 22.18, git ≥ 2.38 and the GitHub CLI (`gh`). Clone the repository, then run `npm ci`. It installs only the dashboard's build toolchain, all exact-pinned devDependencies; the engine itself needs nothing installed. Forge's own `package.json` has no install scripts, but two toolchain packages run their own: esbuild, and fsevents on macOS. `test/dashboard-dist.test.ts` fails if any other package starts to.

Before you open a PR, run every command in [the verify list](AGENTS.md#verify-before-claiming-it-works) in AGENTS.md. The pull-request template repeats it as a checklist. Check engine changes on Node 22.18 itself, not only on a newer 22.x.

## Running Forge from a checkout

- `claude --plugin-dir /path/to/forge` loads the plugin into Claude Code without installing it.
- `npm link`, then `forge help`, runs the CLI on its own.
- Point either at a scratch git repo in a temp dir, or set `FORGE_ROOT=<scratch>`, never at a real repo's `.forge/`. Delete the scratch repo and its `<repo>.worktrees` sibling afterwards.
- For dashboard changes, follow the dashboard steps under [Verify before claiming it works](AGENTS.md#verify-before-claiming-it-works): seed a job or two in the scratch repo, run `forge dash --background`, and check both themes and a phone-width viewport.

## Issues and pull requests

- **One PR per issue.** Find or open the issue first, keep the PR to that one change, and write `Closes #<n>` in its description.
- **PRs are squash-merged**, so the PR title becomes the commit title. Write it as a sentence that says what changes.
- **No AI attribution** in commits, PR descriptions, issues or comments: the human who makes the change is its author (see [Authorship](README.md#authorship)). While the plugin is enabled, its hook blocks a commit or `gh` command that carries it.
- **Leave versions and the changelog alone.** Don't touch the `version` fields in `package.json` and `.claude-plugin/plugin.json`, or `CHANGELOG.md`: the release commit at the end of a wave adds them. Describe user-visible changes in the PR description instead.
- **Commit the rebuilt `dashboard/dist/`** together with the dashboard sources it is built from.
- Paths listed in [.github/CODEOWNERS](.github/CODEOWNERS) need the maintainer's review.
- Forge never adopts a PR from a fork (see [Untrusted input](docs/ARCHITECTURE.md#untrusted-input)), so the maintainer reviews those by hand.

## Dependencies

Forge has zero runtime dependencies by rule, so a PR that adds one is closed. Dependabot proposes devDependency updates weekly. Before merging one, the maintainer commits on the Dependabot branch, as the comment in [.github/dependabot.yml](.github/dependabot.yml) describes. Every update needs a rebuilt `dashboard/dist/` from `npm run build:dashboard`, because the dist build stamp hashes the resolved versions in `package-lock.json`. When a devDependency's own version changes, the new version also goes in the pinned map in `test/dashboard-dist.test.ts`, which asserts every devDependency's exact version; a lockfile-only update leaves that map alone.

## Security and conduct

Report a vulnerability privately as [SECURITY.md](SECURITY.md) describes, never in a public issue. Everyone who takes part in the project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
