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

### Updating

Run `forge update` in a terminal or `/forge update` in Claude Code. It updates the install that is running. For a plugin install it runs `claude plugin marketplace update <marketplace>` and then `claude plugin update forge@<marketplace>`. For a clone it runs `git pull --ff-only`, and refuses when the checkout has uncommitted changes, a detached HEAD or no upstream. It prints the old and new versions, restarts the current repo's running dashboard on the new code, and lists what still needs a restart: a new Claude Code session for a plugin install, and dashboards in other repos. `forge update --check` only shows what it would run. `--keep-dash` leaves this repo's dashboard alone. Nothing is built or installed, because `dashboard/dist/` is committed and Forge has no runtime dependencies.

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
| `/forge next [n]` · `/forge issue <ref>` | take work: `next` first resumes a queued job nobody drives, else starts the next ready tracker item |
| `/forge continue <job \| #pr \| ref> [note]` | resume a job or PR: sync, integrate, address review feedback or CI |
| `/forge approve <job>` · `revise <job> <note>` · `answer <job> <text>` · `rework <job> <note>` · `cancel <job>` | human decisions |
| `/forge status` · `sync` · `dash` · `doctor` · `requests` | operate |
| `/forge retro` · `/forge eval …` | improve and measure |
| `forge job step <id>` | the job's next action (`spawn` with a ready agent brief, `run`, `wait`, `procedure` or `done`); read-only, the same state always gives the same answer, except that `--session <owner>` refreshes that session's claim heartbeat |
| `forge git commit <job> (--message T \| --message-file F) [-- paths]` · `forge git add <job> -- paths` | commit or stage in the job's worktree, on its branch, from any cwd (how agents commit, in a daemon session too); refuses git options, paths outside the worktree and AI attribution |
| `forge daemon status` · `forge daemon log <job>\|--inbox [--lines N] [--follow]` | the daemon's sessions and a session's log, from the terminal |
| `forge job link <job> <ref>\|--create\|--none` · `forge tracker search <query>` | link a job to an issue, create one, or record that it needs none; search the tracker (see [Linking jobs to issues](docs/TRACKERS.md#linking-jobs-to-issues)) |
| `forge update [--check] [--keep-dash]` · `/forge update` | update this Forge install (plugin or clone) and restart this repo's dashboard on the new code (see [Updating](#updating)) |
| `forge config get <key>` · `forge config set <key> <value>` | read the effective config, or change one editable key in `.forge/config.yml`, keeping its comments (see [Changing settings](docs/CONFIG.md#changing-settings)) |

## How it works

- **The orchestrator** (the `forge` skill) runs a short loop: `forge job step <id> --session <its session>` (which keeps its claim alive) returns the next action, the orchestrator does it (spawn the named agent with the brief step rendered, or run the command step built), records the agent with `forge job agent … end`, and steps again. The CLI decides each step from recorded state, the same way it is the only writer of that state, so the pipeline's rules are tested code rather than prose. The orchestrator reads JSON and one-line agent replies, never code or full reviews, so it can drive many jobs without filling its context.
- **Agents** (`agents/*.md`) each own one step and one output file: planner → `plan.md`, spec-writer → `spec.md`, designer → `design.md`/`mockup.html`, builder → commits + `tasks.md` + `build.md`, reviewer → `review/round-N/<lens>.md` (and `review/integration/code.md` after a resolved conflict, judged by `forge job verdicts --round integration`), approver → `decision.md` + `pr.md`, integrator → merge resolution, retro → improvement proposals, judge → eval scores. They get their context from files, so any session can resume any job.
- **The CLI** (`forge`) owns the deterministic parts: state transitions, worktrees, ports, running and logging commands, the verify gate (with a test-integrity report), scope checks (files changed vs the spec's Approach), AC coverage (`forge job acs`: spec ACs vs the builder's proof table), verdict policy, PRs, trackers, usage accounting, stats, evals and the dashboard server.
- **Merging waits for CI.** `forge pr merge` (used when `merge.auto: true`) syncs first, then merges directly only when checks pass or the repo has no CI workflows, refuses when they fail, and while checks are pending queues GitHub auto-merge only if branch protection will hold the PR; otherwise it defers and the next `forge sync` retries. Refused and failed merges exit 1. `--now` is a human override that bypasses CI and is logged as `pr-merge-bypass`; the orchestrator never uses it on its own.
- **1 job = 1 PR = 1 issue.** With a tracker in use, a job that didn't start from an issue stops at Intake until you link one of the candidates Forge found, approve a new issue, or record that it needs none (see [Linking jobs to issues](docs/TRACKERS.md#linking-jobs-to-issues)).
- **State** lives in `.forge/jobs/<id>/` (gitignored) in the main checkout, shared by every worktree and session: `job.json`, an append-only `events.jsonl`, and the agents' markdown files.

Read more: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/CONFIG.md](docs/CONFIG.md) · [docs/TRACKERS.md](docs/TRACKERS.md) · [docs/IMPROVEMENT.md](docs/IMPROVEMENT.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) (running Forge on other agent runtimes)

## Dashboard

`forge dash` serves a single-page dashboard bound to localhost, drawn like a blueprint (the cyanotype theme here; vellum is the paper one):

![The Pipeline board in the cyanotype theme: jobs in Queued, Plan, Spec and Design columns, two of them redlined because they wait on a person](assets/screenshots/pipeline.png)

![A job's drawer open on its Thread: two requests about the job, one answered by Forge, above the job's session log with its filters](assets/screenshots/job-drawer.png)

![Settings › General: the Theme segments (Cyanotype, Vellum, System), the Grid and Paper checkboxes, the language and the settings shortcut](assets/screenshots/settings-appearance.png)

- **Pipeline**: a board of four stage groups (Queued, Plan, Build, Ship, plus Done when the filter holds finished jobs) that fits a desktop without scrolling sideways, or a table, filtered by active, waiting or done, most urgent first. Every card has the same slots and a nine-dot stage stepper, and shows progress, review verdicts per lens, PR and CI state, running agents, budget use against `pipeline.budget`, and an `after <job>` chip per dependency that opens it; the job drawer lists what a job depends on and what it blocks, plus its files, timeline, screenshots and its **Thread**: the job's own request (yours, or the issue's text for a job started from an issue), then the requests sent about the job (yours, the CLI's and Forge's hand-offs) with the session's replies, and the job's headless session log, live (markdown in files, the conversation and the session log renders formatted, with a Rendered/Raw toggle per surface that the browser remembers), grouped by turn with a time on every line, with every tool call and its result, subagents (`forge:builder`, `forge:reviewer`, …) nested under the call that started them with their live progress (current step, tool count, tokens, elapsed) and outcome folded into that line, permission denials, hook outcomes, rate-limit status, errors, cost, filters and Start/Stop for that job's session. A dock pinned to the bottom of the drawer, on every tab, holds the gate's actions when the job needs you, its session's permission prompts, and **Resume** for a queued, failed or stalled job (disabled, naming the session, while another session still holds it); it is absent when nothing needs you.
- **Command bar** (Cmd-K or Ctrl-K, or **New job or command** in the sidebar): type a request in plain words to start a job (its title is derived from the text, or give one), or a command with completion: `next [n]`, `sync`, `retro`, `continue <job> [note]` (or `resume`), `approve|revise|rework|answer|cancel <job> [note]`, `issue <ref>`. A new job's card appears at once and its drawer opens on the Thread.
- **Needs you**: every human gate, with its document and one-click actions (for an issue to link: the candidates Forge found, another ref, a new issue, or none). Jobs parked on unfinished dependencies are not gates: they are listed apart, with **Unblocked, resume**, and are neither redlined nor counted in the badge.
- **Backlog**: your tracker's ready items; start one with a click.
- **Agents**: running agents, orchestrator sessions, and the roster with models and prompt hashes.
- **Analytics**: Forge metrics plus token and cost breakdowns by role and model.
- **Evals**: runs, side-by-side comparisons, and a Run eval button.
- **Settings** (the gear, or press `,`): **General** holds this browser's preferences, never stored in `config.yml`: Theme (`cyanotype`, `vellum`, or `system` to follow the OS, live; the old `dark` and `light` still read as cyanotype and vellum), **Grid** (the 8px drawing grid) and **Paper** (the fibre texture and the corner falloff), plus language and the `,` shortcut. The dashboard also honours your OS's reduced-motion setting: nothing slides or fades. The rest of Settings is the editable `.forge/config.yml` keys as forms saved through `forge config set`'s write path, `forge doctor` diagnostics with a copyable report, and the versions Forge is running. Settings are locked while the daemon runs, because any change to `config.yml` stops it.

The dashboard is a Svelte 5 + TypeScript single-page app. Its built output (`dashboard/dist/`) is committed, so installing the plugin builds and installs nothing.

Buttons don't run agents directly. They queue requests, and an orchestrator session drains them: your own (`/forge requests`), so permissions and spend stay with you, or, with `daemon.enabled: true`, a headless Claude Code session that `forge dash` supervises and nudges whenever new requests arrive. With the daemon, each job gets its own headless session (up to `daemon.maxConcurrent` at once), and a small inbox session takes requests that have no job yet, so one job's crash never stalls another and each job has a log of its own. The daemon spends tokens unattended, limited to the tools in `daemon.allowedTools`. When an agent needs anything else, its session pauses and the call shows in the bar and in the job drawer's dock with Allow once, Allow for this session and Deny, so you grant it from the dashboard instead of editing config. Each session's log also has a **Permissions** selector (Ask, Auto, Refuse) that switches that one session's Claude Code permission mode, live, until `forge dash` restarts; see [Daemon](docs/CONFIG.md#daemon). When it is in use, a bar above every view summarises the pool: its status, the inbox (click it for the inbox's live log), `live/cap` job sessions, holds on budget, jobs waiting for a slot, a chip per job session that opens its Thread, and Start and Stop. `forge daemon status` and `forge daemon log <job> --follow` show the same from a terminal.

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
