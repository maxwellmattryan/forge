# The forge CLI

The orchestrator, its agents, scripts, CI and other agent runtimes ([PROTOCOL.md](PROTOCOL.md)) all read and change Forge state through `forge`. This page is its contract: what it prints, how it fails, which environment variables it reads, and what stays stable across releases. `forge help` lists the commands, and `forge help <command>` gives one command's flags and exit codes.

## Output

- Success prints one compact JSON value and a newline on stdout. `--pretty` indents it, and `forge doctor` and `forge config show` always indent.
- A few commands print text instead: `forge status` (a table), `forge stats` (a summary), `forge secrets scan` (a report), `forge help`, and the string results of `forge worktree path`, `forge worktree prune`, `forge job get`, `forge config get` and `forge daemon log`. Under `--json` all of them print JSON (see below).
- An error prints exactly `forge: <message>` on stderr, nothing on stdout, and exits with its code from the tables below. `FORGE_DEBUG=1` adds the stack trace on stderr.
- These commands report a failure in their own result instead of an error, and exit 1: `verify`, `run`, `integrate`, `pr merge`, `job advance`, `config validate`, `secrets scan` (a finding) and `update`.
- `forge git diff|log|show|range-diff` pass git's stdout, stderr and exit code through once git runs.

## `--json`

`--json`, `--help` and `--pretty` work on every command and take no value: they never swallow the next argument, so `forge --json job list` is `forge job list --json`. Only tokens before the first `--` count; everything after it is a path.

With `--json`:

- **Success**: stdout is exactly one JSON value plus a newline. Results that are strings print JSON-encoded (`forge worktree path <id> --json` prints `"/path/to/worktree"`). `forge status --json` prints one row per job, `[]` when nothing is active, with the same `--all` filter:

  ```json
  [{"id":"add-login","stage":"build","state":"running","waitingOn":null,"round":1,"tasks":{"done":3,"total":7},"pr":null,"session":"9b2f…"}]
  ```

  `pr` is the PR number or `null`, and `session` the owner's full session id or `null`. `forge stats --json` prints the full stats object, and `forge help … --json` the help tables (see Help).
- **Errors**: stdout gets exactly one line and stderr nothing (`FORGE_DEBUG` still writes the stack to stderr):

  ```json
  {"error":{"code":"usage","message":"missing --session","exit":2,"hint":"forge help job claim"}}
  ```

  `code` is one of the error codes below, `exit` equals the process exit code, and `hint` is a command to run next or `null`: for `usage`, the help for the longest known prefix of the call (`forge job claim x --json` with no `--session` gives `forge help job claim`); for `unknown_command`, `forge help`; for `not_initialized`, `/forge init`. The message is data, so it may quote tracker or PR text; JSON encoding keeps it on the one line.
- **Streams that stay text**: `forge dash` in the foreground (its banner line), `forge daemon log --follow` (its lines) and `forge git diff|log|show|range-diff` (git's output). An error in any of them is still reported as the JSON error line.
- **`forge git`**: a `--json` before `--` is Forge's flag and never reaches git, so `forge git log --json --output=x` is refused like `forge git log --output=x`. `forge git add|commit` accept it and print their result. `forge git <sub> --help` prints Forge's help and never starts git.

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
| owned | 3 | the job or request is held by another live session, or a tracker claim was lost to another job |
| blocked | 4 | the job's dependencies are not done |
| external | 5 | a tool Forge runs failed to start or exited non-zero: git, gh, claude |

The exceptions:
- `verify`, `run`, `integrate`, `pr merge`, `job advance`, `config validate`, `secrets scan` and `update` print their own result when they fail, and exit 1. `secrets scan` fails on any finding; a scan that cannot finish is an error. `forge job advance` exits 3 when it refuses a job its session does not hold, and 1 when a command it ran failed, whatever that command's own exit would have been.
- `forge git diff|log|show|range-diff` exit with git's own code once git runs.
- The no-AI-attribution hook's exit 2 belongs to Claude Code's hook protocol, not this table.

## Error codes

Every error carries one of these codes, and the code fixes the exit.

| Code | Exit | Meaning |
|---|---|---|
| `failed` | 1 | the default for exit 1: the command ran and failed, or refused by policy |
| `not_found` | 1 | no such job or request |
| `internal` | 1 | not a Forge error: a bug or an unexpected Node error (rerun with `FORGE_DEBUG=1` for the stack) |
| `secret_found` | 1 | the secret scanner found a likely credential in what Forge was about to commit or send (a commit, the PR title or body, a tracker write); the message shows it masked, with its fingerprint |
| `protected_path` | 1 | a path the `policy.protectedPaths` policy refuses is in what `forge git add\|commit` would stage or commit, `forge pr open` found a refused path or escalate paths no human approved, or `forge pr merge` found a PR head `forge pr open` never checked (docs/CONFIG.md "Protected paths") |
| `usage` | 2 | the default for exit 2: the call could not be parsed; the hint names the help to read |
| `unknown_command` | 2 | the first word is not a command |
| `not_initialized` | 2 | the repo has no `.forge/config.yml`; run `/forge init` |
| `not_a_repo` | 2 | not inside a git repository, and `FORGE_ROOT` is unset |
| `config_invalid` | 2 | `.forge/config.yml` cannot be parsed, or `forge init write` would write an invalid one |
| `owned` | 3 | another live session holds the job or request, or a tracker claim was lost |
| `blocked` | 4 | the job's dependencies are not done (`--force` claims anyway) |
| `external` | 5 | git, gh or claude failed to start or exited non-zero |

## Help

- `forge help`, `forge --help` and `forge` alone print the overview: one line per command group, the global flags and the exit codes.
- `forge help <group>` or `forge <group> --help` lists the group's commands, their arguments and what each does.
- `forge help <group> <sub>`, `forge <group> <sub> --help` and `forge <group> <sub> <id> --help` print one command's usage, flags and exit codes.
- Help works before `.forge/config.yml` exists and outside any git repository. A first word that is not a command exits 2 (`unknown_command`); a second word that is not a subcommand shows the group's help.
- `--json` prints the tables instead: `{"version", "groups"}` for the overview, the group for a group, and `{"command", "args", "summary", "flags", "exits", "docs"}` for a command.

The tables live beside each command module as `HELP` (`lib/commands/<group>.ts`; the commands `lib/cli.ts` routes itself are in `lib/commands/help.ts`). They also build every `usage:` error and README's CLI table: `npm run docs:commands` regenerates it.

## Environment variables

Read by Forge:

| Variable | Effect |
|---|---|
| `FORGE_ROOT` | the main checkout Forge keeps its state in; without it, the checkout of the current directory's git repository |
| `FORGE_CACHE_DIR` | where `bin/forge` keeps its start-up cache (V8 code cache, and stripped modules on Node 22); default `.cache/` in the plugin root. It must be private to the current user, and no easier to write than the plugin itself, since it holds code the CLI runs (ARCHITECTURE.md "Start-up cache") |
| `NODE_DISABLE_COMPILE_CACHE` | any non-empty value turns the start-up cache off |
| `FORGE_DEBUG` | any non-empty value prints an error's stack trace on stderr, with or without `--json` |
| `FORGE_AI_ATTRIBUTION` | `allow` turns the no-AI-attribution policy off for the hook, `forge git commit`, `forge pr open` and the GitHub tracker |
| `GH_HOST` | a GitHub Enterprise host whose issue URLs count as the configured repo's, besides github.com |
| `SHELL` | the shell configured commands run in (`$SHELL -lc`; `/bin/sh` when unset): `forge run`, `forge verify`, worktree setup and eval checks |
| `PATH` | where git, gh, claude and node are found |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` | `forge dash` leaves them out of daemon sessions' environment unless `daemon.auth: api-key` |
| `GIT_CONFIG_COUNT` | daemon sessions append their git pins after the entries already counted |
| `CLAUDE_CONFIG_DIR` | Claude Code's own config dir: transcripts are read from `$CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`, by `forge job agent … end --import` and the dashboard's agent activity and transcript views |
| `CLAUDE_ENV_FILE` | set by Claude Code for SessionStart hooks; the plugin's hook appends a line that puts this plugin's `bin/` first on PATH for the session's Bash commands; nothing happens when it is unset |
| `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR` | cleared before `forge git add\|commit` (with `GIT_OBJECT_DIRECTORY` and `GIT_NAMESPACE`) and eval checkouts run git, so an inherited one can't point git at another repository |

Set by the `forge dash` supervisor for daemon sessions, never by hand:

| Variable | Effect |
|---|---|
| `FORGE_DAEMON` | `1` in a headless session: the config trust check runs first, config rewrites and job effort changes (`forge job effort`, `forge job new --effort`) are refused, and `forge requests` sees only the session's scope |
| `FORGE_DAEMON_SCOPE` | the session's scope: `_inbox`, `_office` (the foreman), or the id of the job it drives |
| `FORGE_DAEMON_TRUST` | the digest of the checkout path, `.forge/config.yml` and `.forge/trackers/` the human started the daemon with; `forge` refuses to run when they no longer match |

Set by Forge for configured commands (`forge run`, `forge verify`, worktree setup), which never see the daemon variables above:

| Variable | Effect |
|---|---|
| `FORGE_JOB` | the job id |
| `FORGE_WORKTREE` | the job's worktree |
| `FORGE_PORT`, `PORT` | the job's port, empty when it has none |

## Agent ids

`forge job agent <id> attach --role R --agent-id A` records the runtime's id of an agent that is already `running` (the orchestrator runs it right after a background spawn), so `forge dash` can follow that agent's transcript while it works. It changes nothing else: `runs`, `startedAt` and `status` stay, and no event is logged. It prints `{ "role", "status", "agentId" }`, exits 1 when the role isn't running, and exits 2 (`usage`) without writing anything when `A` doesn't match `^[A-Za-z0-9_-]{1,100}$`, since the id becomes part of a transcript's file name.

## Foreman decisions

`forge job human <id> <action> [--actor human|foreman]` records who decided. Without `--actor` the event says `actor: "human"`. `--actor foreman` is accepted only from the office daemon session (`FORGE_DAEMON_SCOPE=_office`), which in turn must pass it, and only after the authority checks in docs/ARCHITECTURE.md "Foreman": the job waits on a gate class in `foreman.decides`, the action belongs to that class, `--note` is given and no reserved pattern matches (nor a latest security verdict other than `PASS`), a pr-feedback `rework` has a queued gate request for the PR's current head, and there is no `--link` or `--reason`. A refusal exits 1 and writes nothing.

`forge job assist <id> --gate <class>` is read-only and returns `{gate, stale, reserved, model, effort, subagent, brief}`: the `forge:assistant` spawn for that gate, with a brief of paths only. `stale: true` means the job no longer waits on that gate, and `reserved` is re-checked at call time. An unknown `--gate` exits 1, and so does a daemon session other than the office. `forge requests add gate` always exits 1: only `forge job set` and `forge pr sync` write gate requests.

## Stability

Forge follows semver for this contract. Any release may add commands, flags, JSON fields, error codes and environment variables. Renaming or removing a JSON field, an error code or an exit number is a breaking change: it ships only in a release whose version says so (a new major version, or a new minor version while Forge is below 1.0) and is called out in [CHANGELOG.md](../CHANGELOG.md). Message and hint text, and the order of JSON keys, are not covered: match on `code` and `exit`, never on `message`. `test/cli-contract.test.ts` pins the JSON keys of `forge job list|show|step`, `forge status --json`, `forge verify`, `forge stats --json` and `forge version --json` (`version`, `commit`, `installedAs`, `node`), so an accidental rename fails the build.
