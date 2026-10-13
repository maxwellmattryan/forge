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

**Evidence**: every `forge verify` run records the worktree HEAD it checked, its attempt number within the round, and its result; earlier attempts are archived, never overwritten, so "verify first-pass" means the first attempt. `forge pr open` refuses to push a HEAD that the latest verify did not pass on. `forge job verdicts` records the sha the reviewers saw. When the integrator resolves conflicts after the panel passed, a one-lens `code` review of the resolution (`review/integration/code.md`, `forge job verdicts --round integration`) must pass before the PR opens; it is logged as an `integration-review` event, not in `job.verdicts`, so stats keep counting numbered rounds only. `forge pr open` records the sha it pushed (`pr.pushedSha`), and the first `forge pr sync` that sees the PR merged measures the human delta, the commits, lines and files humans added after that push (`pr.humanDelta`). Each verify also writes a test-integrity report (deleted or renamed tests, added skip/focus markers, the test-count delta, test and CI config edits since the merge-base), which reviewers and the approver read and `verifyIntegrity: block` turns into a failure. Evidence for an older commit is not evidence.

**Budgets**: `pipeline.budget` limits tokens, estimated cost, agent minutes (summed agent run time), committed changed lines vs the base, and failed verify runs per round. Limits are read from config at every check, and a job's own `budget.limits` override them. Three checkpoints enforce them: `forge job agent end`, `forge job round` (before incrementing) and `forge verify`. An exceeded key parks the job at `waiting` on `budget` with its stage kept, logs a `budget` event, and adds a `budget` block to the command's JSON. `forge job budget <id> --set k=v` raises a limit; `--ack` grants one more full budget past the current use (a `verifyRetries` ack lasts only for its round). Neither changes state; the orchestrator resumes the job. Every checkpoint writes `budget.lastCheck` with what was used, so the dashboard can show it without running git. The dashboard derives effective limits and use client-side from `config.pipeline.budget`, the job's usage and `lastCheck`, and offers approve (ack, or raise via the note) on `waiting:budget`.

**Dependencies**: `dependsOn` lists job ids, set with `forge job set <id> --field 'dependsOn=[…]'`, which rejects unknown ids, the job itself and cycles. A dependency counts only when its job is `done`; `cancelled` or missing ones block until a human removes them. A queued job with unmet dependencies is parked at `waiting` on `external` with a `dependencies not done: …` reason (other waits are never overwritten), `forge next` skips it, and `forge job claim` refuses it with exit code 4 unless `--force`. `forge sync` releases a parked job to `queued` once its dependencies are done. A new branch for a job with exactly one unmerged dependency starts from that dependency's branch, and `job.base` becomes that branch, so the PR, `forge integrate` and reviewers' diffs are against it (a `stacked` event). Once the dependency merges, `forge sync` moves the base back to the dependency's own base (retargeting an open PR with `gh pr edit --base`) and logs `retargeted`. More than one unmerged dependency is refused.

**Inbox**: dashboard requests are claimed by a session before they are handled, under a lock, so two orchestrators draining the same inbox cannot both act on one request. A claim with no ack for 30 minutes can be taken over. The drainer is either your own session (`/forge requests`) or, with `daemon.enabled`, the headless session `forge dash` supervises (see "Daemon"); both go through the same claims, so they can run side by side.

## Concurrency

- **Many jobs, one session**: the orchestrator runs agents in the background and advances each job as notifications arrive, up to `runtime.maxParallelJobs`.
- **Many sessions, one repo**: all state is in the main checkout's `.forge/`. Writes take a per-job `mkdir` lock and are atomic (write and rename). Backlog edits and tracker claims take their own locks. Job ids are created with an exclusive `mkdir`.
- **Worktrees** live outside the repo (`../<repo>.worktrees/<job>` by default), so watchers, bundlers and Cargo workspaces don't see nested copies. Untracked files agents need, such as a gitignored `CLAUDE.md` or `.env`, are copied in, and setup commands run once.
- **Rust**: with `worktrees.cargo.sharedTarget`, one `.cargo/config.toml` above all worktrees points every job at a single target dir. Dependencies compile once, and disk use doesn't multiply. Cargo serialises concurrent builds on that directory's lock, which is usually still far faster than cold builds per worktree.
- **Ports**: each active job gets a unique port from `ports.base`. Commands see it as `{port}`, `$PORT` and `$FORGE_PORT`.
- **One headless session per dashboard**: with `daemon.enabled`, `forge dash` supervises one long-lived orchestrator session (`daemon.maxConcurrent` must be 1). A second `forge dash` on the same repo sees the first one's live pid in `daemon.json` and refuses to start its own.
- **Background commands** are idempotent per job and command: `forge run <id> dev --background` returns the recorded process while it is alive (`reused: true`) instead of starting another on the same port, and reports `listening` once the port answers. A per-job lock covers the check and spawn, so parallel UI reviewers share one dev server; the orchestrator starts it before them and runs `forge stop` after.

## Daemon

`lib/daemon.mjs` supervises one `claude -p --input-format stream-json --output-format stream-json` child from inside `forge dash`. It never runs agents or writes job state itself: it only decides when to send the session its one turn.

**States** (`/api/state.daemon.status`, SSE `state` events): `off` (no child), `idle` (child alive, no turn in flight), `busy` (a turn was written and no `result` has been read), `stopping` (SIGTERM sent). A turn write is the only thing that sets `busy`; a stdout line that parses as JSON with `type: "result"` is the only thing that sets `idle`. A fresh child is `idle`, because a stream-json `claude -p` does nothing until it reads a line.

**Trigger** (edge-triggered per request id). Every `pollMs` (2 s), after every `POST /api/requests` and after every `result`, a tick reads the pending requests, sets aside the budget-held ones (below), and takes the request ids not yet in `committed`. If any are left and the session is not `busy`/`stopping`, it spawns a child if there is none, writes the turn and records the eligible ids as in flight. A `result` adds them to `committed`, which each tick prunes to ids still pending. So one request causes at most one turn (a request the session leaves pending can't loop), a request that arrives mid-turn causes exactly one more turn, a child that dies mid-turn drops its in-flight ids so they retrigger, and claimed (`in-progress`) requests never count.

**Budget hold.** Limits are per job, so a hold is per request: `resume`, `rework`, `answer` and `revise-spec` requests whose job is at `waiting: budget` and still over a limit (`exceededKeys` in `lib/budget.mjs`) are never sent or committed. `approve` (the acknowledgement), `cancel` and job-less requests are never held. Once a human raises or acknowledges the budget, the next tick sends the turn. `state.held` lists the held jobs; a `held` log line is written when that set changes.

**Files** (`.forge/runtime/`, gitignored): `daemon.json` holds `{sessionId, resumable, pid, serverPid, argv0, startedAt, spawnSessionId, lastTurnAt}`. `daemon.log` gets every child stdout line verbatim, non-JSON stdout as `forge-raw`, stderr as `forge-stderr` (4 KiB per line), and the supervisor's own events as `forge-daemon` (`spawn`, `turn`, `result`, `exit`, `stop`, `idle-stop`, `resume-failed`, `session-changed`, `held`, `reaped`, `error`, `line-truncated`). A stdout line over 8 MiB is dropped and replaced by a `line-truncated` marker. The log is rotated to `daemon.log.1` at spawn once it passes 20 MiB, and the child's stdout is paused while the log stream is full. The last 200 lines stay in memory for SSE replay.

**Session and resume.** The first spawn gets a fresh `--session-id <uuid>`; once a child of that session has written a line, `resumable` is set and later spawns (a restarted `forge dash`, or new work after an idle stop) use `--resume <uuid>`, passing `--plugin-dir` again because resume does not restore it. A `system`/`init` with another `session_id` replaces the stored one (`session-changed`). A `--resume` child that exits non-zero without ever emitting `system`/`init` lost its transcript: the supervisor logs `resume-failed`, undoes whatever that child's error `result` committed, starts one fresh session and re-ticks, without counting a failure.

**Failures.** A spawn `error` (ENOENT, EACCES) stops wanting the daemon (`cannot start daemon: …`), with no retry. Unexpected exits with no `result` since spawn are counted; at 3 the daemon stops wanting itself (`daemon stopped after 3 failed starts: …`); any `result` resets the count. `idleStopMinutes` ends stdin and stops an idle child, keeping the daemon wanted.

**HTTP surface** (consumed by the dashboard). `/api/state` has `config.daemon: {enabled}` and a top-level `daemon: {enabled, wanted, running, status, sessionId, pid, lastTurnAt, lastResultAt, turns, held, lastError, clients}`. `GET /api/events` streams `event: state` (that same object) on connect and on every change, `event: line` with `id: <seq>` per log line (lines over 64 KiB become a `forge-truncated` marker), and `: ping` every 15 s. `POST /api/daemon {"action":"start"|"stop"}` answers 200 with the state, 400 for a body that isn't JSON or an unknown action, and 409 `{error}` for `start` while `daemon.enabled` is false or the `daemon.*` config has a problem. `POST /api/requests` answers with the request plus `daemon: <wanted>`.

**Stopping and orphans.** Children are spawned `detached` with no shell, so each leads its own process group. `stop()` SIGTERMs the group and SIGKILLs it after 5 s. `forge dash` stops the daemon on SIGTERM/SIGINT before exiting, and an `exit` handler sends a synchronous SIGTERM as a last resort. `forge dash --stop` waits up to 8 s for the server, then reaps. A supervisor being created also reaps: if `daemon.json` names a live pid whose server is gone, the pid is signalled only after it is proven to be the recorded child: it is > 1 and not us or our group, it leads its own process group, `ps` reports a start time within 30 s of `startedAt`, its command line contains the recorded `claude` executable and `--session-id`/`--resume` followed by the recorded uuid. A live `serverPid` other than ours means another dashboard owns the daemon, and `start()` refuses. None of this runs on Windows.

**Recorded framing** (claude 2.1.296, headless run in a scratch repo with the default `command` and `--plugin-dir` pointing at this checkout). The only line the daemon writes, `TURN_LINE`:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"/forge requests"}]}}
```
followed by `\n`. Observed on stdout, one JSON object per line:
- `system`: `hook_started`, `hook_progress`, `hook_response`, `commands_changed`, `init` (at the start of every turn, carrying `session_id`, `agents` with the `forge:*` roles, `slash_commands` with `forge:forge`, `plugins` with this checkout as `forge@inline`, and `permissionMode: "dontAsk"`), `task_started` / `task_updated` / `task_notification` around a subagent, `thinking_tokens`.
- `assistant`: content blocks `thinking`, `text`, `tool_use` (an `Agent` call with `subagent_type: "forge:builder"` ran the plugin's builder and returned a `tool_result`).
- `user`: `tool_result` blocks; a subagent's own messages carry `parent_tool_use_id`.
- `rate_limit_event`.
- `result`: one per turn (`subtype: "success"`, `is_error: false`, `num_turns`, `result`, `session_id`), the same `session_id` across turns of one process.

`/forge requests` is expanded headless as the plugin's skill: the session ran the skill's opening `forge doctor`, `forge sync`, `forge requests`. A second stdin turn in the same process produced a second `result` with the same `session_id`; closing stdin made the process exit 0; a new process with `--resume <id> --plugin-dir <checkout>` accepted a turn and remembered the first process's conversation. `--resume` of an unknown id prints one `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,…}` line, `No conversation found with session ID: <id>` on stderr, and exits 1.

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

The server binds 127.0.0.1 only and answers only requests whose Host is a loopback name, which defeats DNS rebinding. GETs are read-only. POSTs (enqueue a request, start or stop the daemon: `/api/requests`, `/api/daemon`) need a random per-process token embedded in the served page, a matching Origin and a JSON content type, so other sites in your browser can't trigger work. The `/api/events` stream follows the same loopback Host rule and also rejects a mismatched Origin. Everything the page renders, including agent- and issue-authored markdown, is escaped first; daemon log lines (headless session output) are summarised and escaped the same way, and the log stream is opened only while the log pane is open and the tab is visible. Job HTML (mockups) is shown in a sandboxed iframe with a sandbox CSP. File reads are confined to the job directory. Screenshot images are served only from a job's `screenshots/` dir, only as PNG/JPEG/WebP (never SVG or other active types), with `nosniff`, a `default-src 'none'` CSP, `Cross-Origin-Resource-Policy: same-origin` (so another site can't embed them, even though its `<img>` would carry a loopback Host), a 10 MiB cap, and a realpath check that keeps symlinks from escaping the job dir; the file is then checked and read through one descriptor. The one external script (Tailwind) is pinned with Subresource Integrity.

## Daemon security

The daemon runs an unattended agent with `--permission-mode dontAsk`, so its inputs are narrow on purpose:
- **One fixed stdin line.** The daemon writes only `TURN_LINE` (`/forge requests`). Request text, request and job ids, config values and HTTP bodies never reach stdin; the session reads requests through `forge requests`, where the skill treats them as the human's words about one job, never as rules.
- **argv comes from the repo's config, with no shell.** `daemon.command` is split into words and run directly, and placeholders expand to single arguments. Nothing from HTTP or requests reaches argv. A session id read back from `daemon.json` or a child's `system`/`init` must be a uuid before it can follow `--resume`, so a planted value can't become a flag.
- **Trust boundary: `.forge/config.yml` is code.** Whoever can change it can run code through the daemon, exactly as through `commands.*` (which verify runs through a shell): `daemon.command` takes any claude flag (`--plugin-dir`, `--settings`, `--mcp-config`, `--dangerously-skip-permissions`), and `daemon.enabled: true` in committed config starts an unattended, paid session on every machine that runs `forge dash`. The config is read from the main checkout only, never from a job worktree or a PR branch, but a merged change applies everywhere. Give `daemon.command`, `daemon.allowedTools` and `daemon.enabled` code-owner review, like CI config. The session itself can't use this route (next bullet). The validator's rule that the first word is a bare `claude` or an absolute path to `claude` outside the repo catches mistakes (a migrated shell template, a relative path that would run a repo file); it is not a security boundary.
- **The session can't change what Forge executes.** Its cwd is the main checkout and it has `Edit`/`Write`, so an agent misled by tracker or PR text could otherwise rewrite `commands.*` (which `forge run`/`forge verify` run through a shell) or `daemon.*` (picked up at the next spawn or resume). Three layers, innermost first:
  - *The CLI checks at the sink.* When a human starts the daemon (dashboard Start, or `forge dash` with `enabled: true`), the supervisor takes `trustDigest`: a sha256 of the checkout's realpath, `.forge/config.yml` and every file under `.forge/trackers/` (custom tracker modules `forge` imports). It hands the digest to the session as `FORGE_DAEMON_TRUST`. Under `FORGE_DAEMON=1`, every `forge` command recomputes it before reading config and refuses on a mismatch, or when the variable is missing. The check catches every route, including Bash (`git mv -f`, a redirect) and a fake checkout reached through `cd`. `forge init write` and `forge migrate` refuse outright, because they write config.yml through `forge` itself.
  - *The supervisor stops the session.* Every poll, and before any spawn, it compares the digest with the one taken at start. On a change it stops the child and stays stopped with an error in the dashboard; respawns after an idle stop or a failed resume reuse the old snapshot, so a change made during a turn is never blessed by a restart. Only a human's Start takes a new snapshot, and only when no child is running. A human editing config while the daemon runs gets the same stop, which is the price of not being able to tell the two apart.
  - *Claude Code refuses the write.* `--disallowedTools Edit(.forge/config.yml),Edit(.forge/trackers/**)` follows every `daemon.command`, whatever the template says. Edit rules cover every file-writing tool and Bash redirections. Relative paths anchor at the session's cwd (the main checkout, so job worktrees, where a self-improvement job legitimately edits Forge config, are unaffected), deny beats allow in every mode, and subagents inherit the rules. This layer does not cover programs that write files themselves (`forge`, `git`), which is why the first layer exists. `.claude/` and `.mcp.json` are already Claude Code protected paths, which `dontAsk` refuses.

  The anchor is the session's environment, which it can't change: Bash allow rules don't match a command with a leading `VAR=…` assignment (except a few known-safe variables), and `env`/`export` aren't allowed. This keeps the *repo's* trusted commands in force; it does not stop those commands from running code the job wrote, which every verify does by design (that code is reviewed after verify, not before).
- **Start and stop** need the dashboard token, a matching Origin and JSON, and `start` additionally needs `daemon.enabled: true` and no `daemon.*` validation problem. The config migration never sets `enabled`. Concurrent start/stop POSTs never leave more than one child: a start while a child exists or is stopping spawns nothing new.
- **SSE is loopback-only**, rejects a foreign Origin and any request whose `Sec-Fetch-Site` is not `same-origin`/`none`, sends no CORS headers, allows 8 streams at once (`503` beyond), ends any client more than 1 MiB behind, and recycles every stream after 5 minutes (EventSource reconnects with `Last-Event-ID`). Another site can never read the stream. In a browser that sends neither Origin nor Fetch Metadata on a no-cors GET, a cross-site page can still occupy slots until they are recycled; that costs the live log's availability, never the daemon.
- **Permissions are not a sandbox.** `dontAsk` refuses anything `allowedTools` doesn't list, but the default list is broad for an unattended session: `Bash(git:*)` reaches arbitrary execution (`git -c core.fsmonitor=…`, `git -c alias.x='!…'`), `Bash(gh:*)` reaches the network and the GitHub API (`gh api -X POST …`), and `Edit`/`Write` can reach any file outside the paths above and the protected ones (for example a `core.hooksPath` directory that git then runs). The session also reads tracker text (a `next` request pulls issues). Enable the daemon only on repos whose tracker input you trust (or with intake restricted, e.g. `tracker.github.comments: collaborators` and ready labels only maintainers set), and add repo commands to `allowedTools` deliberately.
- **Orphan reaping** signals a pid from `daemon.json` only after proving it is the recorded claude child (see "Daemon"), so a stale or planted record can't make Forge kill an unrelated process.
- **The log** (`daemon.log`) lives in gitignored `.forge/runtime/`; it holds whatever the session printed, so treat it like a transcript.
