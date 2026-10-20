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
  <a href="https://github.com/maxwellmattryan/forge/blob/main/CHANGELOG.md"><img alt="version" src="https://img.shields.io/github/package-json/v/maxwellmattryan/forge?color=A6CDF2&label=version"></a>
  <a href="https://github.com/maxwellmattryan/forge/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/maxwellmattryan/forge/ci.yml?branch=main&label=ci"></a>
  <a href="#install"><img alt="Claude Code plugin" src="https://img.shields.io/badge/Claude%20Code-plugin-8C99A8"></a>
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4A6684">
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A522.18-223850">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-1B2128"></a>
</p>

⚒️ **Forge** is a lightweight, self-improving **software factory** for AI coding agents. You hand it a feature, a bug or a backlog item. A team of agents plans it, specs it, builds it in its own git worktree, reviews it through the lenses your repo cares about, and opens a pull request, or stops and asks you when only a human can decide.

```
request ─► plan ─► spec ─► [design] ─► spec gate ─► build ─► verify ─► verifiers ─► review panel ─► integrate ─► decide ─► PR
                                          (you)        ▲        │      │                │ CHANGES                  │ESCALATE│
                                                       └────────┴──────┴────────────────┘                          ▼        ▼
                                                                                                                 (you)  sync: merged / feedback /
                                                                                                                        conflicts / CI → continue
```

It ships as a **Claude Code plugin** (an orchestrator skill + 11 agents + a zero-dependency Node CLI + a live dashboard) and works in any repository: each repo only carries a small `.forge/` folder.

- 🔀 **Parallel by default.** Every job gets its own worktree and branch, a port per component, and (for Rust) a shared Cargo build dir. Run several jobs from one session or many. Job claims with heartbeats stop sessions from colliding.
- 🔁 **PR-aware across sessions.** `forge sync` reconciles every job with GitHub: merged, closed, behind base, conflicting, CI failing, new review threads. A PR that falls behind, or conflicts under `pr.conflicts: fix`, goes straight to the integrator. `/forge continue #123` picks up any PR, including ones a human started.
- 🗂️ **Your tracker, your way.** A local `backlog.md`, GitHub Issues (with optional label and/or GitHub Projects status sync that reads `.github/project-config.yml`), or your own adapter in `.forge/trackers/<name>.mjs` (or `.ts`).
- 🔍 **A review panel you choose.** Twelve built-in lenses (code, tests, security, design, ui, ux, accessibility, performance, realtime, infra, api, docs), repo-specific checklists, and a severity policy (`blockOn`) that decides what forces another round.
- ✅ **Narrow checks before the panel.** Verifiers are your repo's own yes/no questions scoped to file globs (`.forge/verifiers/<name>.md`). A small model answers them against only the matching hunks once verify passes; a `block` failure sends the builder back without spawning the panel, and `warn` only annotates. See [docs/VERIFIERS.md](docs/VERIFIERS.md).
- 🙋 **Humans at the right moments.** Spec approval, split proposals (one issue is one PR unless you approve a split), questions, escalations, infra runbooks, merge conflicts, budget overruns and a likely secret the scanner caught stop the job and land in the dashboard's *Needs you* popover.
- ✍️ **You're the author.** Nothing Forge produces credits an AI: no co-author trailers, no "Generated with" footers, no session links in commits, PRs, issues or comments. See [Authorship](#authorship).
- 📈 **Measured and self-improving.** Per-agent and per-job token usage with API-equivalent cost, Forge metrics comparable across repos, eval suites (including replays of your own merged PRs), and retros that propose improvements as reviewed PRs, each logged as an experiment with a baseline.

## Install

In Claude Code:
```
/plugin marketplace add maxwellmattryan/forge
/plugin install forge@forge
```
Requirements: Node ≥ 22.18, git ≥ 2.38, and the GitHub CLI (`gh` ≥ 2.40) for PR and GitHub-tracker features. Supported platforms: [docs/SUPPORT.md](docs/SUPPORT.md).
On Node older than 22.18 the CLI fails at import and the attribution hook cannot load: it exits 1, which Claude Code does not treat as a block, so `aiAttribution: forbid` is not enforced.

The CLI also works on its own (for other agent runtimes, scripts or CI):
```bash
git clone https://github.com/maxwellmattryan/forge && cd forge && npm link
forge help
```
Forge's engine is TypeScript that Node runs directly, and Node does not strip types under `node_modules`, so install from a clone, not as a global npm package.

### Updating

Run `forge update` in a terminal or `/forge update` in Claude Code. It updates the install that is running. For a plugin install it runs `claude plugin marketplace update <marketplace>` and then `claude plugin update forge@<marketplace>`. For a clone it runs `git pull --ff-only`, and refuses when the checkout has uncommitted changes, a detached HEAD or no upstream. It prints the old and new versions, restarts the current repo's running dashboard on the new code, and lists what still needs a restart: a new Claude Code session for a plugin install, and dashboards in other repos. `forge update --check` only shows what it would run. `--keep-dash` leaves this repo's dashboard alone. A plugin install or a clone of `main` builds and installs nothing, because Forge has no runtime dependencies and every commit on `main` carries the built `dashboard/dist/`, which CI adds in the main-update PR. A clone of `develop` has no built dashboard: run `npm ci` and `npm run build:dashboard` after each update (`forge doctor` warns until you do).

Each release is a `v<x.y.z>` tag and a GitHub Release with its CHANGELOG notes and a source archive plus its `.sha256`. `forge version --json` prints the running version and commit. To pin a version, clone its tag (`git clone --branch v<x.y.z>`) or extract its archive and load it with `claude --plugin-dir`; to roll back, check out an older tag. [docs/RELEASES.md](docs/RELEASES.md) has the versioning and support policy and the details.

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
| `/forge next [n]` · `/forge issue <ref>` | take work: `next` first resumes a queued job nobody drives, else triages and starts the next ready tracker item |
| `/forge triage [n]` | readiness triage: mark ready items that lack an outcome, acceptance criteria, a bounded scope or are duplicates as needs-info, with one templated comment, so `next` skips them ([details](docs/TRACKERS.md#readiness-triage)) |
| `/forge continue <job \| #pr \| ref> [note]` | resume a job or PR: sync, integrate, address review feedback or CI |
| `/forge approve <job>` · `revise <job> <note>` · `answer <job> <text>` · `rework <job> <note>` · `cancel <job>` | human decisions |
| `/forge status` · `sync` · `dash` · `doctor` · `requests` · `update` | operate |
| `/forge retro` · `/forge eval …` | improve and measure |

The `forge` CLI underneath is also for scripts, CI and other agent runtimes: `forge help <command>` prints a command's flags and exit codes, `--mode human|agent` (or `FORGE_MODE`) picks text for a terminal or JSON for a program, and inside Claude Code it is always agent. [docs/CLI.md](docs/CLI.md) covers `--json`, the output mode, exit and error codes, environment variables and what stays stable. The commands worth knowing by hand:

<!-- forge:commands:start (generated from lib/commands/*.ts by npm run docs:commands; edit those tables) -->
| Command | What it does |
|---|---|
| `forge job link <id> <ref>…\|--remove <ref>\|--create\|--none [--reason R]\|--suggest` | add issues to a job (this repo's are checked and claimed, other repos' only recorded), remove them, create one, or record that it needs none (see [Linking jobs to issues](docs/TRACKERS.md#linking-jobs-to-issues)) |
| `forge job effort <id> low\|medium\|high\|xhigh\|max \| --inherit` | set a job's reasoning effort (forge job new --effort sets it at creation), or clear it so the job inherits runtime.effort; daemon sessions start with --effort and every agent gets it (see [Effort](docs/CONFIG.md#effort)) |
| `forge job repo add <id> <name> [--verify-only] \| remove <id> <name> \| propose <id> <name> --reason R \| downstream <id> \| interim <id> (<name> \| --root) canary\|git-ref\|local\|sequential\|inherit` | add a member repo (a config repos entry whose clone passes doctor's check) to a job, which then gets its own worktree, verify evidence and PR on the job's branch; remove drops one that has no PR and no worktree left; interim sets one job repo's interim strategy as a dependency (what a consumer's PR points at while it is unmerged: docs/CONFIG.md "Interim strategies"), overriding release.interim, and inherit clears it (add, remove and interim are human-only). propose records an agent's proposal of a repos entry with its reason in repo-proposals.md; the job then waits until a human, or the foreman when allowed, runs forge job human <id> approve-repos\|reject-repos (approving a verify-only member promotes it to an edited one). downstream adds the changed repos' linked consumers as verify-only repos, so verify runs their tests against the job's changes, and prints what it added and skipped with each reason (docs/CONFIG.md "Downstream verification"); it takes no repo name, and the job's own session may run it (see [Job repos](docs/ARCHITECTURE.md#job-repos)) |
| `forge job interim <id> \| publish <id> (<name> \| --root) [--confirm] \| release <id> (<name> \| --root) <version>` | each dependency edge between the job's repos: its interim strategy (job or config), links, state (held, waiting, ready, blocked, stale or released) and why, with no network call, plus each edge's release gate (ci, held, bump-due or released). publish publishes a dependency repo's canary: each npm link's package, exported from the verified commit's git objects, as <version>-canary.<sha12> under the canary dist-tag; without --confirm it only lists what it would publish, and --confirm needs a terminal on stdin. publish and forge release run are the only commands that publish anything. release records that the dependency of an edge of any strategy was released as <version>, after its PR merged (result: recorded, clear, bump, resumed): forge verify then bumps each unmerged consumer's manifests (and a tracked lockfile) to it, after which the consumer's PR may leave draft (forge pr ready) and merge; a job waiting on pr-review at stage pr resumes. publish and release are human-only (see [Interim strategies](docs/CONFIG.md#interim-strategies)) |
| `forge job audit <id> [--json\|--csv]` | the job's audit trail: who did each human action (best effort, unauthenticated), its gate transitions, and its PR opening and merge, in time order (see [Audit trail](docs/ARCHITECTURE.md#audit-trail)) |
| `forge job archive <id>\|--done --older-than D` | archive a finished job into .forge/archive/<id>.json (its job.json, events and a summary) and delete its job folder; with --done --older-than D, every finished job at least D days old. Stats, audit and retro still read archived jobs (see [Retention](docs/ARCHITECTURE.md#retention)) |
| `forge job delete <id> [--force]` | delete a job started by mistake, for good: releases its tracker claim, removes its worktrees, per-job backing services and the branch Forge named for it, rejects its open requests and deletes its job folder and session logs, keeping no archive record. A job with a PR, split children or an active dependent is refused: cancel and archive real work instead (see [Deleting a job](docs/ARCHITECTURE.md#deleting-a-job)) |
| `forge job prune --older-than D [--dry-run]` | archive every eligible finished job at least D days old and delete stale daemon session logs; --dry-run lists what it would free and writes nothing (see [Retention](docs/ARCHITECTURE.md#retention)) |
| `forge job links <id>` | the job's local links (config dependsOn links), active or not, with the dependency dir or the reason (see [Local links](docs/CONFIG.md#local-links)) |
| `forge job step <id> [--session S]` | the job's next action (`spawn` with a ready agent brief, `run`, `wait`, `procedure` or `done`); read-only, the same state always gives the same answer, except that `--session <owner>` refreshes that session's claim heartbeat |
| `forge job advance <id> --session S [--max N]` | runs step's `run` actions in-process (at most N, default 20) and returns the next `spawn`, `wait`, `procedure` or `done` with `ran`, one line per command it ran; refuses (exit 3) a job session S does not hold, and stops at the first failed command (exit 1) |
| `forge backing up <id>` | bring the job's per-job and the project's shared services up, idempotently: run a missing container, start a stopped one, leave a running one; then give the job its job database on each shared entry with database (cloned from the template database, built in the job's worktree when missing); the result lists each service's action and database, never a password (see [Backing services](docs/CONFIG.md#backing-services)) |
| `forge backing down <id> \| --shared` | remove the job's per-job containers and volumes (only those labelled with this checkout and job), drop its job databases and role, and delete backing.json and backing-db.json, for any job, done or cancelled too; --shared removes this checkout's shared containers and keeps their volumes and ports (see [Backing services](docs/CONFIG.md#backing-services)) |
| `forge backing status [<id>]` | with a job: each service's container, state (unknown when Docker is unreachable), ports, job database (name and template) and the FORGE_BACKING_* names its commands see (never values); without: every container labelled with this checkout, with orphan: true for a per-job one whose job is unknown, done or cancelled (see [Backing services](docs/CONFIG.md#backing-services)) |
| `forge focus [<id>] [--clear]` | print the focused job ({focus: {id, title, since} \| null}), focus an active job, or clear focus; a pointer in .forge/runtime/focus.json that a job lets go of when it finishes. Moving it undoes the previous job's configured checkout steps and runs the new job's; a failing step rolls back and keeps the previous focus |
| `forge verifiers list` | the main checkout's .forge/verifiers/*.md that will run, and the problems that keep the others from running (see [Verifiers](docs/VERIFIERS.md)) |
| `forge verifiers run <id>` | select the verifiers whose paths match the diff of the commit the round's passing verify checked, and write the verifier agent's input; with none selected, write the PASS report straight away |
| `forge verifiers record <id>` | turn the verifier agent's answers into verify/round-<n>-verifiers.md; a block-mode NO (or no valid answer) whose severity is in review.blockOn fails the round's verify |
| `forge secrets scan [<id> \| --paths <globs>]` | report likely credentials, masked with their fingerprints: a job's commits, commit messages, net diff, staged changes and PR title and body, or the main checkout's tracked files matching the globs; prints text (--json for the full result) |
| `forge git add <id> [--repo NAME] -- <path>...` | stage paths in the job's worktree, from any cwd; refuses git options, paths outside the worktree and a protected path the policy refuses; prints protected: <n> when the branch changes escalate paths |
| `forge git commit <id> [--repo NAME] (--message T \| --message-file F) [-- <path>...]` | commit in the job's worktree, on its branch, from any cwd (how agents commit, in a daemon session too); refuses git options, paths outside the worktree, AI attribution, a protected path the policy refuses and a likely secret (in the message always; in the staged changes under verifySecrets: block); prints protected: <n> when the branch changes escalate paths |
| `forge release plan [--job ID \| --since TAG] [--force]` | plan a release from each repo's release strategy, dependencies first: write .forge/runtime/release/release.md (steps, checks and rollback) and release.json; nothing runs. With --job, the job's PRs must be merged, except a consumer of an interim edge, which is skipped (it merges after its dependencies' release); the plan logs release-planned and, when the Foreman decides the release gate class, queues its gate request, and approval says who owns the publish decision (see [Releasing a project](docs/RELEASES.md#releasing-a-project)) |
| `forge release run` | run the plan step by step, checking each, with checkpoints so a second run resumes at the first step not done; a step whose check already passes is skipped, and publish steps ask on a terminal unless the repo sets release.publish: allow, and without a terminal they run only when the Foreman approved this exact plan (approvedBy: foreman). On a --job plan, each dependency repo whose last step finished in this run gets its release recorded on the job from the checks of this run (released: version, recorded, and a hint when no single version showed), which resumes the job to bump its consumers. Prints its own result (see [Releasing a project](docs/RELEASES.md#releasing-a-project)) |
| `forge release status` | the plan's progress: each step's status with the tags and versions its checks recorded, the next step, whether config or the repos have moved since planning, and the publish approval (owner, pending or approved) (see [Releasing a project](docs/RELEASES.md#releasing-a-project)) |
| `forge tracker search <query> [--limit N] [--job <id>]` | search the tracker (see [Linking jobs to issues](docs/TRACKERS.md#linking-jobs-to-issues)) |
| `forge tracker triage [--limit N] [--all] \| --apply <batch>` | readiness triage: write a batch of ready and needs-info items for the forge:triage agent, then apply its verdicts (a templated comment and the needs-info mark, or the mark cleared) (see [Readiness triage](docs/TRACKERS.md#readiness-triage)) |
| `forge budget` | repo spend this UTC day and month against budget.usdPerDay, usdPerMonth and tokensPerMonth: caps, remaining, projected month-end and held jobs; frees repo-held jobs once nothing is exceeded (see [Repo budget](docs/CONFIG.md#repo-budget)) |
| `forge audit --since <date> [--until <date>] [--json\|--csv]` | every job's audit rows (forge job audit) and the repo-level ones such as config set (job null), with since <= ts < until, sorted by time then job; dates are YYYY-MM-DD (UTC midnight) or full ISO timestamps, and until defaults to now (see [Audit trail](docs/ARCHITECTURE.md#audit-trail)) |
| `forge daemon status` | the daemon's sessions, from the terminal |
| `forge daemon log <job>\|--inbox\|--office [--lines N] [--follow]` | a session's log, from the terminal |
| `forge notify test [--event <name>]` | send one sample notification (job null, title "Forge test notification") to every valid notify.webhooks entry regardless of its events, and run notify.command if set; prints {event, results: [{target, host, format, ok, status, error, attempts}]} and records nothing (see [Notifications](docs/CONFIG.md#notifications)) |
| `forge config get [<key>]` | read the effective config: one dotted key (strings raw, null when absent), or all of it (see [Changing settings](docs/CONFIG.md#changing-settings)) |
| `forge config set <key> <value>` | change one editable key in `.forge/config.yml`, keeping its comments (see [Changing settings](docs/CONFIG.md#changing-settings)) |
| `forge doctor [<job>] [--bundle] [--out <dir>] [--include-text]` | check this repo and machine for Forge (tools, config, job files, and the tool of each declared release mechanism) and print what is wrong, indented; --bundle writes a redacted support bundle for a bug report (see [Support bundle](docs/CLI.md#support-bundle)) |
| `forge update [--check] [--keep-dash]` | update this Forge install (plugin or clone) and restart this repo's dashboard on the new code (see [Updating](README.md#updating)) |
<!-- forge:commands:end -->

## How it works

- **The orchestrator** (the `forge` skill) runs a short loop: `forge job advance <id> --session <its session>` (which keeps its claim alive) runs the bookkeeping commands step builds itself and returns the next action that needs judgement, the orchestrator does it (spawn the named agent with the brief step rendered, or wait), records the agent with `forge job agent … end`, and advances again. `forge job step` is the read-only view of the same decision. The CLI decides each step from recorded state, the same way it is the only writer of that state, so the pipeline's rules are tested code rather than prose. The orchestrator reads JSON and one-line agent replies, never code or full reviews, so it can drive many jobs without filling its context.
- **Agents** (`agents/*.md`) each own one step and one output file: planner → `plan.md`, spec-writer → `spec.md`, designer → `design.md`/`mockup.html`, builder → commits + `tasks.md` + `build.md`, reviewer → `review/round-N/<lens>.md` (and `review/integration/code.md` after a resolved conflict, judged by `forge job verdicts --round integration`), approver → `decision.md` + `pr.md`, integrator → merge resolution, verifier → `verify/round-N-verifier-answers.md` (yes/no answers to the repo's verifiers), retro → improvement proposals, judge → eval scores, triage → readiness verdicts for tracker items, assistant → the foreman's gate decisions. They get their context from files, so any session can resume any job.
- **The CLI** (`forge`) owns the deterministic parts: state transitions, worktrees, ports, running and logging commands, the verify gate (with a test-integrity report), scope checks (files changed vs the spec's Approach), the review panel (lenses from the diff: `forge job panel` matches each lens's `paths` against the branch and records why), AC coverage (`forge job acs`: spec ACs vs the builder's proof table), finding counts (`forge job findings`: raised, fixed, disputed and recurring review findings), verdict policy, PRs, trackers, usage accounting, stats, evals and the dashboard server.
- **Committed build output merges itself.** With `worktrees.generated` set, `forge integrate` rebuilds conflicted generated files (the base side, then `worktrees.generatedBy`) instead of calling the integrator, which sees only real conflicts.
- **Merging waits for CI.** `forge pr merge` (used when `merge.auto: true`) syncs first, then merges directly only when checks pass or the repo has no CI workflows, refuses when they fail, and while checks are pending queues GitHub auto-merge only if branch protection will hold the PR and no protected-paths policy applies; otherwise it defers and the next `forge sync` retries. Refused and failed merges exit 1. A multi-repo job's PRs link each other and merge in the components' `dependsOn` order, never a PR before its dependencies, and the job is done only when every PR merged. `--now` is a human override that bypasses CI (never the merge order) and is logged as `pr-merge-bypass`; the orchestrator never uses it on its own.
- **Every job reaches build with an issue.** A job opens one PR and carries one or more issues, from this repo or others (`owner/repo#12`), and one issue may sit on several jobs. With a tracker in use, a job that didn't start from an issue gets one at spec approval: the same answer that approves the spec links one of the candidates Forge found, approves a new issue, or records that it needs none. A spec approved without one, or a job with no spec gate (`specApproval: never`), waits for that choice before build (see [Linking jobs to issues](docs/TRACKERS.md#linking-jobs-to-issues)).
- **Agents propose repos; a person adds them.** In a multi-repo project the planner and spec-writer see the project graph, and when the work needs a change in a member repo the job lacks (say, a library's API the app uses) they propose it with a reason (`forge job repo propose`). The job waits until a human approves or rejects it in the dashboard or their own terminal (`forge job human <id> approve-repos|reject-repos`), or the foreman does when `repo-proposal` is in `foreman.decides`; approving gives the repo its own worktree, branch and PR, and rejecting re-runs the agent within the job's repos.
- **State** lives in `.forge/jobs/<id>/` (gitignored) in the main checkout, shared by every worktree and session: `job.json`, an append-only `events.jsonl`, and the agents' markdown files.
- **Every human action says who.** Approvals, budget acks, links, forced claims, `--now` merges, config changes and dashboard permission answers record a best-effort, unauthenticated `actor` (`FORGE_ACTOR`, else `gh`, `git` or the OS user); `forge job audit <id>` and `forge audit --since <date>` export the trail as JSON or CSV (see [Audit trail](docs/ARCHITECTURE.md#audit-trail)).

Read more: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/GLOSSARY.md](docs/GLOSSARY.md) (the words Forge uses) · [docs/CLI.md](docs/CLI.md) (the CLI's contract: `--json`, exit codes, environment variables) · [docs/CONFIG.md](docs/CONFIG.md) · [docs/TRACKERS.md](docs/TRACKERS.md) · [docs/VERIFIERS.md](docs/VERIFIERS.md) · [docs/IMPROVEMENT.md](docs/IMPROVEMENT.md) · [docs/PROTOCOL.md](docs/PROTOCOL.md) (running Forge on other agent runtimes)

## Dashboard

`forge dash` serves a single-page dashboard bound to localhost, drawn as a smithy at night: gunmetal plates cut at two corners, one silver-blue gleam where agents are at work, and one warm ember for what waits on you (the Forge theme here; Ash is the daylight one):

![The Pipeline board in the Forge theme: jobs across the Queued, Plan, Build and Ship columns, one outlined in ember with a YOU chip because it waits on a person, and the status bar with its facts strip along the bottom](assets/screenshots/pipeline.png)

![A job's drawer open on its Thread in the Forge theme: the compact header with its stage and YOU chips, the Thread, Log, Files, Timeline and Details tabs, the job's request, and the dock with the gate's actions](assets/screenshots/job-drawer.png)

![Settings › General in the Forge theme: the Theme segments (Forge, Ash, Temper, System), the Grain checkbox, the language and the settings shortcut](assets/screenshots/settings-appearance.png)

- **Sidebar**: the views in the order you use them, Pipeline, Project, Backlog, Agents, Analytics and Evals (the phone strip lists them the same way). At md and up, drag its right edge to resize it between 184 and 360px, or focus the edge and use the arrow keys (Shift for bigger steps, Home for the rail, End for the widest, Enter to switch between the rail and your last width); a double-click restores the default. Dragging or stepping below the narrowest width collapses it to a 64px icon-only rail: the mark, a command button that opens the palette (Cmd-K or Ctrl-K then opens it at once), the view icons with Pipeline's count in the corner, and the gear. Each rail control shows its name in a tooltip on hover or keyboard focus. The width and the rail are kept in this browser, and the job panel and the status bar follow the sidebar's edge.
- **Status bar**: one slim row fixed at the bottom of every view. On the left, **Needs you** first (an icon-only bell with the **Notifications** tooltip and a count of the decisions and permission prompts waiting on you), then the **Foreman** and the **Daemon**, a pair in the same accent, each with its glyph and a dashed look while it is off: the Foreman is always shown as the supervisor above the pool (on, with a live dot while the office session works and a count of its permission prompts, or **Foreman off**), and the Daemon shows a `Daemon live/cap` count with a live dot while a session works (its state is in the tooltip); in the middle, **FOCUS** and the focused job's id while a job is focused, which opens that job's panel (the bar shows no version, API, sessions, view or spend); on the right, the model the builder runs on and whether the dashboard is connected to `forge dash`. Each indicator opens a popover with its details and controls: the Foreman's live thread at chat size under **Foreman** (its permission prompts, then the office session log with its status, model, effort, Permissions, a Start/Stop toggle, filters and subagents; while it is off, how to turn it on in `.forge/config.yml`); a Foreman row that opens that popover, then a Start/Stop toggle, one row per session (the inbox session, then each job, which opens that job's log) and the inbox session's live log (the **Inbox session log** toggle) under **Daemon**; the permission prompts, then the decisions, PRs, parks and queued requests under **Needs you**; every role's and review lens's model under **Models** (read-only: change them in Settings › Agents); the API versions and **Retry now** under **Connection**. Escape, the close button or a click outside closes a popover.
- **Command bar** (Cmd-K or Ctrl-K focuses the sidebar's **New job or command** input at md and up, and a second press opens the palette; typing or pasting there opens it with your text; on a phone, the command button in the top strip): type a request in plain words to start a job (its title is derived from the text, or give one), or a command with completion: `next [n]`, `sync`, `retro`, `continue <job> [note]` (or `resume`), `approve|revise|rework|answer|cancel <job> [note]`, `issue <ref>`. A new job's card appears at once and its job panel opens on the Thread. A job's panel has **Command for this job**, which opens the bar scoped to that job: a *For <job>* chip, and that job's applicable commands listed first (Backspace in the empty input or the chip's remove button drops the scope; free text still starts a new job). The bar's backdrop is a light scrim, so the page or job panel behind it stays readable.
- **Job panel**: opening a job (a card, a row, a chip, the palette or a popover) slides its panel in from the right over the page, which a backdrop dims along with the sidebar and the status bar; the panel runs the full height of the window. A click on the backdrop, Escape or its close button closes it. Drag the panel's left edge (or focus it and use the arrow keys, Shift for bigger steps, Home and End) to resize it, never over the sidebar; one width is kept in this browser for every job, and a double-click restores the default. On a phone the panel is full width. Its Thread and Log tint each message by its sender: Claude cool, the CLI and the supervisor neutral, Forge warm. For an active job its Details tab opens with **Environment**: **Focus** or **Unfocus** (the same pointer as `forge focus`: it starts and stops no server, and runs the configured `checkout` steps, docs/CONFIG.md "Checkout steps"; a failing step shows its error and keeps the previous focus), its endpoints (one per service or app component, with an **Open** link, and one per managed backing service) with a live dot on the dev server's, **Open in editor** (the worktree in `$FORGE_EDITOR`, default `code`, on the machine running `forge dash`) and **Run** (starts the job's `commands.dev` once on its port and reuses it after; no other job's server is touched).
- **Needs you** (the bell in the status bar): every human gate (including **Human check**, a CLI check such as the secret scan that only a human can clear), with its document and one-click actions (for an issue to link, and on the spec approval of a job without one: the candidates Forge found, another ref, a new issue, or none; for an agent's repo proposal: each proposed repo with its reason, and **Approve repos** or **Reject repos**). Jobs parked on unfinished dependencies are not gates: they are listed apart, with **Unblocked, resume**, and are neither marked as waiting on you nor counted in the badge. PRs awaiting review and queued requests are listed there too. An old `#/inbox` link opens the Pipeline with this popover.
- **Project**: the configured `components` drawn as a graph, grouped by repo, with their backing services and their build (solid) and runtime (dashed) dependencies, plus the same as a table. Pick a job under **Highlight a job** to light the components it names and dim all but what depends on them downstream. Read-only.
- **Backlog**: your tracker's ready items, with their readiness from triage (Needs info and what is missing, or Ready); start one with a click.
- **Agents**: running agents, orchestrator sessions, and the roster with models and prompt hashes.
- **Analytics**: Forge metrics plus token and cost breakdowns by role and model.
- **Evals**: runs, side-by-side comparisons, and a Run eval button.
- **Settings** (the gear, or ⌘, on a Mac and Ctrl+, elsewhere, even from a text field): **General** holds this browser's preferences, never stored in `config.yml`: Theme (**Forge**, **Ash**, **Temper** (dark, in the heat colours of tempered steel), or **System**: Ash on a light OS, Forge on a dark one, live, and never Temper; a theme saved by an earlier version still loads, the dark ones as Forge and the light ones as Ash), **Grain** (the film grain on the ground and the plates; the dark corners stay), plus language. The dashboard also honours your OS's reduced-motion setting: nothing slides or fades, the live dot's halo does not pulse, and a running step's ring stays still. The rest of Settings is the editable `.forge/config.yml` keys as forms saved through `forge config set`'s write path, `forge doctor` diagnostics with a copyable report and a redacted support bundle to download for a bug report, and the versions Forge is running. Settings are locked while the daemon runs, because any change to `config.yml` stops it.

In a terminal, a foreground `forge dash` follows its banner line with an **activity log**, one timestamped line per thing that happens: `[12:04:31] session _inbox spawned (pid 4242)`, `[12:04:33] http GET /api/nope 404 3ms`, `[12:04:40] job 12-demo builder started`. Its three kinds are `session` (spawns, ends, busy and idle, holds, waits for a slot, errors, stderr and permission prompts), `http` (requests, without their query string; page loads, assets, the `/api/state` poll and event streams only when they fail) and `job` (events appended to a job's `events.jsonl`, never the history). `--quiet` turns it off, and agent mode (`--json`, `FORGE_MODE=agent` or a stdout that is not a terminal) prints only the banner ([Output mode](docs/CLI.md#output-mode)).

The dashboard is a Svelte 5 + TypeScript single-page app. Its built output (`dashboard/dist/`) is committed only on `main`: CI builds it on every push to `develop` and adds it in the main-update PR into `main`, so installing the plugin builds and installs nothing. On `develop`, the working branch, `dist/` is gitignored: build it with `npm run build:dashboard`.

Each running agent shows on its job's card, in the drawer header and on the Agents page as one live line: its role, model, how long it has run and the last thing its Claude Code transcript shows (a tool call or a line of text), beside the owning session's liveness. The drawer's **Agents** tab lists the round's agents with their status, duration and tokens, and follows the chosen one's transcript live; a job driven from an interactive session (not the daemon) shows that session's transcript, read-only, in its Log tab. Transcripts are read from `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`, and only for this repo's own sessions.

Buttons don't run agents directly. They queue requests, and an orchestrator session drains them: your own (`/forge requests`), so permissions and spend stay with you, or, with `daemon.enabled: true`, a headless Claude Code session that `forge dash` supervises and nudges whenever new requests arrive. With the daemon, each job gets its own headless session (up to `daemon.maxConcurrent` at once), and a small inbox session takes requests that have no job yet, so one job's crash never stalls another and each job has a log of its own. The daemon spends tokens unattended, limited to the tools in `daemon.allowedTools`. When an agent needs anything else, its session pauses and the call shows in the status bar's Needs-you popover and in the job drawer's dock with Allow once, Allow for this session and Deny, so you grant it from the dashboard instead of editing config. Each session's log also has a **Permissions** button (its popover offers Ask, Auto, Refuse) that switches that one session's Claude Code permission mode, live, until `forge dash` restarts; see [Daemon](docs/CONFIG.md#daemon). A job's log also has an **Effort** button (its popover offers Inherit, Low to Max) that sets the job's reasoning effort, for its agents at once and its session from its next start, whether or not the daemon runs; a job whose effort differs from `runtime.effort` shows it as a chip on its card; see [Effort](docs/CONFIG.md#effort). When it is in use, the status bar's **Daemon** indicator summarises the pool (with `foreman.enabled`, the **Foreman** indicator before it opens the office session's live thread), and its popover holds the rest: its status, `live/cap` job sessions, a Start/Stop toggle, a row per session with its state (held on budget, waiting for a slot, kept by running agents and so on) that opens a job's log, and the inbox session's live log (the **Inbox session log** toggle, in the Daemon popover). Every pending permission prompt is answered in the **Needs you** popover. `forge daemon status` and `forge daemon log <job> --follow` show the same from a terminal.

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
2. **A hook**: while the plugin is enabled, a `PreToolUse` hook inspects every `git commit/tag/merge`, `gh pr/issue/release/api` and `glab` command (including `-F`/`--body-file` files) and blocks it if it carries an AI co-author trailer, a "Generated with …" footer, a robot-emoji signature or a session link. It runs for subagents too. Mentions such as "parse Claude Code transcripts" pass; only signatures are blocked.
3. **The CLI**: before `forge pr open` pushes, it rewrites any branch commit message that still carries attribution (content and authorship untouched), and it strips attribution from PR bodies, issues and tracker comments.

Claude Code adds its own trailer and PR footer unless told not to, and a plugin isn't allowed to change that setting for you. To turn them off everywhere (not just in Forge), add this to `~/.claude/settings.json` (Claude Code ≥ 2.1.281):
```json
{ "attribution": false }
```
Opting out: `aiAttribution: allow` in a repo's `.forge/config.yml`, or `FORGE_AI_ATTRIBUTION=allow` in the environment.

## Project

- [Security policy](SECURITY.md): report vulnerabilities privately. Fixes go to the latest minor release ([supported versions](SECURITY.md#supported-versions)).
- [Contributing](CONTRIBUTING.md): development setup and the local dev flow (`npm run dev`, `npm run dev:claude`), the verify list and pull-request conventions.
- [Code of Conduct](CODE_OF_CONDUCT.md): Contributor Covenant 2.1.

## License

MIT · Strike while the iron is hot. 🔥
