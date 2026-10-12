# Forge

Forge is a lightweight, self-improving **software factory** for AI coding agents. You hand it a feature, a bug or a backlog item. A team of agents plans it, specs it, builds it in its own git worktree, reviews it through the lenses your repo cares about, and opens a pull request, or stops and asks you when only a human can decide.

```
request ─► plan ─► spec ─► [design] ─► spec gate ─► build ─► verify ─► review panel ─► decide ─► integrate ─► PR
                                          (you)        ▲        │          │ CHANGES       │ESCALATE      │
                                                       └────────┴──────────┘               ▼              ▼
                                                                                         (you)    sync: merged / feedback /
                                                                                                  conflicts / CI → continue
```

It ships as a **Claude Code plugin** (an orchestrator skill + 9 agents + a zero-dependency Node CLI + a live dashboard) and works in any repository: each repo only carries a small `.forge/` folder.

- **Parallel by default.** Every job gets its own worktree and branch, a dev-server port, and (for Rust) a shared Cargo build dir. Run several jobs from one session or many. Job claims with heartbeats stop sessions from colliding.
- **PR-aware across sessions.** `forge sync` reconciles every job with GitHub: merged, closed, behind base, conflicting, CI failing, new review threads. `/forge continue #123` picks up any PR, including ones a human started.
- **Your tracker, your way.** A local `backlog.md`, GitHub Issues (with optional label and/or GitHub Projects status sync that reads `.github/project-config.yml`), or your own adapter in `.forge/trackers/<name>.mjs`.
- **A review panel you choose.** Eleven built-in lenses (code, tests, security, ui, ux, accessibility, performance, realtime, infra, api, docs), repo-specific checklists, and a severity policy (`blockOn`) that decides what forces another round.
- **Humans at the right moments.** Spec approval, questions, escalations, infra runbooks and merge conflicts stop the job and land in the dashboard's *Needs you* inbox.
- **Measured and self-improving.** Per-agent and per-job token usage with API-equivalent cost, Forge metrics comparable across repos, eval suites (including replays of your own merged PRs), and retros that propose improvements as reviewed PRs, each logged as an experiment with a baseline.

## Install

In Claude Code:
```
/plugin marketplace add maxwellmattryan/forge
/plugin install forge@forge
```
Requirements: Node ≥ 20, git ≥ 2.38, and the GitHub CLI (`gh`) for PR and GitHub-tracker features.

The CLI also works on its own (for other agent runtimes, scripts or CI):
```bash
npm install -g github:maxwellmattryan/forge   # or: yarn global add github:maxwellmattryan/forge
forge help
```

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

## How it works

- **The orchestrator** (the `forge` skill) runs the loop and is the only one that changes job state, always through the CLI. It reads verdict lines and one-line agent replies, never code or full reviews, so it can drive many jobs without filling its context.
- **Agents** (`agents/*.md`) each own one step and one output file: planner → `plan.md`, spec-writer → `spec.md`, designer → `design.md`/`mockup.html`, builder → commits + `tasks.md` + `build.md`, reviewer → `review/round-N/<lens>.md`, approver → `decision.md` + `pr.md`, integrator → merge resolution, retro → improvement proposals, judge → eval scores. They get their context from files, so any session can resume any job.
- **The CLI** (`forge`) owns the deterministic parts: state transitions, worktrees, ports, running and logging commands, the verify gate, verdict policy, PRs, trackers, usage accounting, stats, evals and the dashboard server.
- **State** lives in `.forge/jobs/<id>/` (gitignored) in the main checkout, shared by every worktree and session: `job.json`, an append-only `events.jsonl`, and the agents' markdown files.

Read more: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/CONFIG.md](docs/CONFIG.md) · [docs/TRACKERS.md](docs/TRACKERS.md) · [docs/IMPROVEMENT.md](docs/IMPROVEMENT.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) (running Forge on other agent runtimes)

## Dashboard

`forge dash` serves a single-page dashboard bound to localhost:

- **Pipeline**: kanban by stage, or a table, filtered by active, waiting or done. Cards show progress, review verdicts per lens, PR and CI state, and running agents.
- **Needs you**: every human gate, with its document and one-click actions.
- **Backlog**: your tracker's ready items; start one with a click.
- **Agents**: running agents, orchestrator sessions, and the roster with models and prompt hashes.
- **Analytics**: Forge metrics plus token and cost breakdowns by role and model.
- **Evals**: runs, side-by-side comparisons, and a Run eval button.

Buttons don't run agents directly. They queue requests that your orchestrator session picks up (`/forge requests`), so permissions and spend stay with you. If you want one-click runs anyway, configure a headless launcher (`dashboard.launcher`).

## License

MIT
