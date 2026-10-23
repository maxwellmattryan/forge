# The forge CLI

The orchestrator, its agents, scripts, CI and other agent runtimes ([PROTOCOL.md](PROTOCOL.md)) all read and change Forge state through `forge`. This page is its contract: what it prints, how it fails, which environment variables it reads, and what stays stable across releases. `forge help` lists the commands, and `forge help <command>` gives one command's flags and exit codes.

## Output

This section and the `--json` section below describe **agent mode**, the output every program gets: a pipe, a file, `$(…)`, Claude Code's Bash tool and daemon sessions. A person at a terminal gets human mode instead (see Output mode).

- Success prints one compact JSON value and a newline on stdout. `--pretty` indents it, and `forge doctor` and `forge config show` always indent.
- A few commands print text instead: `forge status` (a table), `forge stats` (a summary), `forge secrets scan` (a report), `forge help`, and the string results of `forge worktree path`, `forge worktree prune`, `forge job get`, `forge config get` and `forge daemon log`. Under `--json` all of them print JSON (see below).
- An error prints exactly `forge: <message>` on stderr, nothing on stdout, and exits with its code from the tables below. `FORGE_DEBUG=1` adds the stack trace on stderr. Human mode prints `error:` and `fix:` lines instead.
- These commands report a failure in their own result instead of an error, and exit 1: `verify`, `run`, `integrate`, `pr merge`, `job advance`, `config validate`, `secrets scan` (a finding), `secrets check` (a secret that does not resolve) and `update`.
- `forge git diff|log|show|range-diff` pass git's stdout, stderr and exit code through once git runs.

## Output mode

Every call runs in one of two output modes. **Agent** mode is the contract on this page, byte for byte. **Human** mode renders the same results and errors as text for a person at a terminal. The mode is decided once per call, and the first rule that applies wins:

1. A bare `--json` before `--` gives agent mode, even with `--mode human`.
2. `--mode human` or `--mode agent` (also `--mode=<v>`) before `--`.
3. `FORGE_MODE=human` or `FORGE_MODE=agent`. An empty value counts as unset.
4. Human when stdout is a terminal, else agent.

A `--mode` with no value, a repeated `--mode`, or an unknown value of `--mode` or `FORGE_MODE` is a `usage` error (exit 2), even under `--json`: `forge --mode job-12` is refused, never read as help.

Human mode:

- **Strings** print raw, exactly as in agent mode: help, `stats --csv`, `worktree path`, `config get` strings. `$(forge worktree path <id>)` is the same in both modes.
- **`status` and `stats`** render structured output in human mode: `status` is the agent table with a coloured `state` and, when some job has one, a `reason` column; `stats` groups its summary under `Jobs`, `Quality`, `Speed` and `Cost`, with one reviewer and one verifier per line. Agent mode keeps the table and the summary text.
- **Commands with their own renderer**: `version`, `update`, `status`, `stats`, `doctor`, `sync`, `verify`, `requests` (`requests list`), `job list`, `job show`, `job step`, `job claim`, `job note`, `config show`, `config get`, `config validate`, `pr open`, `pr sync`, `pr merge`, `worktree create`, `worktree remove` and `backing status`. They print a headline, then bold section headings with an indented body, and mark results `✓` (ok), `✗` (failed), `!` (warning) or `-` (skipped). `job step` leaves out the brief: run it with `--json` to read it. A result shape a renderer doesn't know (`job show --full`, `doctor --bundle`, `config get` of a number) and every other command use the generic renderer.
- **Other results** go through a generic renderer, and `--pretty` has no effect. An object prints one aligned `key  value` line per key (`(empty)` for `{}`). An array of objects prints a table whose columns are the union of the rows' keys, in first-seen order. Any other array prints one item per line (`(none)` when empty). `null` prints `-`, a list of scalars is joined with `, `, and a nested object or array is shown as one-line JSON, never truncated.
- **Control characters** in rendered keys, values, cells, headlines, sections and error messages are shown as visible escapes (`\x1b`, `\u202e`), so text from trackers, PRs or job state can't move the cursor, rewrite lines or set the clipboard. Raw strings are not touched.
- **Errors** print on stderr, nothing on stdout: `error: <message>`, then `fix: <hint>` when the error has a hint (the `hint` `--json` reports). Later lines of a message or hint are indented under its text, so only the real hint starts with `fix:`. The exit code is unchanged, and `FORGE_DEBUG` still adds the stack.
- **Colour**: keys, table headers and section headings are bold, `true` green, `false` red, `error:` red and `fix:` yellow. In the commands with their own renderer, `✓` and a running state are green, `!` and a waiting or blocked state yellow, `✗` and a failed state red. Colour is on only when the stream is a terminal and `NO_COLOR` is unset or empty.
- **`forge dash` in the foreground** prints its banner line, then an **activity log**: one line per event, `[HH:MM:SS] <kind> <text>` in local time, where `<kind>` is `session` (a session spawned, ended, went busy, idle or stopping, was held, waited for a slot, failed, wrote to stderr or raised a permission prompt), `http` (`<METHOD> <path> <status> <ms>ms`, the path without its query string) or `job` (an event appended to a job's `events.jsonl`: a transition, an agent's start or end, or the event type). Successful requests for the page, `/assets/*`, `/forge.png`, the `GET /api/state` poll and every event stream are not logged; a status of 400 or more always is. Events already in a job's log when `forge dash` starts are never replayed, and assistant and tool lines from session logs never print (`forge daemon log --follow` shows them). Untrusted text is escaped like any rendered value and each line's text is capped at 300 characters; with colour on, the kind is bold, and each session scope or job id has its own colour, the same on its `session` and `job` lines: `_inbox` blue, `_office` magenta, and jobs one of four cyans, blues and magentas, taken in turn as they first appear (so it is stable for that `forge dash` run, not across restarts). Spawns and running or done states are green; holds, waits, permission prompts, `stopping` and waiting or blocked states yellow; errors, stderr and failed states red; idle, ended, pids, reasons and summaries dim. In `http` lines the method is bold and the status takes its class's colour (2xx green, 3xx cyan, 4xx yellow, 5xx red, with the path red too), and the time is dim, or yellow from 1000 ms. The timestamp is never painted, and the text without colour is the same. `--quiet` turns the log off, and `forge dash --background` starts its child with `--quiet`.
- Other streams that write for themselves are the same in both modes: `forge daemon log --follow` and the `forge git diff|log|show|range-diff` passthrough.

Agent mode is pinned wherever Forge or Claude Code start the CLI: the plugin's SessionStart hook writes `export FORGE_MODE=agent` to `CLAUDE_ENV_FILE` (every Bash command of a Claude Code session, even under a PTY), `forge dash` sets `FORGE_MODE=agent` for daemon sessions, and the test suite sets it in `test/helpers.ts`. A script that might run on a terminal should pass `--json` or set `FORGE_MODE=agent`.

## `--json`

`--json`, `--help` and `--pretty` work on every command and take no value: they never swallow the next argument, so `forge --json job list` is `forge job list --json`. `--json` selects agent mode. `--mode human|agent` works on every command too, but takes a value: it is accepted anywhere before `--` and removed before the command sees its arguments, so `forge job show --mode human <id>` shows `<id>`. Only tokens before the first `--` count; everything after it is a path.

With `--json`:

- **Success**: stdout is exactly one JSON value plus a newline. Results that are strings print JSON-encoded (`forge worktree path <id> --json` prints `"/path/to/worktree"`). `forge status --json` prints one row per job, `[]` when nothing is active, with the same `--all` filter:

  ```json
  [{"id":"add-login","stage":"build","state":"running","waitingOn":null,"round":1,"tasks":{"done":3,"total":7},"pr":null,"session":"9b2f…","foremanHandoff":null}]
  ```

  `pr` is the PR number or `null`, `session` the owner's full session id or `null`, and `foremanHandoff` the Foreman hand-off standing at the job's park or `null` (see Foreman decisions). `forge stats --json` prints the full stats object, and `forge help … --json` the help tables (see Help).
- **Errors**: stdout gets exactly one line and stderr nothing (`FORGE_DEBUG` still writes the stack to stderr):

  ```json
  {"error":{"code":"usage","message":"missing --session","exit":2,"hint":"forge help job claim"}}
  ```

  `code` is one of the error codes below, `exit` equals the process exit code, and `hint` is a command to run next or `null`: for `usage`, the help for the longest known prefix of the call (`forge job claim x --json` with no `--session` gives `forge help job claim`); for `unknown_command`, `forge help`; for `not_initialized`, `/forge init`. The message is data, so it may quote tracker or PR text; JSON encoding keeps it on the one line.
- **Streams that stay text**: `forge dash` in the foreground (its banner line only: agent mode never prints the activity log, and runs none of its hooks or polls), `forge daemon log --follow` (its lines) and `forge git diff|log|show|range-diff` (git's output). An error in any of them is still reported as the JSON error line.
- **`forge git`**: a `--json` or `--mode <v>` before `--` is Forge's flag and never reaches git, so `forge git log --json --output=x` is refused like `forge git log --output=x`. `forge git add|commit` accept it and print their result. `forge git <sub> --help` prints Forge's help and never starts git.

## `forge version --json`

`forge version` prints `{"version"}`, the running install's `package.json` version. With `--json` it prints which build that is:

```json
{"version":"0.17.1","commit":"3957e67…","installedAs":"plugin","node":"22.18.0"}
```

- `installedAs` is `plugin` (a Claude Code plugin install), `clone` (a git checkout that is its own toplevel: `npm link` or `--plugin-dir`) or `unknown` (anything else, such as an extracted release archive).
- `commit` is 40 lowercase hex characters or `null`. The first valid source wins:
  1. The `COMMIT` file at the plugin root, when it is a regular file of at most 64 bytes holding exactly one sha and an optional newline. The repo commits the placeholder `$Format:%H$`, which `git archive` replaces (`.gitattributes` `export-subst`), so release archives and GitHub's source archives carry their commit while clones and plugin caches fall through.
  2. For a plugin install, `gitCommitSha` of the matching entry (same `installPath`) in Claude Code's `installed_plugins.json`.
  3. For an install that is its own git toplevel, `git rev-parse HEAD`.
  4. Otherwise `null`.
- `node` is the Node version running the CLI.

Like `forge version`, it needs no repo and no `.forge/`. The commit is self-reported: the audit anchors are the release tag and the archive's `.sha256` ([RELEASES.md](RELEASES.md#provenance-and-pinning)).

## Exit codes

| Code | Exit | Meaning |
|---|---|---|
| ok | 0 | the command did what it was asked |
| failed | 1 | the command ran and failed, or refused by policy: verify failed, a merge refused, a field only another command sets, a path outside the worktree, no such job |
| usage | 2 | Forge could not parse the call: an unknown command or subcommand, a missing argument, a flag with no value or given twice, a value that is not a number, JSON or one of the listed words. Also a missing or unparseable `.forge/config.yml`, or not inside a git repository |
| owned | 3 | the job or request is held by another live session, or a tracker claim was lost to another job; also `stale_epoch`, a fenced write from a session that was taken over |
| blocked | 4 | the job's dependencies are not done, or the repo budget (`budget:`) holds new work: `forge job claim` parked the job, or `forge job from-ref` started nothing |
| external | 5 | a tool Forge runs failed to start, timed out or exited non-zero: git, gh, claude, docker |

The exceptions:
- `verify`, `run`, `integrate`, `pr merge`, `job advance`, `config validate`, `secrets scan` and `update` print their own result when they fail, and exit 1. `secrets scan` fails on any finding; a scan that cannot finish is an error. `secrets check` fails when any secret it checks does not resolve, and prints each one's `error` (never a value or its length); an undeclared name is a usage error (exit 2). `forge job advance` exits 3 when it refuses a job its session does not hold, and 1 when a command it ran failed, whatever that command's own exit would have been.
- `forge git diff|log|show|range-diff` exit with git's own code once git runs.
- `forge release run` prints its own result and exits 1 when it stops at a step (the result's `stopped` says why), and exits 3 (`owned`) while another `forge release run` holds the release lock.
- `forge backing up|down|stop|status` exit 5 when Docker is missing, its daemon is stopped or a docker command fails (for `up`, also a same-named container that isn't this job's); `status` without a job and `down --shared` throw `docker_missing` or `docker_stopped` for the first two, and `external` for a failed docker command. `status <job>` still exits 0, reports `unknown` for each managed service, and says why in its `docker` field (`ok`, `missing` or `stopped`; `null` when no service is managed). `forge worktree remove` exits 1 when its backing teardown fails (docs/CONFIG.md "Backing services"). With a job database, `forge backing up` also exits 5 when the server does not accept connections within 60 s, migrate or seed fails, a psql call fails, or the job has no worktree (`job <id> has no worktree: run forge worktree create <id>`); `forge backing down` and `forge worktree remove` count a stopped shared container or a failed psql call as a failed teardown and keep `backing-db.json` for a retry (docs/CONFIG.md "Job databases").
- `forge dash --permission-mode default|auto|dontAsk` sets the job sessions' default permission mode until that dashboard stops (docs/CONFIG.md "Default for job sessions"). It exits 1 inside a daemon session, which may not widen its own permissions, and exits 2 (`usage`) for any other value.
- `forge focus <id>|--clear` exits 1 when a configured checkout step fails (docs/CONFIG.md "Checkout steps"): the message names the step, why it failed and its log, and focus is unchanged.
- The no-AI-attribution hook's exit 2 belongs to Claude Code's hook protocol, not this table.

## Error codes

Every error carries one of these codes, and the code fixes the exit.

<!-- forge:errors:start (generated from ERROR_CODE_DOCS in lib/core/errors.ts by npm run docs:cli; edit that) -->
| Code | Exit | Meaning |
|---|---|---|
| `failed` | 1 | the default for exit 1: the command ran and failed, or refused by policy |
| `not_found` | 1 | no such job or request |
| `internal` | 1 | not a Forge error: a bug or an unexpected Node error (rerun with `FORGE_DEBUG=1` for the stack) |
| `secret_found` | 1 | the secret scanner found a likely credential in what Forge was about to commit or send (a commit, the PR title or body, a tracker write); the message shows it masked, with its fingerprint |
| `protected_path` | 1 | a path the `policy.protectedPaths` policy refuses is in what `forge git add\|commit` would stage or commit, `forge pr open` found a refused path or escalate paths no human approved, or `forge pr merge` found a PR head `forge pr open` never checked (docs/CONFIG.md "Protected paths") |
| `interim_stale` | 1 | `forge pr open` found a git-ref or canary pin in the checked commits that is not the dependency's checked HEAD (a hand-edited pin, or a dependency that moved without a verify), or, after a recorded release, a consumer manifest that does not name the released version yet; the hint is `forge verify <id>` (docs/CONFIG.md "Interim strategies") |
| `release_gate` | 1 | `forge pr ready` targeted a consumer PR whose local or sequential dependency's release is not recorded (a human runs `forge job interim release <id> <name>\|--root <version>`), or whose manifests don't name a recorded release yet (gate `bump-due`, or a HEAD that doesn't carry it: run `forge verify <id>`, then `forge pr open <id>`); nothing was called (docs/CONFIG.md "Interim strategies") |
| `usage` | 2 | the default for exit 2: the call could not be parsed; the hint names the help to read |
| `unknown_command` | 2 | the first word is not a command |
| `not_initialized` | 2 | the repo has no `.forge/config.yml`; run `/forge init` |
| `not_a_repo` | 2 | not inside a git repository, and `FORGE_ROOT` is unset |
| `config_invalid` | 2 | `.forge/config.yml` cannot be parsed, or `forge init write` would write an invalid one |
| `owned` | 3 | another live session holds the job or request, or a tracker claim was lost |
| `stale_epoch` | 3 | a write fenced with `--epoch N` (`forge job step\|advance\|set\|claim\|agent start\|end`) found the job's lease at another epoch, or another driver, because another session took the job over: the caller must stop driving it. The check runs under the job lock before any write, so `job.json` is unchanged |
| `blocked` | 4 | the job's dependencies are not done (`--force` claims anyway), or the repo budget holds new work (the message is the `repo budget: …` reason; a human runs `forge budget ack`) |
| `external` | 5 | git, gh, claude or docker failed to start, exited non-zero, or ran past its timeout (`gh <subcommand> timed out after <n> s`; every gh call has one, 60 s by default); also gh output that is not JSON where JSON was asked for |
| `docker_missing` | 5 | a backing command needs Docker and `docker` is not on PATH |
| `docker_stopped` | 5 | a backing command needs Docker and its daemon does not answer |
<!-- forge:errors:end -->

## Help

- `forge help`, `forge --help` and `forge` alone print the overview: one line per command group, the global flags and the exit codes.
- `forge help <group>` or `forge <group> --help` lists the group's commands, their arguments and what each does.
- `forge help <group> <sub>`, `forge <group> <sub> --help` and `forge <group> <sub> <id> --help` print one command's usage, flags and exit codes.
- Help works before `.forge/config.yml` exists and outside any git repository. A first word that is not a command exits 2 (`unknown_command`); a second word that is not a subcommand shows the group's help.
- `--json` prints the tables instead: `{"version", "groups"}` for the overview, the group for a group, and `{"command", "args", "summary", "flags", "exits", "docs"}` for a command.

The tables live beside each command module as `HELP` (`lib/cli/commands/<group>.ts`; the commands `lib/cli/main.ts` routes itself are in `lib/cli/commands/help.ts`). They also build every `usage:` error, README's CLI table and the [Command reference](#command-reference) below; `npm run docs` regenerates both.

## Environment variables

Read by Forge:

| Variable | Effect |
|---|---|
| `FORGE_ROOT` | the main checkout Forge keeps its state in; without it, the checkout of the current directory's git repository |
| `FORGE_CACHE_DIR` | where `bin/forge` keeps its start-up cache (V8 code cache, and stripped modules on Node 22); default `.cache/` in the plugin root. It must be private to the current user, and no easier to write than the plugin itself, since it holds code the CLI runs (docs/architecture/startup-cache.md) |
| `NODE_DISABLE_COMPILE_CACHE` | any non-empty value turns the start-up cache off |
| `FORGE_DEBUG` | any non-empty value prints an error's stack trace on stderr, with or without `--json` |
| `FORGE_MODE` | `human` or `agent`: the output mode when neither `--json` nor `--mode` is given (see Output mode); empty counts as unset, any other value is a usage error. The SessionStart hook and daemon sessions set it to `agent` |
| `NO_COLOR` | any non-empty value turns colour off in human mode |
| `FORGE_AI_ATTRIBUTION` | `allow` turns the no-AI-attribution policy off for the hook, `forge git commit`, `forge pr open` and the GitHub tracker |
| `FORGE_ACTOR` | the login human-action events record (`actor: { login, source: "env" }`), ahead of `gh`, `git config user.email` and the OS user; ignored inside daemon sessions, which record the dashboard's OS user. Sanitised to `[A-Za-z0-9 ._@+-]`, at most 100 characters, and unauthenticated (docs/architecture/audit-trail.md) |
| `FORGE_EDITOR` | the editor command `forge dash`'s Open in editor runs, split into words without a shell, with the job's worktree path appended; default `code`. Read from `forge dash`'s own environment |
| `GH_HOST` | a GitHub Enterprise host whose issue URLs count as the configured repo's, besides github.com |
| `SHELL` | the shell configured commands run in (`$SHELL -lc`; `/bin/sh` when unset): `forge run`, `forge verify`, worktree setup and eval checks |
| `PATH` | where git, gh, claude, node and docker are found |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `forge dash` leaves them out of daemon sessions' environment unless `daemon.auth: api-key` |
| `GIT_CONFIG_COUNT` | daemon sessions append their git pins after the entries already counted |
| `CLAUDE_CONFIG_DIR` | Claude Code's own config dir: transcripts are read from `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`, by `forge job agent … end --import` and the dashboard's agent activity and transcript views |
| `CLAUDE_ENV_FILE` | set by Claude Code for SessionStart hooks; the plugin's hook appends a line that puts this plugin's `bin/` first on PATH for the session's Bash commands, and `export FORGE_MODE=agent` so they always get agent output; nothing happens when it is unset |
| `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` | cleared before `forge git add\|commit` (with `GIT_OBJECT_DIRECTORY` and `GIT_NAMESPACE`) and eval checkouts run git, so an inherited one can't point git at another repository |

Set by the `forge dash` supervisor for daemon sessions, never by hand:

| Variable | Effect |
|---|---|
| `FORGE_DAEMON` | `1` in a headless session: the config trust check runs first, config rewrites, job effort changes (`forge job effort`, `forge job new --effort`) and setting or clearing focus (`forge focus <id>`, `forge focus --clear`) are refused, and `forge requests` sees only the session's scope |
| `FORGE_DAEMON_SCOPE` | the session's scope: `_inbox`, `_office` (the foreman), or the id of the job it drives |
| `FORGE_DAEMON_TRUST` | the digest of the checkout path, `.forge/config.yml` and `.forge/trackers/` the human started the daemon with; `forge` refuses to run when they no longer match |
| `FORGE_MODE` | `agent`, so a session's `forge` calls always print agent output (see Output mode) |

Set by Forge for configured commands (`forge run`, `forge verify`, worktree setup), which never see the daemon variables above, nor `FORGE_PORT_*`, `FORGE_ENDPOINT_*` or `FORGE_BACKING_*` inherited from an outer job:

| Variable | Effect |
|---|---|
| `FORGE_JOB` | the job id |
| `FORGE_WORKTREE` | the job's worktree |
| `FORGE_PORT`, `PORT` | the port of the component the command runs for (the job's component for a root command, else the job's `port`; a member repo's component for `--repo`), empty when there is none |
| `FORGE_PORT_<C>`, `FORGE_ENDPOINT_<C>` | per port-bearing component (prefixes `FORGE_PORT_` and `FORGE_ENDPOINT_`, `C` the name upper-cased with every character outside `A-Z 0-9` as `_`): its port and `http://localhost:<port>`, the value `{endpoint.<component>}` fills in a template (docs/CONFIG.md "Ports and endpoints") |
| `FORGE_CARGO_CONFIG` | `forge run` and `forge verify` steps only, when the repo the command runs in has an active cargo local link: the absolute path of the rendered `cargo-links.toml`, for a command that calls cargo by absolute path (see Local links) |
| `FORGE_CMAKE_ARGS` | the same, when the repo declares a cmake local link: the `-DFETCHCONTENT_SOURCE_DIR_<NAME>=<dir>` / `-U…` arguments as single-quoted shell words |
| `FORGE_BACKING_<NAME>_HOST` | per `backing:` entry (prefix `FORGE_BACKING_`, `NAME` upper-cased with `-` as `_`), when the job's services were brought up: `127.0.0.1`; not set for an external entry (docs/CONFIG.md "Backing services") |
| `FORGE_BACKING_<NAME>_PORT`, `FORGE_BACKING_<NAME>_PORT_<containerPort>` | the host port of the entry's first container port, and of each one |
| `FORGE_BACKING_<NAME>_URL` | the external entry's `url`, or the managed entry's `url` template filled with `{host}`, `{port}` and `{port_<n>}`; unset without a `url`. For a shared entry with `database`, `{user}` and `{database}` are the job database's name and `{password}` the job's generated password, and it is unset until the job's `backing-db.json` exists; while Forge builds the template database, migrate and seed see it pointing at the template as `forge_tpl` (docs/CONFIG.md "Job databases") |

Set by Forge for `notify.command` (docs/CONFIG.md "Notifications"), whose `{placeholders}` become quoted references to them; empty for a null field:

| Variable | Effect |
|---|---|
| `FORGE_NOTIFY_EVENT` | the event (`gate`, `pr-opened`, …) |
| `FORGE_NOTIFY_JOB` | the job id |
| `FORGE_NOTIFY_TITLE` | the sanitised job title (control characters replaced, at most 200 characters) |
| `FORGE_NOTIFY_URL` | the job's `https://` PR URL |
| `FORGE_NOTIFY_STAGE` | the job's stage |
| `FORGE_NOTIFY_REASON` | the fixed reason text |
| `FORGE_NOTIFY_DASHBOARD_URL` | the dashboard's pipeline page |

## Local links

`forge job links <id>` prints `{ id, links }`, one entry per `link` declared on a `components[].dependsOn[]` edge (docs/CONFIG.md "Components"): `{ consumer, consumerRepo, dependency, dependencyRepo, ecosystem, name, source, dir, active, reason }`. `consumerRepo` and `dependencyRepo` are `null` for the root repo, `source` is `null` except for cargo, `dir` is the dependency directory when the link is active, and `reason` says why it is not (`repo <r> is not on the job`, `repo <r> has no worktree yet; run: forge worktree create <id>`, `repo <r>'s stored worktree is not the path Forge computes`, `<path> does not exist in repo <r>'s worktree`). Entries are sorted by consumer repo (root first), ecosystem and name; a job with no declared links prints `links: []`. It only reads, so daemon sessions may run it.

`forge run` (with or without `--repo`) and every verify step render the links of the repo the command runs in into `<jobDir>/links/<repo or _root>/` and put its `bin/` shims first on PATH, after the login profile. The result (`forge run`'s JSON and each verify step) then gains:

| Key | When | Value |
|---|---|---|
| `links` | some link is active for that repo | the active links, `"<ecosystem>:<name>"` |
| `restored` | a tracked `Cargo.lock`, `package-lock.json` or `npm-shrinkwrap.json` changed during the command (or its verify group) | the repo-relative paths Forge wrote back; a `link-lockfiles-restored` event `{ repo, paths }` is logged |

The log file gains a `(links <bin dir>)` line after `(cwd …)`. Background commands and `worktrees.setup` get no links, and native Windows gets the env vars but no shims.

## Downstream verification

`forge job repo downstream <id>` adds the job's downstream repos (docs/CONFIG.md "Downstream verification"): the linked consumers of the repos the job changes, as verify-only members. It takes no repo name and no flag (either is a `usage` error): the candidates are computed from config, the job and its events. Each one is checked like `forge job repo add` (doctor's member check); one that fails is skipped with `repo <name>: <detail>` and the others are still added. It prints `{ id, added, skipped }`, `added` the names in `repos` order and `skipped` one `{ repo, reason }` per candidate it did not add, logs `job-repo-added` with `downstream: true` per repo and one `downstream-checked { added, skipped }` event, and exits 0 even when it adds nothing. It exits 1 for an eval job, a closed job (done, cancelled or failed) or one at stage `pr` or later, and in a daemon session whose scope is not the job (another job, the inbox or the office) or whose `FORGE_DAEMON_SCOPE` is invalid. Step rule DS1 runs it in `build` and `verify`.

`forge verify` then runs each downstream repo's `verify` steps with its links applied, and its result gains `downstream: [{ repo, ok, failure }]`, one entry per downstream repo, only when the job has any. A downstream repo with no active link from a changed repo fails the step `links`. `forge job repo propose <id> <repo>` accepts a verify-only member (an edited one still returns `already: "member"`), and approving it promotes the member (`job-repo-promoted`): it exits 1, writing nothing, while that member's verify-only worktree has uncommitted or untracked changes or a HEAD that is not on `<git.remote>/<base>`.

## Agent ids

`forge job agent <id> attach --role R --agent-id A` records the runtime's id of an agent that is already `running` (the orchestrator runs it right after a background spawn), so `forge dash` can follow that agent's transcript while it works. It changes nothing else: `runs`, `startedAt` and `status` stay, and no event is logged. It prints `{ "role", "status", "agentId" }`, exits 1 when the role isn't running, and exits 2 (`usage`) without writing anything when `A` doesn't match `^[A-Za-z0-9_-]{1,100}$`, since the id becomes part of a transcript's file name.

## Foreman decisions

`forge job human <id> <action> [--actor human|foreman]` records who decided. Without `--actor` the event's `actor` is the resolved person, `{ "login": "<login>"|null, "source": "env"|"gh"|"git"|"os"|"dashboard"|"unknown" }` (docs/architecture/audit-trail.md); with `--actor foreman` it is `{ "login": null, "source": "foreman" }`. Events written before event schema v2 said `"human"` or `"foreman"`, and read as source `unknown` and `foreman`. `--actor foreman` is accepted only from the office daemon session (`FORGE_DAEMON_SCOPE=_office`), which in turn must pass it, and only after the authority checks in docs/architecture/foreman.md: the job waits on a gate class in `foreman.decides`, the action belongs to that class, `--note` is given and no reserved pattern matches (nor a latest security verdict other than `PASS`), a pr-feedback `rework` has a queued gate request for the PR's current head, and there is no `--link` or `--reason`. A refusal exits 1 and writes nothing.

`forge job assist <id> --gate <class>` is read-only and returns `{gate, stale, reserved, model, effort, subagent, brief}`: the `forge:assistant` spawn for that gate, with a brief of paths only. `stale: true` means the job no longer waits on that gate, and `reserved` is re-checked at call time. An unknown `--gate` exits 1, and so does a daemon session other than the office. `forge requests add gate` always exits 1: only `forge job set` and `forge pr sync` write gate requests.

A recorded decision moves the job by itself: the next `forge job step` on a job whose current park a `human` event answers returns that gate's follow-up `forge job set` (rules GA1–GA11, docs/architecture/job-model.md › Answered gates), so `forge job human` followed by `forge requests add resume --job <id>` is enough from any session.

`forge job handoff <id> --class reserved|escalated|refused --reason "<text>"` records a **Foreman hand-off**: the office left the gate the job waits at for a person (a reserved topic or class, the assistant escalated, or the CLI refused its decision). Its checks run in this order and all before any write: the office daemon session (anywhere else it exits 1 with `only the office daemon session records a Foreman hand-off`), the job exists, the job waits on a gate the Foreman decides (otherwise exit 1, `job <id> is not waiting on a gate the Foreman decides`; the gate is taken from the job, never passed in), `--class` is one of the three, and `--reason` keeps some text once control characters and backticks are removed and it is cut to 200 characters (otherwise exit 1). It then logs one `foreman-handoff` event `{gate, class, reason, actor: {login: null, source: "foreman"}}` and prints `{"ok": true, "foremanHandoff": {"gate", "class", "reason", "at"}}`.

`forge status --json` rows and `forge job show` carry `foremanHandoff`: that `{gate, class, reason, at}` while the job still waits on the gate it was handed off at, with no newer transition and no `human` event (anyone's decision) since, and `null` otherwise. It is derived from events on read; job.json has no such field. `forge status` marks such a job `waiting:<gate> (left for a human)` in its agent-mode table, and adds a `handoff` column (`<class>: <reason>`) in human mode.

## Merging

`forge pr merge <id> [--repo NAME | --root] [--now]` syncs first, then merges one PR at a time with exactly one `gh pr merge` call each: directly when checks pass or the repo has no CI, queued with `--auto` while checks are pending only when GitHub holds the PR and no protected-paths policy applies, deferred otherwise, and refused when checks fail. A single-repo job has one PR, and the result is `{ merged, autoMerge, action, checks, mergeState?, error? }` with `action` one of `already-merged`, `merged`, `auto`, `deferred`, `refused`, `failed`.

A job with a member repo that gets a PR merges its PRs in the order of the components' `dependsOn` (docs/architecture/job-repos.md): a PR is merged, or queued with `--auto`, only when every PR it depends on is MERGED by this call's own sync. The walk goes on after a direct merge and stops at the first PR it queues, defers, refuses or fails to merge, so a consumer is never queued while a dependency is unmerged. `--repo NAME` merges only that member's PR and `--root` only the root's; either is refused while a PR it depends on is not merged, has no PR, or could not be read. The result adds `repo` (the PR acted on last, null for the root), `parts` (one `{ repo, number, action, checks, mergeState?, error? }` per PR acted on, in order) and, on an order refusal, `reason`: `order` when a dependency PR is not merged, `cycle` when the components' `dependsOn` form a cycle between the job's repos, which refuses every merge of the job. Both exit 1 with no `gh pr merge` call and log `pr-merge-refused` with that `reason`. `merged` is true only when every PR of the job is MERGED. `--now` bypasses CI and the head pin for each PR it merges, never the order. `--repo` with `--root`, `--repo` naming no PR member, and `--root` with a value (`--root <id>` swallows the id) exit 1.

## Leases and fencing

`forge job claim <id> --session S` prints `{ id, lease, epoch }`: the job's lease (`{ driver, epoch, since, renewedAt, expiresAt }`, docs/architecture/job-model.md › Ownership) and the epoch to fence later writes with. A new driver gets the next epoch; a re-claim by the same driver keeps it, so re-claiming always returns the epoch to use. `--epoch N` is accepted by `forge job step`, `forge job advance`, `forge job set`, `forge job claim` and `forge job agent start|end`; with it, the command is refused before it writes anything when the lease is no longer at epoch N or (with `--session S`) S no longer drives the job: exit 3, code `stale_epoch`, and the caller must stop driving the job. Without `--epoch`, nothing is fenced and `forge job advance` keeps its driver check. `N` must be a non-negative integer (else `usage`). Before `plan.md` or `spec.md` exists, a claim of a job started from its issue also re-reads `request.md` from that issue, best effort, and adds `requestRefreshed: true` when it changed; `forge next --claim` does the same for the job it resumes (docs/TRACKERS.md "Edited issues").

`forge requests` (list) first returns to `pending` any `in-progress` request whose session is gone (its job's lease, held by that session, expired; or, for a request no lease covers, its claim is over 30 minutes old), adding `requeues`; one orphaned a second time is `rejected` with `its session ended twice while handling it`.

`forge sync` ends with the reconciler's pass (docs/architecture/daemon.md › Reconciler) and reports it as `reconcile`: `{ resumed, escalated, requeued }` (job ids resumed or parked on `escalation` for having nothing to drive them, and request ids returned to pending), or the string `"skipped (forge dash owns it)"` while a live `forge dash` holds the daemon lock and reconciles on its own (sync reads the lock, never takes it), or `{ error }` when the pass failed; the rest of the sync has run either way.

## Next

`forge next [--claim --session S] [--force] [--limit N]` prints `{ item, more }` (`item` null when nothing is ready), plus `blocked` (`[{ ref, id, waitingOn }]`, items whose job waits on dependencies) when any. The ready list is the root tracker's items, then each [member repo tracker](TRACKERS.md#member-repo-trackers)'s in config `repos` order, each read with the same `--limit`. A member item's `ref` is `owner/name#N` and it adds `repo` (the member's name); a root item has no `repo` key. A member that could not be read (its clone fails doctor's member check, or its tracker call failed) is left out and listed in `skippedRepos: [{ repo, reason }]`, with `reason` at most 300 characters; the key is present only when a member was skipped, on every result shape (`item`, a started job, `resumed`). A root tracker failure exits 1 as before. With `--claim`, a member item starts its job through `forge job from-ref`, and the result is `{ id, ref: "owner/name#N", title, branch, repo }` plus `resumed`, `blocked`, `repoBudget` and `skippedRepos` where they apply.

## Audit trail

`forge job audit <id> [--json|--csv]` prints the job's audit rows in time order (docs/architecture/audit-trail.md says which events carry an actor). JSON, the default:

```
{ "id", "title", "pr": { "number": n|null, "mergeMethod": s|null, "merged": bool },
  "rows": [ { "ts", "job", "actor": { "login", "source" }|null, "action", "note": s|null, "detail": s|null } ] }
```

A row is an event with an actor (`action` is the `human` event's action, else the event type), a gate transition (`gate:<waitingOn>` into a wait, `gate-cleared:<waitingOn>` out of one, with the reason as `note`), `pr-opened`, or `pr-merged` / `pr-auto-merge`. `detail` is a one-line summary per type, and a member repo's merge rows start with the repo (`lib #7 squash`). `pr` is the root PR: `merged` counts only its merge.

`detail` per type: budget keys, the PR number and merge method, the linked ref, the permission tool and decision, the mode, a config key's change. An unknown job exits 1.

Archived jobs (`forge job archive`, `forge job prune`, `retention.jobsDays`) are included: their rows come from `.forge/archive/<id>.json`, plus an `archived` row (detail: the trigger) per job, and `forge job audit <id>` accepts an archived id.

`forge audit --since <date> [--until <date>] [--csv]` prints the same rows for every job and for the repo-level log (`.forge/runtime/audit.jsonl`, where `job` is null), with `since <= ts < until`, sorted by time then job id: `{ "since", "until", "rows" }`. A date is `YYYY-MM-DD` (UTC midnight) or a full ISO timestamp with its zone, and `--until` defaults to now. A missing or invalid date, or `--until` not after `--since`, exits 2 (`usage`).

`--csv` prints RFC 4180 CSV with the header `ts,job,actor,source,action,note,detail,pr,merge_method` and CRLF line ends. A field containing `,`, `"`, CR or LF is quoted with `"` doubled, and a cell starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'` so a spreadsheet reads it as text. `--json` and `--csv` together exit 2.

## Outcomes

**The sync pass.** With `pr.enabled`, `forge sync` measures merged jobs' outcomes after its PR loop: live jobs (not archived, not `kind: eval`) whose root PR is `MERGED` and that have no outcome yet, or an `open` one whose window has closed or that was last measured over 24 hours ago. At most 10 per run, never-measured first, then the oldest `measuredAt`. It reads `gh pr view` (title, merge commit, merge time), `gh pr list --state merged --search "Revert in:title"` and, for the GitHub tracker, `gh issue list --label bug`, all read-only, and the base branch's git history after one `git fetch`. Each measurement writes `job.outcome` (fields only: a job's stage and state never change) and logs one `outcome` event: `{ status, reverted, followUps, churnCommits }`. The result gains `outcomes: { measured, finalized }` when anything was measured; a thrown error becomes one `{ outcomes: "error", error }` result and never fails the sync.

**The outcome** (`job.outcome`, null until measured): `status` (`open` until `closesAt`, then `final` once every check completed or after 3 attempts that left one null), `windowDays`, `mergedAt`, `closesAt` (`mergedAt` plus `outcomes.windowDays`; a final outcome keeps its own), `mergeSha`, `reverted` and `revertedBy` (`{ kind: "commit", sha }` or `{ kind: "pr", number }`), `followUps` (a count, `"unsupported"` off the GitHub tracker, null when gh failed) and up to 20 `followUpRefs` (`owner/repo#n`), `churn` (`{ commits, lines, files }`, null when the merge commit is missing), `measuredAt`, `attempts`, and `reason` when a check couldn't run (`no merge time`, `no merge commit`, `merge commit not found`, `unsafe base branch`). Only numbers, shas and rebuilt refs are stored: no GitHub title or body.

**In `forge stats`.** `quality` gains `autonomyRate`, `autonomyRateStrict`, `revertRate`, `followUpRate`, `churnRate` (each null when its denominator is 0) and `outcomeCoverage: { merged, final, open }`. Only final outcomes are judged (docs/IMPROVEMENT.md defines each rate), and the text output's first quality line is `autonomy 75% (strict 50%) · reverted 0% · follow-ups 25% · churn 50% · outcomes final 4/6 (open 1)`. The retro's `signals.md` lists reverted and followed-up jobs under `## Post-merge outcomes`.

## Scoring

**The sync pass.** With `pr.enabled` and `scoring.sample` above 0 (docs/CONFIG.md "Scoring"), `forge sync` runs a scoring pass after the outcome pass. It considers live jobs (not archived, not `kind: eval`) whose root PR is `MERGED`, that have no `score` yet, that are in the sample, and whose merge (`pr.mergedAt`, else `outcome.mergedAt`) was in the last 7 days. At most 5 per run, oldest merge first. Each one is:
- **held** when it is over its per-job budget (`reason: "budget exceeded"`) or the repo budget holds (`reason: "repo budget"`). No request is written and no judge runs, and a held score is never retried.
- **left alone** when `gh pr diff <number> -R <owner/repo>` (read-only) fails. The next sync retries it, inside the 7 days.
- **queued** otherwise: the diff goes to `<job dir>/score.diff` (cut at 1 MiB with a last line `[forge: diff truncated at 1048576 bytes]`), `job.score` becomes `queued`, a `score` event `{ status: "queued" }` is logged, and a `resume` request `forge sync queued a score run` is added for the job's session.

The result gains `scoring: { queued: [ids], held: [ids] }` when either list is non-empty; a thrown error becomes one `{ scoring: "error", error }` result and never fails the sync.

**The run.** For a done job whose score is `queued`, `forge job step` returns, before G1, a `spawn` of `forge:judge` (JS2: output `score.md`, model `scoring.model` or else `runtime.models.judge`), a `wait` while it runs (JS1), then a `run` of `forge job score record <id>` (JS3). The judge's brief lists only `request.md`, `spec.md` and `score.diff`, the spec's acceptance criteria and the main checkout; never the build log, reviews, verify reports or the decision. Its usage is imported onto the job as usual, so it counts toward the job's and the repo's spend. The job's stage and state never change.

**`forge job score record <id>`** reads `score.md` (at most 64 KiB, a regular file, no symlink). A first non-empty line `SCORE: <n>/5` (`n` from 0 to 5, one decimal at most) records `status: "scored"` with `value`, `recordedAt`, `judgeModel` (the judge run's model) and `builderModel`, logs a `score` event `{ status: "scored", value }` and prints `{ id, score }`. A missing file or any other first line records `status: "failed"` (`reason: "no score.md"` or `"malformed score.md"`), logs a `score` event and exits 1 with a message naming the file. Nothing else from the file is stored. Exit 1 also when the job's score isn't `queued` (`no score run is queued for <id>`, a second record included) and for an unknown job (`not_found`). `forge job set --field score=…` is refused.

**The score** (`job.score`, null until queued): `status` (`queued`, `held`, `scored` or `failed`), `queuedAt` (null when held), `value` (only when scored), `outOf: 5`, `recordedAt`, `judgeModel`, `builderModel` and `reason`. A malformed stored score reads as null.

**In `forge stats`.** `quality` gains `medianScore` (null when nothing is scored), `scoreCoverage: { merged, sampled, scored, held, failed, queued }` (`sampled` counts jobs with any score) and `scoreByBuilderModel` (`{ <model>: { scored, medianScore } }`, `unknown` for no recorded builder model). The text output adds `score median 4/5 · scored 3/5 sampled (held 1, failed 0)`, or `score median -` when nothing is scored. `forge eval compare` gains `realJobs: { a, b }`: per run, `{ from, to, scored, medianScore, avgScore }` over real jobs merged in the 14 days ending at the run's `startedAt`, with `avgScore` on `avgJudgeScore`'s 0-1 scale. The retro's `signals.md` lists jobs scored 2 or less since the last retro under `## Low-scoring jobs`.

## Repo budget

`forge budget` prints the repo's spend against `budget:` (docs/CONFIG.md "Repo budget") and frees repo-held jobs once nothing is exceeded:

```
{ "day": "YYYY-MM-DD", "month": "YYYY-MM", "onExceeded": "hold"|"warn",
  "spent": { "dayUsd", "monthUsd", "monthTokens" },
  "configured": { "usdPerMonth", "tokensPerMonth", "usdPerDay" },   // null = unlimited
  "acks": { "day", "month" },
  "caps": { … },          // configured × (1 + acks for the period)
  "remaining": { … },     // max(0, cap − spent), null when uncapped
  "projectedMonthUsd", "exceeded": [key…], "held": bool, "reason": s|null, "heldJobs": [id…] }
```

`forge budget ack --period <YYYY-MM|YYYY-MM-DD> [--note N]` grants one more period's cap and prints `{ "acked", "status" }`. The period must be the current UTC month (for `usdPerMonth` or `tokensPerMonth`) or day (`usdPerDay`), and exceeded; otherwise it exits 1 (`nothing to acknowledge: <period> is within its cap`). A missing or malformed period exits 2. A daemon session (`FORGE_DAEMON=1`) is refused with exit 1, as is `forge job new --force`. The ack is a `repo-budget-ack` line in `.forge/runtime/audit.jsonl`, so `forge audit` lists it.

While the repo is held, `forge next` prints `{ "held": true, "repoBudget": { "held", "reason" } }` and exits 0, `forge job new` creates the job parked on `budget` (its result adds `repoBudget`), and `forge job claim` and `forge job from-ref` exit 4. Under `onExceeded: warn` they proceed and add `repoBudget` with `held: false`.

`forge stats --csv [--since DATE] [--by job|role|model|day]` prints the same spend as RFC 4180 CSV with CRLF line ends: the key column(s) (`job,kind,title` for `--by job`, the default; else `role`, `model` or `day`), then `runs,tokens,input,output,cache_read,cache_write,usd` (`usd` with 4 decimals), sorted by key. `--since` (YYYY-MM-DD or a full ISO timestamp) keeps events at or after it. Every job counts, evals and retros included, so the totals match `forge budget`. Cells go through the same formula guard as `forge audit --csv`. `--csv` with `--json`, `--by` (other than `prompt`) without `--csv`, or an unknown `--by` exits 2.

## Prompt cohorts

Every `agent-start` event (event schema v3) carries `pluginHash` (10 hex), `promptHash` (12 hex, the role's hash as `forge roster` reports it; for `reviewer:<lens>` the first 12 hex of `sha256(<reviewer promptHash> \0 <lens checklistHash or "">)`; null for a role with no `agents/<role>.md`) and `configHash` (10 hex; null when the job's config overlay is invalid). Each is null when it can't be computed, and never fails the start. `pluginHash` hashes regular files only, never through a symlink: a listed directory reached through a link hashes as a marker with the link's target, and the walk stops (with a marker) after 5000 entries or 32 MiB. Older events have none.

`forge stats --by prompt [--role R] [--since DATE] [--include-evals]` prints `{ by: "prompt", role, since, cohorts, unrecorded, mixed }`. A job's cohort is the `promptHash` on its last hashed `agent-start` for `R` (default `builder`). Each cohort is `{ promptHash, jobs, jobIds, firstAt, lastAt, pluginHashes, configHashes, stats }`: the first 20 job ids, the first and last of those starts, at most 5 distinct plugin and config hashes, and a full `forge stats --json` object over the cohort's jobs only; oldest `firstAt` first. `mixed` counts jobs whose starts for `R` carried more than one hash, `unrecorded` jobs with none. Archived jobs count. A `--role` that is neither an `agents/*.md` role nor `reviewer:<lens>`, and `--by prompt` with `--csv`, exit 2 (`usage`).

## Experiments

`forge experiment evaluate [<job>] [--dry-run]` settles `.forge/notes/experiments.md` (docs/IMPROVEMENT.md "Settling experiments"): the job worktree's ledger with `<job>`, else the repo's. It prints `{ file, dryRun, written, entries }`, one entry per ledger item: `{ id, metric, direction, baseline, baselineN, jobsAfter, n, value, method, interval, verdict, status, reason }`. `verdict` is `kept`, `reverted`, `inconclusive`, `pending`, or `settled` for an entry that was not open; `status` is the entry's status segment after the run (with `--dry-run`, what the run would write); `reason` names why an entry was closed at once or left open (`status segment is not "status open"`, `no id`, `no date`). It writes only that one file, atomically, and nothing under `.forge/` in the root it reads jobs from. Exit 1: no such job, the job has no worktree, or the ledger (or `.forge` or `.forge/notes` above it) is a link, not a regular file or over 1 MiB.

`forge experiment check [<job>]` prints `{ ok, problems: [{ file, entry, problem }] }` (`entry`: the item's first 80 characters, made safe for one line) and exits 1 when `ok` is false. With `<job>` it compares each notes file at the worktree's HEAD with the merge base; without one it audits the repo's files on disk. A notes file over 1 MiB, on either side, is the only problem reported (`over 1 MiB; not checked`, with an empty `entry`): nothing is parsed. Verify runs the same check at the verified sha as its `notes` step when the committed diff touches `.forge/notes/learnings.md`, `.forge/notes/experiments.md` or a role addendum; at most 20 problems are listed in its report. When the base can't be resolved, the step fails if any of those files at the verified sha differs from the main checkout's HEAD, and is absent otherwise.

## Recall evals

`forge eval recall list` prints `{ fixtures: [{ name, title, lenses, defects, clean }], problems: [] }` for the main checkout's `.forge/evals/recall/` (docs/IMPROVEMENT.md "Reviewer recall evals"); an invalid fixture exits 1 with each fixture and problem named.

`forge eval recall start [--job <id>]` prints `{ run, dir, promptRoot, pluginHash, head, reviews }`, one `{ fixture, lens, agent: "forge:reviewer", model, output, brief }` per fixture and lens. The run id is `YYYYMMDD-HHMMSS[-<job id>]`; with `--job` the run lives in the job dir and logs a `recall` event `{ phase: "start", run, pluginHash, head }`. Exit 1: an invalid fixture, no fixture, or no such job.

`forge eval recall record <run> [--tokens N]` prints `{ run, summary, base }`. `summary` is `{ byLens, total, minutes, tokens }`, each grade `{ planted, caught, recall, cleanReviews, falsePositives, precision, reviews, malformed }` (ratios null at a 0 denominator). With a job it logs `recall { phase: "record", run, pluginHash, head, summary, base }`, `base` being the newest done run without a job on the job's base branch (`{ run, head, summary }` or null); without one the record is copied to `.forge/evals/recall/runs/<run>.json`. A run id that ends in a job id is looked up in that job's dir only. Exit 1: no such run, the run is already recorded, or it has no review file; exit 2 for a malformed run id or `--tokens`.

## Support bundle

`forge doctor --bundle [<job>] [--out <dir>] [--include-text]` writes `forge-support-<YYYY-MM-DD>.zip` (local date; `-2`, `-3`… when that name exists, never overwriting a file) to `--out` (default: the current directory, which must exist), mode `0600`. Settings › Diagnostics › **Download support bundle** in `forge dash` builds the same zip for every active job, never with text. The job can also come first: `forge doctor <job> --bundle`. Without a job, the bundle covers every active job and adds the inbox and office session logs. It works in a repo without `.forge/config.yml` (the config is then the defaults).

Before writing, stderr lists every entry with its size, any file it skipped and why, and the redaction counts. stdout is `{file, bytes, entries: [{name, bytes}], skipped: [{name, reason}], redactions: {secrets, paths, emails, logins}, includeText, jobs}`. It exits 0 once the file is written, even when doctor's checks fail, and 1 for an invalid or unknown job, a missing or non-directory `--out`, a write failure, or a daemon session (`FORGE_DAEMON=1`): the bundle is a human's report, not a pipeline step.

| Entry | Content |
|---|---|
| `manifest.json` | `{createdAt, forgeVersion, includeText, jobs, entries, skipped, redactions}` |
| `doctor.json` | what `forge doctor` prints |
| `versions.json` | `{forge, node, git, gh, glab, os}`; a missing tool is `null` |
| `config.json` | the effective config, with every value that names a command, path, URL or person, and every key Forge doesn't know, replaced by `<redacted>` (`CONFIG_DISCLOSURE` in `lib/core/config/fields.ts`) |
| `daemon/inbox.log`, `daemon/office.log` | without a job: the last 500 lines of the inbox and office session logs |
| `jobs/<id>/job.json`, `events.jsonl`, `step.json` | the job, every event, and what `forge job step` decides now |
| `jobs/<id>/verify/round-<n>.md` | the last 200 lines of the newest verify round |
| `jobs/<id>/logs/verify-<step>-<ts>.log` | the last 200 lines of the newest verify log per step, at most 20 |
| `jobs/<id>/daemon.log` | the last 500 lines of the job's daemon session log |
| `jobs/<id>/text/<path>.md`, `jobs/<id>/diff.patch` | with `--include-text` only: the job dir's markdown (not `verify/`) and the branch's net diff from its merge base |

Each entry keeps at most its last 2 MiB. Files are read without following symlinks or blocking on FIFOs, and only from inside the job dir or the runtime dir; anything else is listed under `skipped`. A file or directory name in the job dir made of anything but letters, digits, `.`, `_` and `-` (or `..`) is skipped as `<unsafe name>`, never shown raw, so no name can carry a terminal escape or a path out of the zip.

**Agent text stays out by default.** In `job.json`, `events.jsonl` and `step.json`, the string values of `title`, `reason`, `summary`, `note`, `text`, `body`, `brief`, `prompt`, `message`, `output`, `comment`, `description` and `report` become `<omitted: n chars>` (`error` stays). Daemon log lines are reduced to a skeleton: their structure, numbers and the strings of id, type, name and state keys stay, and every other string (prompts, replies, tool input and output) becomes `<omitted: n chars>`. `--include-text` keeps all of it, still redacted.

**Redaction**, over every entry and entry name, in this order:
1. every job's known values (resolved secret references and job database passwords, raw and JSON-escaped; docs/CONFIG.md "Secret references") become `<secret:known>`, then likely secrets (the secret scanner's provider patterns and entropy check, with no allowlist) become `<secret:kind>`; `known-secrets.json` and `backing-db.json` are never included;
2. the repo root becomes `<repo>`, the worktrees root (`worktrees.root`) `<worktrees>` and the home directory `~`;
3. email addresses become `<email>`;
4. known identities (git `user.name`, the OS user, the machine's host name and its first label, the owners of the github.com and gitlab.com remotes, and `tracker.github.repo`'s owner, `tracker.github.project.owner`, `tracker.github.ready.assignee` and `pr.reviewers`) become `<login>`, as do the owner in any `github.com/<owner>` or `gitlab.com/<owner>` and any `@mention`.

Redaction is pattern-based and best-effort: a secret no pattern knows, or a login Forge doesn't know written as a plain word, can survive. Read the manifest stderr prints, and open the zip, before you attach it to a public issue.

## Stability

Forge follows semver for this contract. Any release may add commands, flags, JSON fields, error codes and environment variables. Renaming or removing a JSON field, an error code or an exit number is a breaking change: it ships only in a release whose version says so (a new major version, or a new minor version while Forge is below 1.0) and is called out in [CHANGELOG.md](../CHANGELOG.md). Message and hint text, human-mode output, and the order of JSON keys, are not covered: match on `code` and `exit`, never on `message`. `test/invariants/cli-contract.test.ts` pins the JSON keys of `forge job list|show|step`, `forge status --json`, `forge verify`, `forge stats --json` and `forge version --json` (`version`, `commit`, `installedAs`, `node`), so an accidental rename fails the build.

## Command reference

Generated from the `HELP` tables by `npm run docs`; `forge help <command>` prints the same.

<!-- forge:cli:start (generated from lib/cli/commands/*.ts by npm run docs:cli; edit those tables) -->
Every command also takes these flags, and exits 0 when it did what it was asked or 2 (`usage`) when the call could not be parsed, or .forge/config.yml is missing or invalid.

| Global flag | Meaning |
|---|---|
| `--json` | machine-readable output: errors print as one JSON line on stdout, and strings as JSON strings |
| `--mode human\|agent` | output for a terminal (human) or a program (agent); default human only when stdout is a terminal, agent under --json, FORGE_MODE when set |
| `--help` | print this command's help instead of running it |
| `--pretty` | indent JSON output |

### `forge audit`

Export the audit trail of every job for a period.

**`forge audit --since <date> [--until <date>] [--json|--csv]`**: every job's audit rows (forge job audit) and the repo-level ones such as config set (job null), with since &lt;= ts &lt; until, sorted by time then job; dates are YYYY-MM-DD (UTC midnight) or full ISO timestamps, and until defaults to now

| Flag | Meaning |
|---|---|
| `--csv` | the rows as RFC 4180 CSV with CRLF line ends, formula-like cells prefixed with ' |
| `--json` | the rows as JSON (the default) |
| `--since <date>` | the first instant included (required) |
| `--until <date>` | the first instant excluded (default now) |

See [Audit trail](architecture/audit-trail.md).

### `forge backing`

A job's databases, caches and queues (backing:), run through the Docker CLI.

**`forge backing down <id> | --shared`**: remove the job's per-job containers and volumes (only those labelled with this checkout and job), drop its job databases and role, and delete backing.json and backing-db.json, for any job, done or cancelled too; --shared removes this checkout's shared containers and keeps their volumes and ports

| Flag | Meaning |
|---|---|
| `--shared` | the project's shared containers instead of a job's |

| Exit | When |
|---|---|
| 1 | an invalid job id, or the inbox or office daemon session ran it |
| 5 | Docker missing, its daemon stopped, a docker or psql command failed, or a shared container is stopped (the records are kept for a retry) |

See [Backing services](CONFIG.md#backing-services).

**`forge backing status [<id>]`**: with a job: docker (ok, missing or stopped; null when no service is managed) and each service's container, state (unknown when Docker is unreachable), health (healthy, unhealthy or starting while running; null without a healthcheck), ports, job database (name and template) and the FORGE_BACKING_\* names its commands see (never values); without: every container labelled with this checkout, with orphan: true for a per-job one whose job is unknown, done or cancelled

| Exit | When |
|---|---|
| 1 | an invalid job id |
| 5 | Docker missing (code docker_missing) or its daemon stopped (docker_stopped), without a job only |

See [Backing services](CONFIG.md#backing-services).

**`forge backing stop <id>`**: docker stop the job's per-job containers (only those labelled with this checkout and job), keeping their volumes, records and every shared container; a missing, stopped or foreign container is listed in skipped with the reason; `backing up` starts them again

| Exit | When |
|---|---|
| 1 | an invalid job id, or the inbox or office daemon session ran it |
| 5 | Docker missing, its daemon stopped, a docker command failed, or a same-named container that is not this job's |

See [Backing services](CONFIG.md#backing-services).

**`forge backing up <id>`**: bring the job's per-job and the project's shared services up, idempotently: run a missing container, start a stopped one, leave a running one; then give the job its job database on each shared entry with database (cloned from the template database, built in the job's worktree when missing); the result lists each service's action and database, never a password

| Exit | When |
|---|---|
| 1 | an invalid job id or no such job, or the inbox or office daemon session ran it |
| 5 | Docker missing, its daemon stopped, a docker command failed, or a same-named container that is not this job's; for a job database, also a server not ready in 60 s, a failed migrate, seed or psql call, or no worktree |

See [Backing services](CONFIG.md#backing-services).

### `forge budget`

Repo spend against the day and month caps (budget:), and acknowledging an exceeded period.

**`forge budget`**: repo spend this UTC day and month against budget.usdPerDay, usdPerMonth and tokensPerMonth: caps, remaining, projected month-end and held jobs; frees repo-held jobs once nothing is exceeded

See [Repo budget](CONFIG.md#repo-budget).

**`forge budget ack --period <YYYY-MM|YYYY-MM-DD> [--note N]`**: grant one more period's cap for the current, exceeded UTC month or day, then free the jobs it held; a human only

| Flag | Meaning |
|---|---|
| `--note N` | why, kept in the audit log |
| `--period P` | the current UTC month (month caps) or day (usdPerDay) |

| Exit | When |
|---|---|
| 1 | a period that is not current, nothing exceeded in it, or a daemon session |

### `forge config`

Read, check and change .forge/config.yml.

**`forge config get [<key>]`**: read the effective config: one dotted key (strings raw, null when absent), or all of it

See [Changing settings](CONFIG.md#changing-settings).

**`forge config set <key> <value>`**: change one editable key in `.forge/config.yml`, keeping its comments

| Exit | When |
|---|---|
| 1 | an unknown or read-only key, an invalid value, or a layout the edit cannot keep |

See [Changing settings](CONFIG.md#changing-settings).

**`forge config show`**: the effective config (defaults merged with the file), indented

**`forge config validate`**: check the config; prints the problems

| Exit | When |
|---|---|
| 1 | the config has problems |

### `forge daemon`

The dashboard's headless sessions, from the terminal.

**`forge daemon log <job>|--inbox|--office [--lines N] [--follow]`**: a session's log, from the terminal

| Flag | Meaning |
|---|---|
| `--follow` | keep printing lines as they are written |
| `--inbox` | the inbox session's log instead of a job's |
| `--lines N` | the last N lines (default 100, at most 5000) |
| `--office` | the foreman's office session's log instead of a job's |

| Exit | When |
|---|---|
| 1 | an invalid job id, or no readable log |

**`forge daemon status`**: the daemon's sessions, from the terminal

### `forge dash`

The live dashboard and its session pool.

**`forge dash [--background|--stop] [--port N] [--permission-mode MODE] [--dev] [--quiet]`**: start the dashboard in the foreground (prints its URL), or detached with --background; --stop stops it and its sessions

| Flag | Meaning |
|---|---|
| `--background` | start it detached and print {url, pid} |
| `--dev` | serve npm run dev's watching build (node_modules/.cache/forge/dashboard-dev) instead of dashboard/dist; the daemon stays off until Start; refused while a dashboard runs for this repo |
| `--foreground` | run in the foreground even when one is running |
| `--permission-mode MODE` | the job sessions' default permission mode until it stops: default (ask), auto or dontAsk (refuse); refused in a daemon session |
| `--port N` | the first port to try (default: dashboard.port, 7400) |
| `--quiet` | in the foreground in human mode, print only the banner (no activity log) |
| `--stop` | stop it and reap its sessions |

| Exit | When |
|---|---|
| 1 | no free port near N, --dev while a dashboard is already running for this repo, or --permission-mode in a daemon session |

### `forge doctor`

Check this repo and machine for Forge.

**`forge doctor [<job>] [--bundle] [--out <dir>] [--include-text]`**: check this repo and machine for Forge (tools, config, job files, and the tool of each declared release mechanism) and print what is wrong, indented; --bundle writes a redacted support bundle for a bug report

| Flag | Meaning |
|---|---|
| `--bundle [<job>]` | write forge-support-&lt;date>.zip: doctor, versions, redacted config, and the job's (default: every active job's) events, step, verify and daemon logs, with paths, logins, emails and likely secrets redacted; the manifest prints to stderr first |
| `--include-text` | add the job dir's markdown and the branch diff, still redacted (left out by default) |
| `--out <dir>` | an existing directory to write the bundle to (default: the current directory) |

| Exit | When |
|---|---|
| 1 | bundle: an invalid or unknown job, a bad --out, a write failure, or a daemon session |

See [Support bundle](CLI.md#support-bundle).

### `forge environment`

A job's environment: its background processes, per-job containers and volumes, and job databases.

**`forge environment down <id>`**: tear the job's environment down, for any job, done or cancelled too: stop its background processes, remove its per-job containers and volumes, drop its job databases, delete backing.json and backing-db.json and drop it from the environment record; the worktree stays

| Exit | When |
|---|---|
| 1 | an invalid job id or no such job, or the inbox or office daemon session ran it |
| 5 | Docker missing, its daemon stopped, a docker or psql command failed, or a shared container is stopped (the records are kept for a retry) |

See [Backing services](CONFIG.md#backing-services).

**`forge environment list`**: the environment record: {maxRunning, focused, jobs: [{id, state, usedAt}]}, running or stopped as Forge last left each one, most recently used first, only for jobs that exist and are active

See [Backing services](CONFIG.md#backing-services).

**`forge environment stop <id>`**: stop a job's environment while keeping it: stop its background processes and docker stop its own per-job containers, keeping volumes, job databases and shared containers, and mark it stopped in the environment record. Forge does this itself when a job parks

| Exit | When |
|---|---|
| 1 | an invalid job id or no such job, or the inbox or office daemon session ran it |
| 5 | Docker missing, its daemon stopped or docker stop failed (the record still says stopped) |

See [Backing services](CONFIG.md#backing-services).

**`forge environment up <id>`**: start an active job's environment: run a missing per-job container, start a stopped one, give the job its job databases, and mark it running in the environment record. Forge does this itself on resume, verify, run --background and focus. Starts no background process

| Exit | When |
|---|---|
| 1 | an invalid job id or no such job, a done or cancelled job, or the inbox or office daemon session ran it |
| 5 | a backing service did not start |

See [Backing services](CONFIG.md#backing-services).

### `forge eval`

Measure Forge on frozen tasks: the task suite, runs and comparisons.

**`forge eval compare <runA> <runB>`**: two runs side by side: stamps, deltas with sample counts, per task

| Exit | When |
|---|---|
| 1 | no such run |

**`forge eval grade <job>`**: grade an eval job's result against its task's checks

| Exit | When |
|---|---|
| 1 | no such job, or not an eval job |
| 5 | git failed |

**`forge eval list`**: the eval tasks

**`forge eval mine --pr N [--name N] [--test-pattern P]`**: add a task from a merged PR: its issue as the request, its tests as hidden checks

| Flag | Meaning |
|---|---|
| `--name N` | the task name (default: from the PR) |
| `--pr N` | the merged PR (required) |
| `--test-pattern P` | which changed files are the hidden tests |

| Exit | When |
|---|---|
| 1 | the PR cannot be used |
| 5 | gh or git failed |

**`forge eval new <name> [--title T] (--request R | --body B | --body-file F)`**: add a task from a request

| Flag | Meaning |
|---|---|
| `--body B` | the request text |
| `--body-file F` | read the request from F (- for stdin) |
| `--request R` | the request text |
| `--title T` | the title (default: the name) |

| Exit | When |
|---|---|
| 1 | a task with that name already exists |

**`forge eval recall list`**: the main checkout's reviewer recall fixtures (.forge/evals/recall/&lt;name>/): lenses, planted defects, clean or not

| Exit | When |
|---|---|
| 1 | a fixture is invalid (the message names it and the problem) |

See [Reviewer recall evals](IMPROVEMENT.md#reviewer-recall-evals).

**`forge eval recall record <run> [--tokens N]`**: grade every review of a run: recall (planted defects caught) and precision (clean fixtures left alone) per lens, against the last base-branch run

| Flag | Meaning |
|---|---|
| `--tokens N` | the run's tokens, recorded as given |

| Exit | When |
|---|---|
| 1 | no such run, the run is already recorded, or no review file exists |

See [Reviewer recall evals](IMPROVEMENT.md#reviewer-recall-evals).

**`forge eval recall start [--job <id>]`**: start a recall run: copy each fixture's diff and return one forge:reviewer brief per fixture and lens, under the job worktree's (or repo's) own agents/reviewer.md when it has one, else the installed plugin's

| Flag | Meaning |
|---|---|
| `--job <id>` | grade this job's prompts: the run lives in its job dir and logs a recall event |

| Exit | When |
|---|---|
| 1 | a fixture is invalid, there is none, or no such job |

See [Reviewer recall evals](IMPROVEMENT.md#reviewer-recall-evals).

**`forge eval report <run>`**: one run in full

| Exit | When |
|---|---|
| 1 | no such run |

**`forge eval runs`**: the runs, with their summaries

**`forge eval start [--tasks a,b] [--tags a,b] [--label L] [--repeat N] [--set key=value]...`**: start a run: one eval job per task, each in its own worktree

| Flag | Meaning |
|---|---|
| `--label L` | the run's label |
| `--repeat N` | eval jobs per task, 1–10 (default 1) |
| `--set key=value` | a config overlay for this run's jobs: runtime.models.\*, runtime.effort(s), pipeline.\*, review.panel or verify; repeatable; never writes .forge/config.yml |
| `--tags a,b` | only tasks with these tags |
| `--tasks a,b` | only these tasks |

| Exit | When |
|---|---|
| 1 | no task matches, or a bad --repeat or --set |
| 5 | git failed |

### `forge experiment`

Settle the experiment ledger and check the notes layer.

**`forge experiment check [<job>]`**: check the notes layer: new learnings and addenda carry experiment: and review-by:, new ledger entries are open with a stats-path metric, and only evaluate settles one; with &lt;job>, what its branch adds or edits against the merge base, else a full audit of the repo's files

| Exit | When |
|---|---|
| 1 | a problem was found, no such job, or the job has no worktree |

See [Settling experiments](IMPROVEMENT.md#settling-experiments).

**`forge experiment evaluate [<job>] [--dry-run]`**: settle each open .forge/notes/experiments.md entry: its metric over the done or cancelled jobs created after it, against its baseline; writes kept, reverted or inconclusive (the only writer of a ledger status), in the job worktree's ledger with &lt;job>, else the repo's

| Flag | Meaning |
|---|---|
| `--dry-run` | compute every verdict and write nothing |

| Exit | When |
|---|---|
| 1 | no such job, the job has no worktree, or the ledger is a link or unreadable |

See [Settling experiments](IMPROVEMENT.md#settling-experiments).

### `forge focus`

The job you are QA-ing by hand.

**`forge focus [<id>] [--clear]`**: print the focused job ({focus: {id, title, since} | null}), focus an active job, or clear focus; a pointer in .forge/runtime/focus.json that a job lets go of when it finishes. Moving it undoes the previous job's configured checkout steps and runs the new job's; a failing step rolls back and keeps the previous focus. With backing services configured, it then starts the focused job's environment (no background process) and adds environment: {ok, error?}; a failed start keeps the focus

| Flag | Meaning |
|---|---|
| `--clear` | clear focus (succeeds when nothing is focused) |

| Exit | When |
|---|---|
| 1 | no such job, a daemon session set or cleared it, or a checkout step failed (focus unchanged) |

### `forge git`

Read-only git for agents, and staging and committing in a job's worktree.

**`forge git add <id> [--repo NAME] -- <path>...`**: stage paths in the job's worktree, from any cwd; refuses git options, paths outside the worktree and a protected path the policy refuses; prints protected: &lt;n> when the branch changes escalate paths

| Flag | Meaning |
|---|---|
| `--repo NAME` | stage in member repo NAME's worktree instead (not a verify-only repo) |

| Exit | When |
|---|---|
| 1 | no such job or worktree, an option, a path outside the worktree or in .git, or a protected path (code protected_path) |
| 5 | git failed |

**`forge git commit <id> [--repo NAME] (--message T | --message-file F) [-- <path>...]`**: commit in the job's worktree, on its branch, from any cwd (how agents commit, in a daemon session too); refuses git options, paths outside the worktree, AI attribution, a protected path the policy refuses and a likely secret (in the message always; in the staged changes under verifySecrets: block); prints protected: &lt;n> when the branch changes escalate paths

| Flag | Meaning |
|---|---|
| `--message T` | the commit message |
| `--message-file F` | read the message from F, a file inside the job dir |
| `--repo NAME` | commit in member repo NAME's worktree instead (not a verify-only repo; protected paths are root-repo paths and not checked there) |

| Exit | When |
|---|---|
| 1 | no such job or worktree, the wrong branch, a merge or rebase in progress, nothing to commit, a refused option, path or message, a protected path (code protected_path), or a likely secret (code secret_found) |
| 5 | git failed |

**`forge git diff [git args] [-- <path>...]`**: read-only git diff in the current directory, for agents: git's output and exit code pass through; --output, --ext-diff, --textconv and --open-files-in-pager are refused

| Exit | When |
|---|---|
| 1 | a refused option |
| 5 | git failed to start |

**`forge git log [git args] [-- <path>...]`**: read-only git log in the current directory, for agents: git's output and exit code pass through; --output, --ext-diff, --textconv and --open-files-in-pager are refused

| Exit | When |
|---|---|
| 1 | a refused option |
| 5 | git failed to start |

**`forge git range-diff [git args] [-- <path>...]`**: read-only git range-diff in the current directory, for agents: git's output and exit code pass through; --output, --ext-diff, --textconv and --open-files-in-pager are refused

| Exit | When |
|---|---|
| 1 | a refused option |
| 5 | git failed to start |

**`forge git show [git args] [-- <path>...]`**: read-only git show in the current directory, for agents: git's output and exit code pass through; --output, --ext-diff, --textconv and --open-files-in-pager are refused

| Exit | When |
|---|---|
| 1 | a refused option |
| 5 | git failed to start |

### `forge help`

This help, or a command's.

**`forge help [<command> [<subcommand>]]`**: the command list, a group's subcommands, or one command's flags and exit codes

### `forge init`

Set Forge up in this repo (/forge init drives it).

**`forge init detect`**: the repo's stack, commands and components, as /forge init sees them

**`forge init write --answers FILE [--force]`**: write .forge/config.yml from a JSON answers file, merged over the current config, and seed .forge/

| Flag | Meaning |
|---|---|
| `--answers FILE` | the answers, as JSON |
| `--force` | start from the defaults instead of the current config |

| Exit | When |
|---|---|
| 1 | the answers file cannot be read |

### `forge integrate`

Bring a job branch up to date with its base.

**`forge integrate <id> [--strategy merge|rebase] [--keep-conflicts | --continue]`**: merge or rebase the job's base into its branch; conflicts are aborted unless --keep-conflicts leaves them for the integrator

| Flag | Meaning |
|---|---|
| `--continue` | finish a merge or rebase once its conflicts are resolved |
| `--keep-conflicts` | leave conflicts in the worktree to resolve |
| `--strategy merge\|rebase` | how to integrate (default: pr.updateStrategy, merge unless set to rebase) |

| Exit | When |
|---|---|
| 1 | conflicts, a dirty worktree, nothing in progress for --continue, or no worktree |
| 5 | git failed |

### `forge job`

One job's state, agents and reviews; forge job step &lt;id> returns its next action.

**`forge job acs <id>`**: the spec's acceptance criteria and their proof in build.md, and the rows in its file map (fileMap; a spec without one reports incomplete: ["files"])

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job advance <id> --session S [--epoch N] [--max N]`**: runs step's `run` actions in-process (at most N, default 20) and returns the next `spawn`, `wait`, `procedure` or `done` with `ran`, one line per command it ran; refuses (exit 3) a job session S does not hold, and stops at the first failed command (exit 1)

| Flag | Meaning |
|---|---|
| `--epoch N` | the epoch your claim returned, checked at entry and after every command it runs (stale_epoch) |
| `--max N` | run at most N commands (default 20) |
| `--session S` | the session driving the job (required) |

| Exit | When |
|---|---|
| 1 | no such job, or a command it ran failed (the result says which) |
| 3 | session S does not hold the job, or (stale_epoch) another session took it over |

**`forge job agent <id> start|end|attach --role R [options]`**: record an agent starting or ending, with its usage; end also scans what the agent wrote for likely secrets (a secret-found event and secrets: &lt;n>, never a refusal); attach records a running agent's --agent-id so the dashboard can follow its transcript

| Flag | Meaning |
|---|---|
| `--agent-id A` | the runtime's id for the agent (required with attach) |
| `--duration-ms N` | with end: wall time |
| `--epoch N` | with start and end: the driver's epoch, refused (stale_epoch) before any write once another session took the job over |
| `--import` | with end and --agent-id: read usage from the agent's Claude Code transcript |
| `--model M` | the model it ran on |
| `--output P` | with start: the file it must write, inside the job dir |
| `--retry` | with start: a retry of a lost agent |
| `--role R` | the role, e.g. builder or reviewer:code (required) |
| `--status S` | how it ended |
| `--summary S` | its one-line reply |
| `--tokens N` | with end: tokens used |
| `--tool-uses N` | with end: tool calls made |

| Exit | When |
|---|---|
| 1 | no such job, an --output outside the job dir, the inbox or office session starting an agent, or attach on a role that is not running |
| 3 | stale_epoch: the lease moved past --epoch |

**`forge job archive <id>|--done --older-than D`**: archive a finished job into .forge/archive/&lt;id>.json (its job.json, events and a summary) and delete its job folder, after tearing down what is left of its environment; with --done --older-than D, every finished job at least D days old. A job whose teardown fails is listed in refused and kept. Stats, audit and retro still read archived jobs

| Flag | Meaning |
|---|---|
| `--done` | every finished job old enough, instead of one id |
| `--older-than D` | with --done: days since the job finished (an integer, 0 or more) |

| Exit | When |
|---|---|
| 1 | not eligible, or a daemon session |

See [Retention](architecture/retention.md).

**`forge job assist <id> --gate G`**: the office session's forge:assistant spawn for a gate: model, effort and a brief of paths only, and for repo-proposal the pending repos to pass as --repo; stale when the job no longer waits there. Read-only

| Flag | Meaning |
|---|---|
| `--gate G` | the gate class: spec-approval, split-approval, escalation, rounds-exhausted, conflicts, pr-feedback, repo-proposal, release |

| Exit | When |
|---|---|
| 1 | no such job, an unknown gate, or a daemon session other than the office |

**`forge job audit <id> [--json|--csv]`**: the job's audit trail: who did each human action (best effort, unauthenticated), its gate transitions, and its PR opening and merge, in time order

| Flag | Meaning |
|---|---|
| `--csv` | the rows as RFC 4180 CSV with CRLF line ends, formula-like cells prefixed with ' |
| `--json` | the rows as JSON (the default) |

| Exit | When |
|---|---|
| 1 | no such job |

See [Audit trail](architecture/audit-trail.md).

**`forge job budget <id> [--set key=value,...] [--ack]`**: the job's budget limits and use

| Flag | Meaning |
|---|---|
| `--ack` | accept the limits now exceeded, so the job goes on |
| `--set key=value` | set a limit: tokens, usd, minutes, changedLines or verifyRetries (default restores the configured one) |

| Exit | When |
|---|---|
| 1 | no such job, or an unknown budget key or bad value |

**`forge job claim <id> --session S [--force] [--epoch N]`**: take the job's lease for a session (30 minutes, renewed by its own step, advance, agent and worktree commands); a new driver gets the next epoch, which the result returns as `epoch` for every later --epoch. For a job started from its issue, before any plan.md or spec.md exists, it also re-reads request.md from that issue, best effort (`requestRefreshed: true` when it changed)

| Flag | Meaning |
|---|---|
| `--epoch N` | a re-claim by the driver holding epoch N; refused (stale_epoch) once the job moved on |
| `--force` | take it from a live lease, or claim it with dependencies not done |
| `--session S` | the claiming session (required) |

| Exit | When |
|---|---|
| 1 | no such job, or the office daemon session ran it |
| 3 | another session holds a live lease (owned), or the lease moved past --epoch (stale_epoch) |
| 4 | dependencies pending, or the repo budget holds new work |

**`forge job decision <id>`**: read decision.md and record the approver's decision

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job delete <id> [--force]`**: delete a job started by mistake, for good: releases its tracker claim, removes its worktrees, per-job backing services and the branch Forge named for it, rejects its open requests and deletes its job folder and session logs, keeping no archive record. A job with a PR, split children or an active dependent is refused: cancel and archive real work instead

| Flag | Meaning |
|---|---|
| `--force` | delete it even while a live interactive session owns it |

| Exit | When |
|---|---|
| 1 | no such job, not eligible (the message says why), a worktree or backing teardown that failed (rerun once fixed), or a daemon session |

See [Deleting a job](architecture/deleting-a-job.md).

**`forge job effort <id> low|medium|high|xhigh|max | --inherit`**: set a job's reasoning effort (forge job new --effort sets it at creation), or clear it so the job inherits runtime.effort; daemon sessions start with --effort and every agent gets it

| Flag | Meaning |
|---|---|
| `--inherit` | clear the job's effort |

| Exit | When |
|---|---|
| 1 | no such job, or a daemon session |

See [Effort](CONFIG.md#effort).

**`forge job findings <id>`**: review findings per round and lens: raised, fixed, disputed and recurring (same lens and path in consecutive rounds)

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job from-ref <ref> [--session S]`**: start (or find) the job for a tracker item (#12, 12 or this repo's owner/repo#12, or owner/name#N from a member repo's tracker, which starts the job with that member as a job repo), planned as one job, and claim the item for it

| Flag | Meaning |
|---|---|
| `--session S` | claim the job for session S |

| Exit | When |
|---|---|
| 1 | no such tracker item, an issue outside this repo and its member repos' trackers, or a member clone that fails doctor's check |
| 3 | the tracker claim was lost to another job |
| 4 | the repo budget holds new work |
| 5 | gh failed (GitHub tracker) |

**`forge job get <id> [path]`**: one value of job.json by dotted path (null when absent)

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job handoff <id> --class reserved|escalated|refused --reason R`**: record a Foreman hand-off: the office leaves the gate the job waits at for a person (office session only)

| Flag | Meaning |
|---|---|
| `--class C` | why: reserved (a reserved topic or class), escalated (the assistant escalated) or refused (the CLI refused the decision) |
| `--reason R` | one line for the person, at most 200 characters once control characters are removed (required) |

| Exit | When |
|---|---|
| 1 | not the office daemon session, no such job, a job not waiting on a gate the Foreman decides, an unknown --class, or an empty --reason |

**`forge job human <id> <action> [--note N] [--link <ref>|new|none] [--reason R] [--repo A[,B]] [--actor human|foreman]`**: record a human decision: approve-spec, revise-spec, approve-split, revise-split, approve, rework, answer, or approve-repos or reject-repos on the pending repo proposals named by --repo (approve adds each repo to the job), or the foreman's approve-release of the job's pending release plan (logs release-approval and moves no job)

| Flag | Meaning |
|---|---|
| `--actor human\|foreman` | who decided (default human); foreman only from the office daemon session, which must pass it; approve-release takes only --actor foreman and --note |
| `--link <ref>\|new\|none` | with approve or approve-spec: link an issue, create one, or record that none is needed |
| `--note N` | the human's note |
| `--reason R` | why, with --link none |
| `--repo A[,B]` | with approve-repos or reject-repos (required): the pending repos you decide; with --actor foreman, every pending one |

| Exit | When |
|---|---|
| 1 | no such job, a --link that cannot be made, a foreman decision the authority checks refuse, or approve-repos or reject-repos with nothing pending, no --repo, a repo that is not pending, a foreman --repo that is not the whole pending set, a failing clone check, or from a daemon session other than the office |
| 3 | the tracker claim was lost to another job |
| 5 | gh failed (GitHub tracker) |

**`forge job interim <id> | publish <id> (<name> | --root) [--confirm] | release <id> (<name> | --root) <version>`**: each dependency edge between the job's repos: its interim strategy (job or config), links, state (held, waiting, ready, blocked, stale or released) and why, with no network call, plus each edge's release gate (ci, held, bump-due or released). publish publishes a dependency repo's canary: each npm link's package, exported from the verified commit's git objects, as &lt;version>-canary.&lt;sha12> under the canary dist-tag; without --confirm it only lists what it would publish, and --confirm needs a terminal on stdin. publish and forge release run are the only commands that publish anything. release records that the dependency of an edge of any strategy was released as &lt;version>, after its PR merged (result: recorded, clear, bump, resumed): forge verify then bumps each unmerged consumer's manifests (and a tracked lockfile) to it, after which the consumer's PR may leave draft (forge pr ready) and merge; a job waiting on pr-review at stage pr resumes. publish and release are human-only

| Flag | Meaning |
|---|---|
| `--confirm` | with publish: publish (without it, nothing is published) |
| `--root` | with publish or release: the root repo instead of a member |

| Exit | When |
|---|---|
| 1 | no such job; for publish, a daemon session, --confirm without a terminal on stdin, a repo that is not the dependency of an npm-only canary edge, a HEAD that is not the one the latest passing verify checked or not on the job branch, a package.json whose name is not the link's, a package that tracks a symlink or npm, yarn or pnpm config in any case, a failed npm publish, or a likely secret in its commits or its files (code secret_found); for release, a daemon session, a done or cancelled job, an unknown repo, a repo no edge depends on, a version that is not semver or names a canary, or a dependency whose recorded PR is not merged |

See [Interim strategies](CONFIG.md#interim-strategies).

**`forge job link <id> <ref>…|--remove <ref>|--create|--none [--reason R]|--suggest`**: add issues to a job (this repo's are checked and claimed, other repos' only recorded), remove them, create one, or record that it needs none

| Flag | Meaning |
|---|---|
| `--create` | create an issue from the job and add it |
| `--none` | record that the job needs no issue |
| `--reason R` | why, with --none |
| `--remove R` | remove an issue from the job; the tracker claim stays (repeatable, or comma-separated) |
| `--suggest` | list issues that look like this job, linking nothing |

| Exit | When |
|---|---|
| 1 | no such job or item, an invalid ref, a ref the job does not carry, --none on a linked job, or tracker.kind is none |
| 3 | the tracker claim was lost to another job |
| 5 | gh failed (GitHub tracker) |

See [Linking jobs to issues](TRACKERS.md#linking-jobs-to-issues).

**`forge job links <id>`**: the job's local links (config dependsOn links), active or not, with the dependency dir or the reason

| Exit | When |
|---|---|
| 1 | no such job |

See [Local links](CONFIG.md#local-links).

**`forge job list [--all]`**: active jobs, one object each

| Flag | Meaning |
|---|---|
| `--all` | include finished and cancelled jobs |

**`forge job new --title T [--body B | --body-file F] [--session S] [options]`**: create a job; with --session, claim it for that session (a split child, with --parent, starts unowned)

| Flag | Meaning |
|---|---|
| `--body B` | the text |
| `--body-file F` | read the text from F (- for stdin) |
| `--branch B` | the branch to push to (default: git.branchPrefix + id) |
| `--effort E` | the job's reasoning effort: low, medium, high, xhigh or max (default: inherit runtime.effort) |
| `--force` | start it past an exceeded repo budget (budget:), logged as a budget-override; a human only |
| `--issue R` | an issue to record, in order, the first one primary: #12, owner/repo#12, KEY-123 or a backlog ref (repeatable, or comma-separated; no tracker call) |
| `--kind K` | feature, bug, … |
| `--no-issue` | record that the job needs no issue (not with --issue or --ref) |
| `--parent ID` | the umbrella job this one was split from |
| `--reason R` | why, with --no-issue |
| `--ref R` | the one tracker ref it came from (not with --issue) |
| `--services a,b` | the services it touches |
| `--session S` | claim the new job for session S |
| `--slug S` | the words its id starts with (default: from the title) |
| `--title T` | the title (required) |
| `--tracker T` | the tracker kind of --ref or --issue (default: tracker.kind) |
| `--url U` | the tracker item's URL, with --ref |

| Exit | When |
|---|---|
| 1 | an unsafe --branch or ref, --no-issue with tracker.kind none, or --effort or --force from a daemon session |

**`forge job note <id> [text] [--body B | --body-file F]`**: log a note event

| Flag | Meaning |
|---|---|
| `--body B` | the text |
| `--body-file F` | read the text from F (- for stdin) |

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job panel <id>`**: this round's review lenses: always, the spec's suggestions and the panel's paths matched against the branch diff, with a reason per lens; each reviewed job repo adds the lenses its clone's panel defines, as &lt;repo>:&lt;lens>; on a narrowed rework round, rerun and skipped name the rework panel

| Exit | When |
|---|---|
| 1 | no such job, no worktree or no spec.md |
| 5 | git failed |

**`forge job paths <id>`**: absolute paths of the job's files, for agent briefs

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job progress <id>`**: tasks done and total in tasks.md

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job prune --older-than D [--dry-run]`**: archive every eligible finished job at least D days old and delete stale daemon session logs; --dry-run lists what it would free and writes nothing

| Flag | Meaning |
|---|---|
| `--dry-run` | list the jobs, refusals and logs with their sizes; change nothing |
| `--older-than D` | days since the job finished or the log was last written (an integer, 0 or more) |

| Exit | When |
|---|---|
| 1 | not eligible, or a daemon session |

See [Retention](architecture/retention.md).

**`forge job refresh-request <id>`**: re-read request.md and the title from the job's primary issue, so a queued job picks up an edited issue; the id, links, claim and dependsOn stay

| Exit | When |
|---|---|
| 1 | no such job, a finished job, plan.md or spec.md already written, an agent running, no linked issue, an issue outside this repo and its member repos' trackers, or no such tracker item (gh failing reads as none) |

**`forge job release <id>`**: drop the job's driver (its epoch stays)

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job repo add <id> <name> [--verify-only] | remove <id> <name> | propose <id> <name> --reason R | downstream <id> | interim <id> (<name> | --root) canary|git-ref|local|sequential|inherit`**: add a member repo (a config repos entry whose clone passes doctor's check) to a job, which then gets its own worktree, verify evidence and PR on the job's branch; remove drops one that has no PR and no worktree left; interim sets one job repo's interim strategy as a dependency (what a consumer's PR points at while it is unmerged: docs/CONFIG.md "Interim strategies"), overriding release.interim, and inherit clears it (add, remove and interim are human-only). propose records an agent's proposal of a repos entry with its reason in repo-proposals.md; the job then waits until a human, or the foreman when allowed, runs forge job human &lt;id> approve-repos|reject-repos (approving a verify-only member promotes it to an edited one). downstream adds the changed repos' linked consumers as verify-only repos, so verify runs their tests against the job's changes, and prints what it added and skipped with each reason (docs/CONFIG.md "Downstream verification"); it takes no repo name, and the job's own session may run it

| Flag | Meaning |
|---|---|
| `--reason R` | with propose: what changes in that repo and which component needs it (at most 200 characters) |
| `--root` | with interim: the root repo instead of a member |
| `--verify-only` | with add: verify the repo at its base with the job, but give it no branch, push or PR |

| Exit | When |
|---|---|
| 1 | no such job, a done job or one at stage pr, an unknown or duplicate repo, a failing clone check, a repo with a PR or a worktree, or a daemon session; for interim, a done or cancelled job, an unknown or verify-only repo, canary for a repo a cargo or cmake link depends on, or a daemon session; for propose: a missing or long --reason, an eval job, a repo rejected on this job, or a daemon session other than the job's own; for downstream: an eval job, a job at stage pr or later, or a daemon session other than the job's own |

See [Job repos](architecture/job-repos.md).

**`forge job round <id>`**: start the next review round, unless the budget is spent

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job scope <id>`**: files the branch changed outside the spec's Approach, across every reviewed job repo (member paths prefixed &lt;repo>/), plus this round's review/round-&lt;n>/diff.patch for every job and scope.diff for a multi-repo job

| Exit | When |
|---|---|
| 1 | no such job, no worktree or no spec.md |
| 5 | git failed |

**`forge job score record <id>`**: record the post-merge judge's score from score.md (first non-empty line `SCORE: <0-5>/5`) on a job whose score run forge sync queued; a missing or malformed file records the run as failed

| Exit | When |
|---|---|
| 1 | unknown job, nothing queued, or missing/malformed score.md |

**`forge job set <id> [--stage S] [--state S] [--waiting-on W|none] [--reason R] [--note N] [--field key=value]...`**: change a job's stage, state or fields; every check runs before anything is written. Moving an active job to done or cancelled tears its environment down (background processes, per-job containers and volumes, job databases) and lists it as environment; in the inbox or office daemon session it only stops it (environment.teardown: deferred), keeping volumes and job databases for archive or forge environment down; a failed teardown keeps exit 0 and the records, for forge environment down to retry

| Flag | Meaning |
|---|---|
| `--epoch N` | the driver's epoch: refused (stale_epoch) before any write once another session took the job over |
| `--field key=value` | set a field (values are JSON or plain words; repeatable) |
| `--note N` | a note logged with the change |
| `--reason R` | why, shown with the state |
| `--stage S` | the pipeline stage |
| `--state S` | queued, running, waiting, blocked, failed, cancelled or done |
| `--waiting-on W` | what a waiting job waits on (none clears it) |

| Exit | When |
|---|---|
| 1 | no such job, a field set only by another command, a list field that is not a JSON array of strings, or an unknown or cyclic dependency |
| 3 | stale_epoch: the lease moved past --epoch |

**`forge job show <id> [--full]`**: one job, compact (the whole job.json with --full)

| Flag | Meaning |
|---|---|
| `--full` | print the whole job.json |

| Exit | When |
|---|---|
| 1 | no such job |

**`forge job step <id> [--session S] [--epoch N]`**: the job's next action (`spawn` with a ready agent brief, `run`, `wait`, `procedure` or `done`); read-only, the same state always gives the same answer, except that `--session <driver>` renews that session's lease

| Flag | Meaning |
|---|---|
| `--epoch N` | the epoch your claim returned: refused (exit 3, stale_epoch) once another session took the job over |
| `--session S` | renew session S's lease, when S drives the job |

| Exit | When |
|---|---|
| 1 | no such job |
| 3 | stale_epoch: the lease moved past --epoch, or to another driver |

**`forge job verdicts <id> [--round N|integration] [--reviewers a,b] [--malformed changes] [--compact]`**: read a round's review files and record their verdicts once all are in, with each reviewed job repo's HEAD

| Flag | Meaning |
|---|---|
| `--compact` | one verdict per lens, and the missing files |
| `--malformed changes` | count a malformed review as CHANGES |
| `--reviewers a,b` | the lenses to read (default: the job's reviewers) |
| `--round N` | the round (default: the current one), or integration |

| Exit | When |
|---|---|
| 1 | no such job, or no reviewers selected |

### `forge migrate`

Bring config.yml and every job.json to the current schema.

**`forge migrate`**: bring config.yml and every job.json to the current schema, listing the files it changed

### `forge next`

Take the next piece of work.

**`forge next [--claim --session S] [--force] [--limit N]`**: resume a queued unowned job (with --claim --session), else the next ready tracker item whose job is not blocked, skipping needs-info items (with --claim, start its job): the root tracker's first, then each member repo's tracker (config repos), whose items carry repo and an owner/name#N ref; a member that can't be read is listed in skippedRepos; while the repo budget holds new work it starts nothing and prints {held: true, repoBudget}

| Flag | Meaning |
|---|---|
| `--claim` | claim the work instead of only showing it |
| `--force` | don't skip items whose job waits on dependencies |
| `--limit N` | read at most N ready items (default 20) |
| `--session S` | the session claiming it |

| Exit | When |
|---|---|
| 1 | the tracker failed |
| 3 | the tracker claim was lost to another job |
| 5 | gh failed (GitHub tracker) |

### `forge notify`

Push gate, PR, failure and budget notifications to webhooks and a command.

**`forge notify send --events <e1[,e2]> [--job <id>] --reason <code>`**: internal: what a state change spawns, detached. Delivers to the targets that subscribe to the first matching event, reading the job's title, stage and PR url itself, and records notified or notify-failed per target on the job (else in .forge/runtime/notify.jsonl)

| Flag | Meaning |
|---|---|
| `--events <e1[,e2]>` | the events, most specific first |
| `--job <id>` | the job it is about (none for a pool-wide daemon stop) |
| `--reason <code>` | the reason code, mapped to a fixed English string |

| Exit | When |
|---|---|
| 1 | a target failed, or no such job |

**`forge notify test [--event <name>]`**: send one sample notification (job null, title "Forge test notification") to every valid notify.webhooks entry regardless of its events, and run notify.command if set; prints {event, results: [{target, host, format, ok, status, error, attempts}]} and records nothing

| Flag | Meaning |
|---|---|
| `--event <name>` | the sample's event (default gate): gate, pr-opened, pr-merged, job-failed, daemon-stopped, budget-exceeded, secret-found |

| Exit | When |
|---|---|
| 1 | a target failed, or notify has no webhooks or command |

See [Notifications](CONFIG.md#notifications).

### `forge pr`

A job's pull request.

**`forge pr find <id>`**: find the job's open PR by branch and record it

| Exit | When |
|---|---|
| 1 | no such job |
| 5 | gh or git failed |

**`forge pr merge <id> [--repo NAME | --root] [--now]`**: merge once CI passes, or queue auto-merge, or defer; a multi-repo job's PRs merge in the components' dependsOn order, never a PR before its dependencies; --now is a human override that bypasses CI

| Flag | Meaning |
|---|---|
| `--now` | merge without waiting for CI, or a head forge pr open did not check (logged as pr-merge-bypass); never bypasses the merge order or a release gate |
| `--repo NAME` | merge only that member repo PR, once every PR it depends on merged |
| `--root` | merge only the root repo PR, once every PR it depends on merged |

| Exit | When |
|---|---|
| 1 | the merge was refused or failed (the result says why), a dependency PR is not merged yet, the dependsOn edges form a cycle, or a consumer's release gate is held or bump-due (reason order\|cycle\|release), the job has no PR, --repo names no PR member, --repo and --root together, --root given a value, the office daemon session ran it, or protected paths apply and the PR head is not the one forge pr open checked (code protected_path; --now overrides) |
| 5 | gh or git failed |

**`forge pr open <id> [--title T] [--draft] [--force]`**: push the verified branch and open or update its PR; with job repos, every repo is checked first, then each non-verify-only member's branch is pushed and its PR opened or updated (result: repos) in dependency order before the root PR; a repo an interim strategy holds back is not pushed (result: deferred; docs/CONFIG.md "Interim strategies")

| Flag | Meaning |
|---|---|
| `--draft` | open it as a draft |
| `--force` | publish a HEAD that forge verify has not passed |
| `--title T` | the PR title (default: the job title) |

| Exit | When |
|---|---|
| 1 | no such job or worktree, an unverified HEAD (of any job repo), nothing to push (in any job repo), no GitHub slug for a member repo, a likely secret in a PR title or body or the commits it would push (code secret_found), an interim pin that cannot be written, or one that is not the dependency's checked HEAD (code interim_stale) |
| 5 | gh or git failed |

**`forge pr ready <id> [--repo NAME | --root]`**: mark the job's open draft PRs ready for review, in merge order (result: ready and skipped); a consumer held by a local or sequential interim edge stays a draft until a human records its dependency's release (forge job interim release), and a consumer with a recorded release until verify bumped its manifests to it

| Flag | Meaning |
|---|---|
| `--repo NAME` | only that member repo PR |
| `--root` | only the root repo PR |

| Exit | When |
|---|---|
| 1 | no such job, --repo names no PR member, --repo and --root together, --root given a value, or a targeted PR's release gate is held or bump-due, or its manifests at HEAD don't name the recorded release (code release_gate; nothing is called) |
| 5 | gh or git failed |

**`forge pr sync <id>`**: read the PR's state, checks and review feedback into the job; each member repo PR's state and checks are read first, and the job is done only when every PR merged; a multi-repo job's PR bodies get their sibling links

| Exit | When |
|---|---|
| 1 | no such job |
| 5 | gh or git failed |

### `forge release`

Plan and run a release of the root repo and its member repos.

**`forge release plan [--job ID | --since TAG] [--force]`**: plan a release from each repo's release strategy, dependencies first: write .forge/runtime/release/release.md (steps, checks and rollback) and release.json; nothing runs. With --job, the job's PRs must be merged, except a consumer of an interim edge, which is skipped (it merges after its dependencies' release); the plan logs release-planned and, when the Foreman decides the release gate class, queues its gate request, and approval says who owns the publish decision

| Flag | Meaning |
|---|---|
| `--force` | discard an unfinished run's checkpoints (not in a daemon session) |
| `--job ID` | release the job's merged PR repos; an unmerged consumer of an interim edge is skipped |
| `--since TAG` | release the repos with commits since TAG |

| Exit | When |
|---|---|
| 1 | config problems, an unmerged PR that is no interim consumer, no merged PR at all (--job), an unusable member clone (--job), no repo with the tag, a build cycle, an unfinished run of another plan, a symlinked release dir, or --force in a daemon session |

See [Releasing a project](RELEASES.md#releasing-a-project).

**`forge release run`**: run the plan step by step, checking each, with checkpoints so a second run resumes at the first step not done; a step whose check already passes is skipped, and publish steps ask on a terminal unless the repo sets release.publish: allow, and without a terminal they run only when the Foreman approved this exact plan (approvedBy: foreman). On a --job plan, each dependency repo whose last step finished in this run gets its release recorded on the job from the checks of this run (released: version, recorded, and a hint when no single version showed), which resumes the job to bump its consumers. Prints its own result

| Exit | When |
|---|---|
| 1 | stopped at a step (the result says why), no plan, a stale or edited plan, a symlinked release dir, a daemon session, or native Windows |
| 3 | another forge release run holds the lock |

See [Releasing a project](RELEASES.md#releasing-a-project).

**`forge release status`**: the plan's progress: each step's status with the tags and versions its checks recorded, the next step, whether config or the repos have moved since planning, and the publish approval (owner, pending or approved)

See [Releasing a project](RELEASES.md#releasing-a-project).

### `forge requests`

The dashboard's inbox of requests for an orchestrator session.

**`forge requests ack <id> [--status done|rejected] [--result R]`**: mark a request handled

| Flag | Meaning |
|---|---|
| `--result R` | one line on what happened |
| `--status S` | done (default) or rejected |

| Exit | When |
|---|---|
| 1 | no such request, or one outside this daemon session's scope |

**`forge requests add <type> [--job ID] [--text T] [--intake run|next|new] [--session S]`**: queue a request; a resume hand-off also releases the claim of the session handing off

| Flag | Meaning |
|---|---|
| `--intake run\|next\|new` | with resume: how the job starts |
| `--job ID` | the job it is about |
| `--session S` | with resume: the session handing the job off |
| `--text T` | its text |

| Exit | When |
|---|---|
| 1 | a gate request (only the CLI writes those), a daemon session queued anything but resume, or its scope is invalid |

**`forge requests claim <id> --session S [--force]`**: claim a request before handling it

| Flag | Meaning |
|---|---|
| `--force` | take it from a live session |
| `--session S` | the claiming session (required) |

| Exit | When |
|---|---|
| 1 | no such request, or one outside this daemon session's scope |
| 3 | another live session is handling it |

**`forge requests list [--all]`**: pending requests (`forge requests` alone does the same); in a daemon session, only its scope's. First returns to pending any in-progress request whose session is gone (its job lease expired, or its claim is 30 minutes old); one orphaned twice is rejected

| Flag | Meaning |
|---|---|
| `--all` | include handled requests |

| Exit | When |
|---|---|
| 1 | a daemon session's scope is invalid |

**`forge requests scope`**: which session this is: not a daemon, the inbox, the office, or one job

| Exit | When |
|---|---|
| 1 | a daemon session's scope is invalid |

### `forge retro`

Retrospectives over finished jobs.

**`forge retro due`**: whether a retro is due: improve.retroEvery jobs finished since the last one

**`forge retro prepare <job> [--since DATE]`**: gather metrics, human interventions and review history into the retro job's dir, including learnings past their review-by

| Flag | Meaning |
|---|---|
| `--since DATE` | only jobs since DATE (default: since the last retro) |

| Exit | When |
|---|---|
| 1 | no such job |

### `forge roster`

The agent roster.

**`forge roster`**: each role's agent prompt, model, effort and prompt hash, plus the learning count and oldest review-by

### `forge run`

Run a configured command in a job's worktree.

**`forge run <id> <command> [--repo NAME] [--background] [--tail N] [-- <args…>]`**: run commands.&lt;command> in the job's worktree, logging its output to the job dir and printing the tail

| Flag | Meaning |
|---|---|
| `-- <args…>` | quoted arguments, placed at {args} in the template or appended |
| `--background` | start it detached (dev servers); stop it with forge stop |
| `--repo NAME` | run the command of member repo NAME's one component that defines it, in that member's worktree (not with --background) |
| `--tail N` | print the last N lines (default 40) |

| Exit | When |
|---|---|
| 1 | the command failed, is not configured (for --repo: no component of that repo, or several, define it), or the job has no worktree |

### `forge secrets`

Scan for likely credentials before anything leaves the machine.

**`forge secrets check [<name>...]`**: resolve each named secret (every declared one by default) from its source and report ok or the error; never prints a value or its length

| Exit | When |
|---|---|
| 1 | a secret failed to resolve |

**`forge secrets list`**: the declared secret references (`secrets` in .forge/config.yml): each name and its source kind, resolving nothing

**`forge secrets scan [<id> | --paths <globs>]`**: report likely credentials, masked with their fingerprints: a job's commits, commit messages, net diff, staged changes and PR title and body, or the main checkout's tracked files matching the globs; prints text (--json for the full result)

| Flag | Meaning |
|---|---|
| `--paths <globs>` | scan the main checkout's tracked files matching these globs (comma-separated or repeated) instead of a job |

| Exit | When |
|---|---|
| 1 | a finding, an incomplete scan, or no such job or worktree |
| 5 | git failed |

### `forge stats`

Pipeline metrics: quality, speed and cost.

**`forge stats [--since DATE] [--include-evals] [--json] | --by prompt [--role R] [--since DATE] [--include-evals] | --csv [--since DATE] [--by job|role|model|day]`**: pipeline metrics: review and verify first-pass rates, per-lens change, dispute and miss rates, recurring findings, escalations, time to PR, tokens and cost (a text summary, or the full object with --json); --by prompt groups jobs into prompt cohorts

| Flag | Meaning |
|---|---|
| `--by K` | with --csv: one row per job (default, keyed job,kind,title), role, model or day; `prompt` (JSON only): one cohort per prompt hash the role last started on, each with its own stats |
| `--csv` | spend as RFC 4180 CSV with CRLF line ends: key columns, then runs,tokens,input,output,cache_read,cache_write,usd; with it, --since keeps events at or after DATE |
| `--include-evals` | count eval jobs too (--csv always counts every job) |
| `--role R` | with --by prompt: the agents/\*.md role or reviewer:&lt;lens> whose starts key the cohorts (default builder) |
| `--since DATE` | only jobs created on or after DATE |

See [Repo budget](CLI.md#repo-budget).

### `forge status`

Active jobs at a glance.

**`forge status [--all]`**: active jobs at a glance: a text table, or with --json one row per job

| Flag | Meaning |
|---|---|
| `--all` | include finished and cancelled jobs |

### `forge stop`

Stop a job's background command.

**`forge stop <id>`**: stop the command forge run --background started for the job

### `forge sync`

Reconcile PRs and trackers for all jobs.

**`forge sync`**: reconcile PRs and trackers for every job, measure merged jobs' outcomes (revert, follow-up bugs, churn; at most 10 per run), queue a post-merge judge score run for sampled merged jobs (scoring.sample; at most 5 per run), retarget stacked PRs, release dependency waits and finish umbrella jobs; a job's failure is reported in its result. Then the reconciler's pass, unless a running forge dash owns it: `reconcile` lists the running jobs it resumed or escalated for having nothing to drive them, and the requests it requeued

### `forge tracker`

The configured issue tracker (tracker.kind): items, claims, comments.

**`forge tracker claim <ref> <job>`**: mark an item as taken by a job

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

**`forge tracker close <ref> [--reason R]`**: close an item

| Flag | Meaning |
|---|---|
| `--reason R` | why, where the tracker records one |

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

**`forge tracker comment <ref> [--body B | --body-file F]`**: comment on an item

| Flag | Meaning |
|---|---|
| `--body B` | the text |
| `--body-file F` | read the text from F (- for stdin) |

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

**`forge tracker create --title T [--body B | --body-file F] [--label L]... [--parent REF]`**: create an item

| Flag | Meaning |
|---|---|
| `--body B` | the text |
| `--body-file F` | read the text from F (- for stdin) |
| `--label L` | a label (repeatable, or comma-separated) |
| `--parent REF` | the parent item |
| `--title T` | the title (required) |

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

**`forge tracker get <ref>`**: one tracker item

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

**`forge tracker list [--ready] [--limit N]`**: tracker items, without bodies

| Flag | Meaning |
|---|---|
| `--limit N` | at most N items (0: no limit) |
| `--ready` | only items ready to start |

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

**`forge tracker search <query> [--limit N] [--job <id>]`**: search the tracker

| Flag | Meaning |
|---|---|
| `--job <id>` | search for the words of a job's title |
| `--limit N` | at most N items (default 5, at most 20) |

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

See [Linking jobs to issues](TRACKERS.md#linking-jobs-to-issues).

**`forge tracker triage [--limit N] [--all] | --apply <batch>`**: readiness triage: write a batch of ready and needs-info items for the forge:triage agent, then apply its verdicts (a templated comment and the needs-info mark, or the mark cleared)

| Flag | Meaning |
|---|---|
| `--all` | also judge items unchanged since their last triage |
| `--apply <batch>` | apply the batch's verdicts.json |
| `--limit N` | at most N ready and N needs-info items (default 10, at most 50) |

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

See [Readiness triage](TRACKERS.md#readiness-triage).

**`forge tracker update <ref> <job>`**: mirror a job's status to its item

| Exit | When |
|---|---|
| 1 | the tracker refused the call, no such item or job, or a likely secret in the text Forge would send (code secret_found) |
| 5 | gh failed (GitHub tracker) |

### `forge update`

Update this Forge install (Claude Code plugin or git clone).

**`forge update [--check] [--keep-dash]`**: update this Forge install (plugin or clone) and restart this repo's dashboard on the new code

| Flag | Meaning |
|---|---|
| `--check` | print the install, the commands an update would run and anything blocking it, changing nothing |
| `--keep-dash` | don't restart the dashboard |

| Exit | When |
|---|---|
| 1 | the install is unknown or blocked (a clone with local changes, no upstream, a detached HEAD), a daemon session asked, or it runs on native Windows |
| 5 | a step it ran (claude or git) failed |

See [Updating](../README.md#updating).

### `forge verifiers`

Narrow yes/no checks between verify and the review panel.

**`forge verifiers list`**: the main checkout's .forge/verifiers/\*.md that will run, and the problems that keep the others from running

See [Verifiers](VERIFIERS.md).

**`forge verifiers record <id>`**: turn the verifier agent's answers into verify/round-&lt;n>-verifiers.md; a block-mode NO (or no valid answer) whose severity is in review.blockOn fails the round's verify

| Exit | When |
|---|---|
| 1 | no such job, or no pending verifiers run in its round |
| 5 | git failed |

**`forge verifiers run <id>`**: select the verifiers whose paths match the diff of the commit the round's passing verify checked, and write the verifier agent's input; with none selected, write the PASS report straight away

| Exit | When |
|---|---|
| 1 | no such job, no worktree, or no passing verify in the job's round |
| 5 | git failed |

### `forge verify`

Run the verify commands on a job's worktree.

**`forge verify <id>`**: run the configured verify commands in the job's worktree and record the result for its HEAD

| Exit | When |
|---|---|
| 1 | a check failed (the result says which), or the job has no worktree |

### `forge version`

This install's version.

**`forge version [--json]`**: print {version}; --json adds commit, installedAs and node

| Flag | Meaning |
|---|---|
| `--json` | print {version, commit, installedAs, node}: commit from a release archive's COMMIT file, the plugin install record or git, else null |

### `forge worktree`

A job's git worktree.

**`forge worktree create <id>`**: create the job's worktree and branch (stacked on its one unmerged dependency, if any) bring its backing services up (a failed one skips setup and fails the result, listed as backing), and run worktrees.setup there; with worktrees.seed and matching key files it clones the seed and runs seed.setup instead of worktrees.setup, listed as seed; then each missing member repo worktree (forge job repo add) on the job's branch, or detached at its base for a verify-only repo; with members, the result lists them as repos

| Exit | When |
|---|---|
| 1 | no such job, an unsafe branch name, no free port, a member repo worktree that could not be created (the result names it), or the inbox or office daemon session ran it |
| 5 | git failed |

**`forge worktree path <id> [--repo NAME]`**: the worktree's path, or member repo NAME's (empty when it has none)

| Flag | Meaning |
|---|---|
| `--repo NAME` | member repo NAME's worktree |

| Exit | When |
|---|---|
| 1 | no such job |

**`forge worktree prune`**: prune git's records of worktrees that are gone

| Exit | When |
|---|---|
| 5 | git failed |

**`forge worktree remove <id> [--repo NAME] [--delete-branch] [--force]`**: remove the job's worktree and every member repo worktree, or with --repo only that member's; without --repo also its per-job backing containers and volumes (listed as backing)

| Flag | Meaning |
|---|---|
| `--delete-branch` | delete the job's branch too (not in a verify-only repo) |
| `--force` | remove it with uncommitted changes |
| `--repo NAME` | only the worktree of member repo NAME |

| Exit | When |
|---|---|
| 1 | no such job or repo, a member worktree that could not be removed (the result names it), or a backing teardown that failed (backing.json is kept for a retry) |
| 5 | git failed |
<!-- forge:cli:end -->
