<p align="center">
  <img src="assets/forge.png" alt="Forge anvil logo" width="128" height="128">
</p>

<h1 align="center">Forge</h1>

> Thus at the flaming forge of life<br>
> Our fortunes must be wrought;<br>
> Thus on its sounding anvil shaped<br>
> Each burning deed and thought!
>
> — Henry Wadsworth Longfellow, *The Village Blacksmith* (1840)

<p align="center">
  <a href="https://github.com/maxwellmattryan/forge/blob/develop/CHANGELOG.md"><img alt="version" src="https://img.shields.io/github/package-json/v/maxwellmattryan/forge?color=A6CDF2&label=version"></a>
  <a href="https://github.com/maxwellmattryan/forge/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/maxwellmattryan/forge/ci.yml?branch=develop&label=ci"></a>
  <a href="#install"><img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-8C99A8"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4A6684">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.18-223850">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-1B2128"></a>
</p>

⚒️ **Forge** is a lightweight, self-improving **software factory** for AI coding agents. You hand it a feature, a bug or a backlog item. A team of agents plans it, specs it, builds it in its own git worktree, reviews it through the lenses your repo cares about, and opens a pull request, or stops and asks you when only a human can decide.

![The Forge dashboard's Pipeline board: jobs queued, planning, building and in review, three agents running, two open PRs (one with checks passing, one pending), two jobs outlined in ember because they wait on you, and the Foreman and Daemon running in the status bar](assets/screenshots/pipeline.jpg)

It ships as a **Claude Code plugin** (an orchestrator skill, 13 agents, a zero-dependency Node CLI and a live dashboard) and works in any repository: each repo only carries a small `.forge/` folder.

- 🔀 **Parallel by default.** Every job gets its own worktree, branch and ports; a lease per job keeps sessions from colliding, and a crashed session's jobs are resumed.
- 🔁 **PR-aware.** `forge sync` follows every PR through merges, conflicts, failing CI and review threads, and `/forge continue #123` picks up any PR in the repo.
- 🗂️ **Your tracker.** A local `backlog.md`, GitHub Issues and Projects, or your own adapter ([docs/TRACKERS.md](docs/TRACKERS.md)).
- 🔍 **A review panel you choose.** Twelve built-in lenses, your own checklists, and narrow yes/no [verifiers](docs/VERIFIERS.md) that run before the panel.
- 🙋 **Humans at the right moments.** Spec approval, split proposals, escalations, conflicts, budget overruns and caught secrets stop the job and wait for you.
- ✍️ **You're the author.** Nothing Forge produces credits an AI ([Authorship](#authorship)).
- 📈 **Measured and self-improving.** Token and cost tracking per agent and job, eval suites, and retros that propose improvements as reviewed PRs ([docs/IMPROVEMENT.md](docs/IMPROVEMENT.md)).

## Install

In Claude Code:
```
/plugin marketplace add maxwellmattryan/forge
/plugin install forge@forge
```
You need Node ≥ 22.18 and git ≥ 2.38, plus `gh` ≥ 2.40 for pull requests. To use the CLI without Claude Code (other agent runtimes, scripts, CI), clone this repo and `npm link` it ([details](docs/RELEASES.md#installing-and-updating)).

### Updating

Run `/forge update` (or `forge update` in a terminal) when a new release is out: it updates the plugin or clone and restarts your dashboard. To pin or roll back a version, see [Provenance and pinning](docs/RELEASES.md#provenance-and-pinning).

## Start

```
/forge init                      # detects your stack, asks a few questions, writes .forge/config.yml
/forge dash                      # opens the machine's dashboard for this repo: its login link (http://127.0.0.1:7400/?project=<name>#k=<key>)
forge dash url                   # reprints the login link, for a new browser or after a restart
/forge Add a reading-time badge to blog posts
/forge next 3                    # take the next three ready backlog items, in parallel
```
Commit the `.forge/` folder; runtime state inside it is gitignored.

The skill can be invoked as `/forge` or, fully qualified, `/forge:forge`.

## Commands

| | |
|---|---|
| `/forge <feature>` | new job from free text |
| `/forge next [n]` · `/forge issue <ref>` | take work: `next` first resumes a queued job nobody drives, else triages and starts the next ready tracker item |
| `/forge triage [n]` | readiness triage: mark ready items that lack an outcome, acceptance criteria, a bounded scope or are duplicates as needs-info, with one templated comment, so `next` skips them ([details](docs/TRACKERS.md#readiness-triage)) |
| `/forge continue <job \| #pr \| ref> [note]` | resume a job or PR: sync, integrate, address review feedback or CI |
| `/forge approve <job>` · `revise <job> <note>` · `answer <job> <text>` · `rework <job> <note>` · `cancel <job>` | human decisions |
| `/forge status` · `sync` · `dash` · `doctor` · `requests` · `update` | operate |
| `/forge retro` · `/forge eval …` | improve and measure |

The `forge` CLI underneath also serves scripts, CI and other agent runtimes: see [Common commands](docs/CLI.md#common-commands) and the full [CLI reference](docs/CLI.md).

## How it works

```
  request
     │
     ▼
   plan ──► spec ──► [design] ──► spec gate ◄── you approve
                                      │
     ┌────────────────────────────────┘
     ▼
   build ──► verify ──► verifiers ──► review panel
     ▲         │           │               │
     └─────────┴───────────┴───────────────┤ fail / CHANGES
                                           │ pass
                                           ▼
                                       integrate
                                           │
                                           ▼
                                        decide
                                           │ APPROVE · ESCALATE
                                           ▼
                     you ◄── merge gate ── PR ──► sync: merged, review
                                                  feedback, conflicts,
                                                  CI → continue
```

1. **Plan.** The planner decides whether your request is one job or several, and the spec-writer turns it into a spec with acceptance criteria for you to approve.
2. **Build.** The builder implements the spec on its own branch and worktree, then your tests and verifiers check it.
3. **Review.** A panel of reviewers, picked from what the diff touches, reads it through one lens each; blocking findings send it back to build.
4. **Decide.** The approver opens the pull request, or escalates to you on the open PR (the merge waits for you there), and Forge follows the PR until it merges.

The CLI owns every deterministic step and all state, so agents only judge, and any session can resume any job. Dive deeper: [How it works](docs/ARCHITECTURE.md#how-it-works) · [Dashboard](docs/DASHBOARD.md) · [CLI](docs/CLI.md) · [Config](docs/CONFIG.md) · [Glossary](docs/GLOSSARY.md) · [Other agent runtimes](docs/PROTOCOL.md)

## Notifications

Gates wait on you, so Forge can tell you. Add `notify:` to `.forge/config.yml` and it posts a small, fixed-shape message to your Slack (or any JSON webhook) and runs your own command when a job needs a human, a PR opens or merges, a job fails, the daemon stops on its own, a budget is exceeded or a secret is found:

```yaml
notify:
  webhooks:
    - url: https://hooks.slack.com/services/T000/B000/XXXX
      events: [gate, pr-opened, job-failed]   # omitted = every event
      format: slack                           # json (default) | slack
  command: ./scripts/page.sh {event} {job} {title} {url}
```

Delivery runs in a detached process and never blocks the pipeline. The message carries only fixed reason text and the job's sanitised title, never request, review or agent text, and only a webhook's host is ever logged. `forge notify test` sends a sample. See [Notifications](docs/CONFIG.md#notifications).

## Authorship

Forge treats the human who runs it as the author of everything it produces. This is enforced in three layers:

1. **Prompts**: the orchestrator and every agent that writes commits or GitHub text are told never to add AI attribution.
2. **A hook**: while the plugin is enabled, a `PreToolUse` hook checks every `git`, `gh` or `glab` command for attribution text, whatever global options come before the subcommand, including the message files it names with `--file=` / `-F` / `--body-file` (or `--template` / `-t`), `--notes-file`, `--input` and `gh api -F key=@file`. It blocks the command if that text carries an AI co-author trailer, a "Generated with …" footer, a robot-emoji signature or a session link. It runs for subagents too. Mentions such as "parse Claude Code transcripts" pass; only signatures are blocked.
3. **The CLI**: before `forge pr open` pushes, it rewrites any branch commit message that still carries attribution (content and authorship untouched), and it strips attribution from PR bodies, issues and tracker comments.

Claude Code adds its own trailer and PR footer unless told not to, and a plugin isn't allowed to change that setting for you. To turn them off everywhere (not just in Forge), add this to `~/.claude/settings.json` (Claude Code ≥ 2.1.281):
```json
{ "attribution": false }
```
Opting out: `aiAttribution: allow` in a repo's `.forge/config.yml`, or `FORGE_AI_ATTRIBUTION=allow` in the environment. The hook reads `aiAttribution: allow` from the main checkout's `.forge/config.yml` of the project Claude Code runs in, never from a worktree's own config or the command's directory.

## Project

- [Security policy](SECURITY.md): report vulnerabilities privately. Fixes go to the latest minor release ([supported versions](SECURITY.md#supported-versions)).
- [Contributing](CONTRIBUTING.md): development setup and the local dev flow (`npm run dev`, `npm run dev:claude`), the verify list and pull-request conventions.
- [Code of Conduct](CODE_OF_CONDUCT.md): Contributor Covenant 2.1.

## License

MIT · Strike while the iron is hot. 🔥
