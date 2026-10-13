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
  <a href="https://github.com/maxwellmattryan/forge/blob/main/CHANGELOG.md"><img alt="version" src="https://img.shields.io/github/package-json/v/maxwellmattryan/forge?color=F97316&label=version"></a>
  <a href="#install"><img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-EA580C"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-C2410C">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A520-9A3412">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-7C2D12"></a>
</p>

⚒️ **Forge** is a lightweight, self-improving **software factory** for AI coding agents. You hand it a feature, a bug or a backlog item. A team of agents plans it, specs it, builds it in its own git worktree, reviews it through the lenses your repo cares about, and opens a pull request, or stops and asks you when only a human can decide.

```
request ─► plan ─► spec ─► [design] ─► spec gate ─► build ─► verify ─► review panel ─► decide ─► integrate ─► PR
                                          (you)        ▲        │          │ CHANGES       │ESCALATE      │
                                                       └────────┴──────────┘               ▼              ▼
                                                                                         (you)    sync: merged / feedback /
                                                                                                  conflicts / CI → continue
```

It ships as a **Claude Code plugin** (an orchestrator skill + 9 agents + a zero-dependency Node CLI + a live dashboard) and works in any repository: each repo only carries a small `.forge/` folder.

- 🔀 **Parallel by default.** Every job gets its own worktree and branch, a dev-server port, and (for Rust) a shared Cargo build dir. Run several jobs from one session or many. Job claims with heartbeats stop sessions from colliding.
- 🔁 **PR-aware across sessions.** `forge sync` reconciles every job with GitHub: merged, closed, behind base, conflicting, CI failing, new review threads. `/forge continue #123` picks up any PR, including ones a human started.
- 🗂️ **Your tracker, your way.** A local `backlog.md`, GitHub Issues (with optional label and/or GitHub Projects status sync that reads `.github/project-config.yml`), or your own adapter in `.forge/trackers/<name>.mjs` (or `.ts`).
- 🔍 **A review panel you choose.** Eleven built-in lenses (code, tests, security, ui, ux, accessibility, performance, realtime, infra, api, docs), repo-specific checklists, and a severity policy (`blockOn`) that decides what forces another round.
- 🙋 **Humans at the right moments.** Spec approval, split proposals (one issue is one PR unless you approve a split), questions, escalations, infra runbooks, merge conflicts and budget overruns stop the job and land in the dashboard's *Needs you* inbox.
- ✍️ **You're the author.** Nothing Forge produces credits an AI: no co-author trailers, no "Generated with" footers, no session links in commits, PRs, issues or comments. See [Authorship](#authorship).
- 📈 **Measured and self-improving.** Per-agent and per-job token usage with API-equivalent cost, Forge metrics comparable across repos, eval suites (including replays of your own merged PRs), and retros that propose improvements as reviewed PRs, each logged as an experiment with a baseline.

## Install

In Claude Code:
```
/plugin marketplace add maxwellmattryan/forge
/plugin install forge@forge
```
Requirements: Node ≥ 22.18, git ≥ 2.38, and the GitHub CLI (`gh`) for PR and GitHub-tracker features.
On Node older than 22.18 the CLI fails at import and the attribution hook cannot load: it exits 1, which Claude Code does not treat as a block, so `aiAttribution: forbid` is not enforced.

The CLI also works on its own (for other agent runtimes, scripts or CI):
```bash
git clone https://github.com/maxwellmattryan/forge && cd forge && npm link
forge help
```
Forge's engine is TypeScript that Node runs directly, and Node does not strip types under `node_modules`, so install from a clone, not as a global npm package.

## Start

```
/forge init                      # detects your stack, asks a few questions, writes .forge/config.yml
/forge dash                      # opens the dashboard (http://127.0.0.1:7400)
/forge Add a reading-time badge to blog posts
/forge next 3                    # take the next three ready backlog items, in parallel
```
Commit the `.forge/` folder; runtime state inside it is gitignored.

The skill can be invoked as `/forge` or, fully qualified, `/forge:forge`.

## Commands

| | |
|---|---|
| `/forge <feature>` | new job from free text |
| `/forge next [n]` · `/forge issue <ref>` | take work from the tracker |
| `/forge continue <job \| #pr \| ref> [note]` | resume a job or PR: sync, integrate, address review feedback or CI |
| `/forge approve <job>` · `revise <job> <note>` · `answer <job> <text>` · `rework <job> <note>` · `cancel <job>` | human decisions |
| `/forge status` · `sync` · `dash` · `doctor` · `requests` | operate |
| `/forge retro` · `/forge eval …` | improve and measure |
| `forge daemon status` · `forge daemon log <job>\|--inbox [--follow]` | the daemon's sessions and a session's log, from the terminal |
| `forge config get <key>` · `forge config set <key> <value>` | read the effective config, or change one editable key in `.forge/config.yml`, keeping its comments (see [Changing settings](docs/CONFIG.md#changing-settings)) |

## How it works

- **The orchestrator** (the `forge` skill) runs the loop and is the only one that changes job state, always through the CLI. It reads verdict lines and one-line agent replies, never code or full reviews, so it can drive many jobs without filling its context.
- **Agents** (`agents/*.md`) each own one step and one output file: planner → `plan.md`, spec-writer → `spec.md`, designer → `design.md`/`mockup.html`, builder → commits + `tasks.md` + `build.md`, reviewer → `review/round-N/<lens>.md` (and `review/integration/code.md` after a resolved conflict, judged by `forge job verdicts --round integration`), approver → `decision.md` + `pr.md`, integrator → merge resolution, retro → improvement proposals, judge → eval scores. They get their context from files, so any session can resume any job.
- **The CLI** (`forge`) owns the deterministic parts: state transitions, worktrees, ports, running and logging commands, the verify gate (with a test-integrity report), scope checks (files changed vs the spec's Approach), AC coverage (`forge job acs`: spec ACs vs the builder's proof table), verdict policy, PRs, trackers, usage accounting, stats, evals and the dashboard server.
- **Merging waits for CI.** `forge pr merge` (used when `merge.auto: true`) syncs first, then merges directly only when checks pass or the repo has no CI workflows, refuses when they fail, and while checks are pending queues GitHub auto-merge only if branch protection will hold the PR; otherwise it defers and the next `forge sync` retries. Refused and failed merges exit 1. `--now` is a human override that bypasses CI and is logged as `pr-merge-bypass`; the orchestrator never uses it on its own.
- **State** lives in `.forge/jobs/<id>/` (gitignored) in the main checkout, shared by every worktree and session: `job.json`, an append-only `events.jsonl`, and the agents' markdown files.

Read more: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/CONFIG.md](docs/CONFIG.md) · [docs/TRACKERS.md](docs/TRACKERS.md) · [docs/IMPROVEMENT.md](docs/IMPROVEMENT.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) (running Forge on other agent runtimes)

## Dashboard

`forge dash` serves a single-page dashboard bound to localhost:

- **Pipeline**: kanban by stage, or a table, filtered by active, waiting or done. Cards show progress, review verdicts per lens, PR and CI state, running agents, budget use against `pipeline.budget`, and an `after <job>` chip per dependency that opens it; the job drawer lists what a job depends on and what it blocks, plus its files, timeline, screenshots and its daemon **Session**: the job's headless session log, live, grouped by turn, with every tool call and its result, subagents (`forge:builder`, `forge:reviewer`, …) nested under the call that started them, errors, cost, filters and Start/Stop for that job's session.
- **Needs you**: every human gate, with its document and one-click actions.
- **Backlog**: your tracker's ready items; start one with a click.
- **Agents**: running agents, orchestrator sessions, and the roster with models and prompt hashes.
- **Analytics**: Forge metrics plus token and cost breakdowns by role and model.
- **Evals**: runs, side-by-side comparisons, and a Run eval button.
- **Settings** (the gear, or press `,`): language and theme, the editable `.forge/config.yml` keys as forms saved through `forge config set`'s write path, `forge doctor` diagnostics with a copyable report, and the versions Forge is running. Settings are locked while the daemon runs, because any change to `config.yml` stops it.

The dashboard is a Svelte 5 + TypeScript single-page app. Its built output (`dashboard/dist/`) is committed, so installing the plugin builds and installs nothing.

Buttons don't run agents directly. They queue requests, and an orchestrator session drains them: your own (`/forge requests`), so permissions and spend stay with you, or, with `daemon.enabled: true`, a headless Claude Code session that `forge dash` supervises and nudges whenever new requests arrive. With the daemon, each job gets its own headless session (up to `daemon.maxConcurrent` at once), and a small inbox session takes requests that have no job yet, so one job's crash never stalls another and each job has a log of its own. The daemon spends tokens unattended, limited to the tools in `daemon.allowedTools`; see [Daemon](docs/CONFIG.md#daemon). When it is in use, a bar above every view summarises the pool: its status, the inbox (click it for the inbox's live log), `live/cap` job sessions, holds on budget, jobs waiting for a slot, a chip per job session that opens its Session tab, and Start and Stop. `forge daemon status` and `forge daemon log <job> --follow` show the same from a terminal.

## Authorship

Forge treats the human who runs it as the author of everything it produces. This is enforced in three layers:

1. **Prompts**: the orchestrator and every agent that writes commits or GitHub text are told never to add AI attribution.
2. **A hook**: while the plugin is enabled, a `PreToolUse` hook inspects every `git commit/tag/merge`, `gh pr/issue/release/api` and `glab` command (including `-F`/`--body-file` files) and blocks it if it carries an AI co-author trailer, a "Generated with …" footer, a robot-emoji signature or a session link. It runs for subagents too. Mentions such as "parse Claude Code transcripts" pass; only signatures are blocked.
3. **The CLI**: before `forge pr open` pushes, it rewrites any branch commit message that still carries attribution (content and authorship untouched), and it strips attribution from PR bodies, issues and tracker comments.

Claude Code adds its own trailer and PR footer unless told not to, and a plugin isn't allowed to change that setting for you. To turn them off everywhere (not just in Forge), add this to `~/.claude/settings.json` (Claude Code ≥ 2.1.281):
```json
{ "attribution": false }
```
Opting out: `aiAttribution: allow` in a repo's `.forge/config.yml`, or `FORGE_AI_ATTRIBUTION=allow` in the environment.

## License

MIT · Strike while the iron is hot. 🔥
