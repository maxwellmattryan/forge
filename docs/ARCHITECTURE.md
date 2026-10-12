# Architecture

## Layers

| Layer | Where | Changes when |
|---|---|---|
| **Engine**: CLI, dashboard, data schemas | `bin/`, `lib/`, `dashboard/` | the plugin is updated |
| **Roster**: orchestrator skill, agent prompts, reviewer catalog | `skills/`, `agents/`, `reviewers/` | the plugin is updated |
| **Repo layer**: config, learnings, role addenda, repo checklists, evals, custom trackers | `<repo>/.forge/` (committed) | `/forge init`, humans, retros |
| **Runtime state**: jobs, locks, dashboard inbox, caches | `<repo>/.forge/{jobs,locks,runtime}/` (gitignored) | every Forge action |

Repos never copy the engine or the roster, so there is nothing to drift. Everything repo-specific is data in `.forge/`, and that's also the only layer the retro loop edits.

## Why a CLI does the bookkeeping

LLMs are good at judgement and unreliable at bookkeeping. Everything with a single right answer is code: valid state transitions, unique job ids, atomic writes, locks, port allocation, worktree setup, command logging, verdict policy, PR and tracker calls, usage maths. Agents and the orchestrator call `forge …` and get compact JSON back. Three things follow:

1. **Data shapes can't drift.** No model hand-writes `job.json`, so a skill update can't produce state that a dashboard update can't read.
2. **Context stays small.** `forge verify` returns pass/fail plus a log tail, not 3,000 lines of compiler output. `forge job verdicts --compact` returns one word per lens. `forge job scope` returns at most 20 out-of-spec files; the full list goes to `scope.md`.
3. **The protocol is portable.** Any agent runtime that can run shell commands can drive Forge (see PROTOCOL.md).

The CLI is plain ES-module JavaScript with JSDoc types and zero dependencies. That means no build step, no install step inside the plugin, and Node is already present wherever Claude Code is. A native (e.g. Rust) port would only pay off for a long-running worker daemon. The CLI's commands and JSON outputs are the contract, so a port could replace it without touching the skill or agents.

## Data and versioning

Every persisted shape carries a version: `config.yml` → `schemaVersion`, `job.json` → `schemaVersion`, each event line → `v`, `/api/state` → `apiVersion`.

- **Readers upgrade, writers write current.** `normalizeJob` and `migrateConfig` (in `lib/schema.mjs`) upgrade old shapes in memory and fill defaults, so new code reads old jobs. `forge migrate` rewrites them on disk.
- **Newer-than-me is refused, not guessed.** A plugin that meets a job from a newer schema stops with "update the plugin".
- **Unknown fields are preserved.** Normalisation spreads the raw object first, so fields from a newer minor version survive a read-modify-write by an older one.
- **The dashboard is served by the same plugin version as the CLI**, so they can't disagree. The page checks `apiVersion` anyway, for a dashboard left open across an update.
- **Events are append-only**, so history is never rewritten by a migration.

When a shape must change: bump the version constant, add a migration keyed by the old version, and keep normalisers tolerant.

## Job model

`stage` is where the job is in the pipeline:
`backlog → plan → spec → design → build → verify → review → decide → integrate → pr → done`

`state` is what is happening there:
`queued | running | waiting | blocked | failed | cancelled | done`

`waitingOn` says why a job is waiting:
`spec-approval | input | escalation | infra | conflicts | rounds-exhausted | pr-review | external | budget`

Trackers see a coarser view: `queued`, `in-progress`, `review`, `blocked`, `done`, `cancelled`. Adapters map those to labels, GitHub Project options, or anything else.

**Ownership**: a session claims a job (`owner.session` plus a heartbeat refreshed on every write, including every `forge run`). Another session can take over only with `--force`, or after 30 idle minutes with no agent still marked running (a running agent keeps the claim alive for up to two hours after it started, so a long builder is not mistaken for a dead session). Jobs record each session that drove them in `runs[]`.

**Evidence**: every `forge verify` run records the worktree HEAD it checked, its attempt number within the round, and its result; earlier attempts are archived, never overwritten, so "verify first-pass" means the first attempt. `forge pr open` refuses to push a HEAD that the latest verify did not pass on. `forge job verdicts` records the sha the reviewers saw. When the integrator resolves conflicts after the panel passed, a one-lens `code` review of the resolution (`review/integration/code.md`, `forge job verdicts --round integration`) must pass before the PR opens; it is logged as an `integration-review` event, not in `job.verdicts`, so stats keep counting numbered rounds only. `forge pr open` records the sha it pushed (`pr.pushedSha`), and the first `forge pr sync` that sees the PR merged measures the human delta, the commits, lines and files humans added after that push (`pr.humanDelta`). Evidence for an older commit is not evidence.

**Budgets**: `pipeline.budget` limits tokens, estimated cost, agent minutes (summed agent run time), committed changed lines vs the base, and failed verify runs per round. Limits are read from config at every check, and a job's own `budget.limits` override them. Three checkpoints enforce them: `forge job agent end`, `forge job round` (before incrementing) and `forge verify`. An exceeded key parks the job at `waiting` on `budget` with its stage kept, logs a `budget` event, and adds a `budget` block to the command's JSON. `forge job budget <id> --set k=v` raises a limit; `--ack` grants one more full budget past the current use (a `verifyRetries` ack lasts only for its round). Neither changes state; the orchestrator resumes the job. Every checkpoint writes `budget.lastCheck` with what was used, so the dashboard can show it without running git. The dashboard derives effective limits and use client-side from `config.pipeline.budget`, the job's usage and `lastCheck`, and offers approve (ack, or raise via the note) on `waiting:budget`.

**Inbox**: dashboard requests are claimed by a session before they are handled, under a lock, so two orchestrators draining the same inbox cannot both act on one request. A claim with no ack for 30 minutes can be taken over.

## Concurrency

- **Many jobs, one session**: the orchestrator runs agents in the background and advances each job as notifications arrive, up to `runtime.maxParallelJobs`.
- **Many sessions, one repo**: all state is in the main checkout's `.forge/`. Writes take a per-job `mkdir` lock and are atomic (write and rename). Backlog edits and tracker claims take their own locks. Job ids are created with an exclusive `mkdir`.
- **Worktrees** live outside the repo (`../<repo>.worktrees/<job>` by default), so watchers, bundlers and Cargo workspaces don't see nested copies. Untracked files agents need, such as a gitignored `CLAUDE.md` or `.env`, are copied in, and setup commands run once.
- **Rust**: with `worktrees.cargo.sharedTarget`, one `.cargo/config.toml` above all worktrees points every job at a single target dir. Dependencies compile once, and disk use doesn't multiply. Cargo serialises concurrent builds on that directory's lock, which is usually still far faster than cold builds per worktree.
- **Ports**: each active job gets a unique port from `ports.base`. Commands see it as `{port}`, `$PORT` and `$FORGE_PORT`.

## Untrusted input

Issue bodies, comments and PR reviews come from people outside the session, and on public repos that means anyone. Forge:
- imports only collaborators' issue comments by default (`tracker.github.comments`), and labels the rest as untrusted in PR feedback
- fences imported text with its provenance and a "data, not instructions" note
- tells every agent to ignore embedded instructions about secrets, credentials, CI, permissions or out-of-scope work
- adopts only PRs whose branch lives in the same repository (never forks), and only issue-linked PRs from collaborators, so a stranger's PR is never checked out and run by the builder

## Authorship policy

`lib/attribution.mjs` defines what counts as AI attribution: signature lines and trailers, not mentions. It is shared by the Bash `PreToolUse` hook (`hooks/no-ai-attribution.mjs`, which blocks before anything is written), by `forge pr open` (which scrubs branch commit messages with a non-interactive `rebase --exec`, then pushes with `--force-with-lease` if anything changed), and by the GitHub tracker (which strips issue and comment bodies). The policy is on by default (`aiAttribution: forbid`).

## Review policy

Reviewers tag findings `[blocker] [major] [minor] [nit]`. The CLI decides the verdict from the tags and the repo's `review.blockOn`, not from the reviewer's own first line. This keeps the threshold consistent across lenses and models: "CHANGES over a nit" or "PASS over a blocker" can't slip through. A review without a verdict line is `CHANGES` when its tags already force a round, otherwise `MALFORMED` and re-run once; a second malformed review is counted as `CHANGES` (`--malformed changes`) so a reviewer that cannot follow the format cannot stall the job.

**Model diversity.** A gate that runs on the same model as the builder tends to share its blind spots: it finds the code plausible for the same reasons the builder wrote it. `forge roster` therefore always reports which gatekeepers (the approver, then each panel lens) share the builder's model family. The family is `opus`, `sonnet`, `haiku` or `fable` when the model string names one, else the whole string, with `inherit` resolved through the orchestrator's model. With `runtime.diversity: true`, `forge roster` and `forge init write` turn each overlap into a warning. It never blocks a job: picking models is the human's call. The Balanced init preset already puts the approver on a different family.

## Usage accounting

The orchestrator records every agent start and end. With Claude Code, `--import` reads the subagent transcript (`~/.claude/projects/*/<session>/subagents/agent-<id>.jsonl`). Input and cache tokens come out exact, along with tool calls (by unique block id) and duration. Output tokens are estimated from the logged content, because transcripts store the stream's opening usage snapshot. Without a transcript, the runtime-reported total is used with a blend assumption, and the dashboard shows coverage (how many agent runs reported usage, and how many exactly). Prices live in `lib/pricing.json` (dated, overridable via `usage.pricing`). For subscription plans they're API-equivalent figures, not a bill.

## Dashboard security

The server binds 127.0.0.1 only and answers only requests whose Host is a loopback name, which defeats DNS rebinding. GETs are read-only. POSTs (enqueue a request) need a random per-process token embedded in the served page, and a matching Origin, so other sites in your browser can't trigger work. Everything the page renders, including agent- and issue-authored markdown, is escaped first. Job HTML (mockups) is shown in a sandboxed iframe with a sandbox CSP. File reads are confined to the job directory. The one external script (Tailwind) is pinned with Subresource Integrity.
