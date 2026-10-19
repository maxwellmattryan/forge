# The forge CLI

The orchestrator, its agents, scripts, CI and other agent runtimes ([PROTOCOL.md](PROTOCOL.md)) all read and change Forge state through `forge`. This page is its contract: what it prints, how it fails, which environment variables it reads, and what stays stable across releases. `forge help` lists the commands, and `forge help <command>` gives one command's flags and exit codes.

## Output

This section and the next describe **agent mode**, the output every program gets: a pipe, a file, `$(…)`, Claude Code's Bash tool and daemon sessions. A person at a terminal gets human mode instead (see Output mode).

- Success prints one compact JSON value and a newline on stdout. `--pretty` indents it, and `forge doctor` and `forge config show` always indent.
- A few commands print text instead: `forge status` (a table), `forge stats` (a summary), `forge secrets scan` (a report), `forge help`, and the string results of `forge worktree path`, `forge worktree prune`, `forge job get`, `forge config get` and `forge daemon log`. Under `--json` all of them print JSON (see below).
- An error prints exactly `forge: <message>` on stderr, nothing on stdout, and exits with its code from the tables below. `FORGE_DEBUG=1` adds the stack trace on stderr. Human mode prints `error:` and `fix:` lines instead.
- These commands report a failure in their own result instead of an error, and exit 1: `verify`, `run`, `integrate`, `pr merge`, `job advance`, `config validate`, `secrets scan` (a finding) and `update`.
- `forge git diff|log|show|range-diff` pass git's stdout, stderr and exit code through once git runs.

## Output mode

Every call runs in one of two output modes. **Agent** mode is the contract on this page, byte for byte. **Human** mode renders the same results and errors as text for a person at a terminal. The mode is decided once per call, and the first rule that applies wins:

1. A bare `--json` before `--` gives agent mode, even with `--mode human`.
2. `--mode human` or `--mode agent` (also `--mode=<v>`) before `--`.
3. `FORGE_MODE=human` or `FORGE_MODE=agent`. An empty value counts as unset.
4. Human when stdout is a terminal, else agent.

A `--mode` with no value, a repeated `--mode`, or an unknown value of `--mode` or `FORGE_MODE` is a `usage` error (exit 2), even under `--json`: `forge --mode job-12` is refused, never read as help.

Human mode:

- **Strings** print raw, exactly as in agent mode: help, the `status` table, the `stats` summary, `worktree path`, `config get` strings. `$(forge worktree path <id>)` is the same in both modes.
- **Other results** go through a generic renderer, and `--pretty` has no effect. An object prints one aligned `key  value` line per key (`(empty)` for `{}`). An array of objects prints a table whose columns are the union of the rows' keys, in first-seen order. Any other array prints one item per line (`(none)` when empty). `null` prints `-`, a list of scalars is joined with `, `, and a nested object or array is shown as one-line JSON, never truncated.
- **Control characters** in rendered keys, values, cells and error messages are shown as visible escapes (`\x1b`, `\u202e`), so text from trackers, PRs or job state can't move the cursor, rewrite lines or set the clipboard. Raw strings are not touched.
- **Errors** print on stderr, nothing on stdout: `error: <message>`, then `fix: <hint>` when the error has a hint (the `hint` `--json` reports). The exit code is unchanged, and `FORGE_DEBUG` still adds the stack.
- **Colour**: keys and table headers are bold, `true` green, `false` red, `error:` red and `fix:` yellow. Colour is on only when the stream is a terminal and `NO_COLOR` is unset or empty.
- Streams that write for themselves are the same in both modes: `forge dash` in the foreground, `forge daemon log --follow` and the `forge git diff|log|show|range-diff` passthrough.

Agent mode is pinned wherever Forge or Claude Code start the CLI: the plugin's SessionStart hook writes `export FORGE_MODE=agent` to `CLAUDE_ENV_FILE` (every Bash command of a Claude Code session, even under a PTY), `forge dash` sets `FORGE_MODE=agent` for daemon sessions, and the test suite sets it in `test/helpers.ts`. A script that might run on a terminal should pass `--json` or set `FORGE_MODE=agent`.

## `--json`

`--json`, `--help` and `--pretty` work on every command and take no value: they never swallow the next argument, so `forge --json job list` is `forge job list --json`. `--json` selects agent mode. `--mode human|agent` works on every command too, but takes a value: it is accepted anywhere before `--` and removed before the command sees its arguments, so `forge job show --mode human <id>` shows `<id>`. Only tokens before the first `--` count; everything after it is a path.

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
| owned | 3 | the job or request is held by another live session, or a tracker claim was lost to another job |
| blocked | 4 | the job's dependencies are not done, or the repo budget (`budget:`) holds new work: `forge job claim` parked the job, or `forge job from-ref` started nothing |
| external | 5 | a tool Forge runs failed to start or exited non-zero: git, gh, claude, docker |

The exceptions:
- `verify`, `run`, `integrate`, `pr merge`, `job advance`, `config validate`, `secrets scan` and `update` print their own result when they fail, and exit 1. `secrets scan` fails on any finding; a scan that cannot finish is an error. `forge job advance` exits 3 when it refuses a job its session does not hold, and 1 when a command it ran failed, whatever that command's own exit would have been.
- `forge git diff|log|show|range-diff` exit with git's own code once git runs.
- `forge release run` prints its own result and exits 1 when it stops at a step (the result's `stopped` says why), and exits 3 (`owned`) while another `forge release run` holds the release lock.
- `forge backing up|down|status` exit 5 (`external`) when Docker is missing, its daemon is stopped or a docker command fails (for `up`, also a same-named container that isn't this job's); `status <job>` still exits 0 and reports `unknown`. `forge worktree remove` exits 1 when its backing teardown fails (docs/CONFIG.md "Backing services").
- `forge focus <id>|--clear` exits 1 when a configured checkout step fails (docs/CONFIG.md "Checkout steps"): the message names the step, why it failed and its log, and focus is unchanged.
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
| `interim_stale` | 1 | `forge pr open` found a git-ref or canary pin in the checked commits that is not the dependency's checked HEAD (a hand-edited pin, or a dependency that moved without a verify), or, after a recorded release, a consumer manifest that does not name the released version yet; the hint is `forge verify <id>` (docs/CONFIG.md "Interim strategies") |
| `release_gate` | 1 | `forge pr ready` targeted a consumer PR whose local or sequential dependency's release is not recorded (a human runs `forge job interim release <id> <name>\|--root <version>`), or whose manifests don't name a recorded release yet (gate `bump-due`, or a HEAD that doesn't carry it: run `forge verify <id>`, then `forge pr open <id>`); nothing was called (docs/CONFIG.md "Interim strategies") |
| `usage` | 2 | the default for exit 2: the call could not be parsed; the hint names the help to read |
| `unknown_command` | 2 | the first word is not a command |
| `not_initialized` | 2 | the repo has no `.forge/config.yml`; run `/forge init` |
| `not_a_repo` | 2 | not inside a git repository, and `FORGE_ROOT` is unset |
| `config_invalid` | 2 | `.forge/config.yml` cannot be parsed, or `forge init write` would write an invalid one |
| `owned` | 3 | another live session holds the job or request, or a tracker claim was lost |
| `blocked` | 4 | the job's dependencies are not done (`--force` claims anyway), or the repo budget holds new work (the message is the `repo budget: …` reason; a human runs `forge budget ack`) |
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
| `FORGE_MODE` | `human` or `agent`: the output mode when neither `--json` nor `--mode` is given (see Output mode); empty counts as unset, any other value is a usage error. The SessionStart hook and daemon sessions set it to `agent` |
| `NO_COLOR` | any non-empty value turns colour off in human mode |
| `FORGE_AI_ATTRIBUTION` | `allow` turns the no-AI-attribution policy off for the hook, `forge git commit`, `forge pr open` and the GitHub tracker |
| `FORGE_ACTOR` | the login human-action events record (`actor: { login, source: "env" }`), ahead of `gh`, `git config user.email` and the OS user; ignored inside daemon sessions, which record the dashboard's OS user. Sanitised to `[A-Za-z0-9 ._@+-]`, at most 100 characters, and unauthenticated (ARCHITECTURE.md "Audit trail") |
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

Set by Forge for configured commands (`forge run`, `forge verify`, worktree setup), which never see the daemon variables above:

| Variable | Effect |
|---|---|
| `FORGE_JOB` | the job id |
| `FORGE_WORKTREE` | the job's worktree |
| `FORGE_PORT`, `PORT` | the job's port, empty when it has none |
| `FORGE_CARGO_CONFIG` | `forge run` and `forge verify` steps only, when the repo the command runs in has an active cargo local link: the absolute path of the rendered `cargo-links.toml`, for a command that calls cargo by absolute path (see Local links) |
| `FORGE_CMAKE_ARGS` | the same, when the repo declares a cmake local link: the `-DFETCHCONTENT_SOURCE_DIR_<NAME>=<dir>` / `-U…` arguments as single-quoted shell words |
| `FORGE_BACKING_<NAME>_HOST` | per `backing:` entry (prefix `FORGE_BACKING_`, `NAME` upper-cased with `-` as `_`), when the job's services were brought up: `127.0.0.1`; not set for an external entry (docs/CONFIG.md "Backing services") |
| `FORGE_BACKING_<NAME>_PORT`, `FORGE_BACKING_<NAME>_PORT_<containerPort>` | the host port of the entry's first container port, and of each one |
| `FORGE_BACKING_<NAME>_URL` | the external entry's `url`, or the managed entry's `url` template filled with `{host}`, `{port}` and `{port_<n>}`; unset without a `url` |

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

`forge job human <id> <action> [--actor human|foreman]` records who decided. Without `--actor` the event's `actor` is the resolved person, `{ "login": "<login>"|null, "source": "env"|"gh"|"git"|"os"|"dashboard"|"unknown" }` (ARCHITECTURE.md "Audit trail"); with `--actor foreman` it is `{ "login": null, "source": "foreman" }`. Events written before event schema v2 said `"human"` or `"foreman"`, and read as source `unknown` and `foreman`. `--actor foreman` is accepted only from the office daemon session (`FORGE_DAEMON_SCOPE=_office`), which in turn must pass it, and only after the authority checks in docs/ARCHITECTURE.md "Foreman": the job waits on a gate class in `foreman.decides`, the action belongs to that class, `--note` is given and no reserved pattern matches (nor a latest security verdict other than `PASS`), a pr-feedback `rework` has a queued gate request for the PR's current head, and there is no `--link` or `--reason`. A refusal exits 1 and writes nothing.

`forge job assist <id> --gate <class>` is read-only and returns `{gate, stale, reserved, model, effort, subagent, brief}`: the `forge:assistant` spawn for that gate, with a brief of paths only. `stale: true` means the job no longer waits on that gate, and `reserved` is re-checked at call time. An unknown `--gate` exits 1, and so does a daemon session other than the office. `forge requests add gate` always exits 1: only `forge job set` and `forge pr sync` write gate requests.

## Merging

`forge pr merge <id> [--repo NAME | --root] [--now]` syncs first, then merges one PR at a time with exactly one `gh pr merge` call each: directly when checks pass or the repo has no CI, queued with `--auto` while checks are pending only when GitHub holds the PR and no protected-paths policy applies, deferred otherwise, and refused when checks fail. A single-repo job has one PR, and the result is `{ merged, autoMerge, action, checks, mergeState?, error? }` with `action` one of `already-merged`, `merged`, `auto`, `deferred`, `refused`, `failed`.

A job with a member repo that gets a PR merges its PRs in the order of the components' `dependsOn` (docs/ARCHITECTURE.md "Job repos"): a PR is merged, or queued with `--auto`, only when every PR it depends on is MERGED by this call's own sync. The walk goes on after a direct merge and stops at the first PR it queues, defers, refuses or fails to merge, so a consumer is never queued while a dependency is unmerged. `--repo NAME` merges only that member's PR and `--root` only the root's; either is refused while a PR it depends on is not merged, has no PR, or could not be read. The result adds `repo` (the PR acted on last, null for the root), `parts` (one `{ repo, number, action, checks, mergeState?, error? }` per PR acted on, in order) and, on an order refusal, `reason`: `order` when a dependency PR is not merged, `cycle` when the components' `dependsOn` form a cycle between the job's repos, which refuses every merge of the job. Both exit 1 with no `gh pr merge` call and log `pr-merge-refused` with that `reason`. `merged` is true only when every PR of the job is MERGED. `--now` bypasses CI and the head pin for each PR it merges, never the order. `--repo` with `--root`, `--repo` naming no PR member, and `--root` with a value (`--root <id>` swallows the id) exit 1.

## Next

`forge next [--claim --session S] [--force] [--limit N]` prints `{ item, more }` (`item` null when nothing is ready), plus `blocked` (`[{ ref, id, waitingOn }]`, items whose job waits on dependencies) when any. The ready list is the root tracker's items, then each [member repo tracker](TRACKERS.md#member-repo-trackers)'s in config `repos` order, each read with the same `--limit`. A member item's `ref` is `owner/name#N` and it adds `repo` (the member's name); a root item has no `repo` key. A member that could not be read (its clone fails doctor's member check, or its tracker call failed) is left out and listed in `skippedRepos: [{ repo, reason }]`, with `reason` at most 300 characters; the key is present only when a member was skipped, on every result shape (`item`, a started job, `resumed`). A root tracker failure exits 1 as before. With `--claim`, a member item starts its job through `forge job from-ref`, and the result is `{ id, ref: "owner/name#N", title, branch, repo }` plus `resumed`, `blocked`, `repoBudget` and `skippedRepos` where they apply.

## Audit trail

`forge job audit <id> [--json|--csv]` prints the job's audit rows in time order (ARCHITECTURE.md "Audit trail" says which events carry an actor). JSON, the default:

```
{ "id", "title", "pr": { "number": n|null, "mergeMethod": s|null, "merged": bool },
  "rows": [ { "ts", "job", "actor": { "login", "source" }|null, "action", "note": s|null, "detail": s|null } ] }
```

A row is an event with an actor (`action` is the `human` event's action, else the event type), a gate transition (`gate:<waitingOn>` into a wait, `gate-cleared:<waitingOn>` out of one, with the reason as `note`), `pr-opened`, or `pr-merged` / `pr-auto-merge`. `detail` is a one-line summary per type, and a member repo's merge rows start with the repo (`lib #7 squash`). `pr` is the root PR: `merged` counts only its merge.

`detail` per type: budget keys, the PR number and merge method, the linked ref, the permission tool and decision, the mode, a config key's change. An unknown job exits 1.

Archived jobs (`forge job archive`, `forge job prune`, `retention.jobsDays`) are included: their rows come from `.forge/archive/<id>.json`, plus an `archived` row (detail: the trigger) per job, and `forge job audit <id>` accepts an archived id.

`forge audit --since <date> [--until <date>] [--csv]` prints the same rows for every job and for the repo-level log (`.forge/runtime/audit.jsonl`, where `job` is null), with `since <= ts < until`, sorted by time then job id: `{ "since", "until", "rows" }`. A date is `YYYY-MM-DD` (UTC midnight) or a full ISO timestamp with its zone, and `--until` defaults to now. A missing or invalid date, or `--until` not after `--since`, exits 2 (`usage`).

`--csv` prints RFC 4180 CSV with the header `ts,job,actor,source,action,note,detail,pr,merge_method` and CRLF line ends. A field containing `,`, `"`, CR or LF is quoted with `"` doubled, and a cell starting with `=`, `+`, `-`, `@`, TAB or CR gets a leading `'` so a spreadsheet reads it as text. `--json` and `--csv` together exit 2.
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

`forge stats --csv [--since DATE] [--by job|role|model|day]` prints the same spend as RFC 4180 CSV with CRLF line ends: the key column(s) (`job,kind,title` for `--by job`, the default; else `role`, `model` or `day`), then `runs,tokens,input,output,cache_read,cache_write,usd` (`usd` with 4 decimals), sorted by key. `--since` (YYYY-MM-DD or a full ISO timestamp) keeps events at or after it. Every job counts, evals and retros included, so the totals match `forge budget`. Cells go through the same formula guard as `forge audit --csv`. `--csv` with `--json`, `--by` without `--csv`, or an unknown `--by` exits 2.

## Support bundle

`forge doctor --bundle [<job>] [--out <dir>] [--include-text]` writes `forge-support-<YYYY-MM-DD>.zip` (local date; `-2`, `-3`… when that name exists, never overwriting a file) to `--out` (default: the current directory, which must exist), mode `0600`. Settings › Diagnostics › **Download support bundle** in `forge dash` builds the same zip for every active job, never with text. The job can also come first: `forge doctor <job> --bundle`. Without a job, the bundle covers every active job and adds the inbox and office session logs. It works in a repo without `.forge/config.yml` (the config is then the defaults).

Before writing, stderr lists every entry with its size, any file it skipped and why, and the redaction counts. stdout is `{file, bytes, entries: [{name, bytes}], skipped: [{name, reason}], redactions: {secrets, paths, emails, logins}, includeText, jobs}`. It exits 0 once the file is written, even when doctor's checks fail, and 1 for an invalid or unknown job, a missing or non-directory `--out`, a write failure, or a daemon session (`FORGE_DAEMON=1`): the bundle is a human's report, not a pipeline step.

| Entry | Content |
|---|---|
| `manifest.json` | `{createdAt, forgeVersion, includeText, jobs, entries, skipped, redactions}` |
| `doctor.json` | what `forge doctor` prints |
| `versions.json` | `{forge, node, git, gh, glab, os}`; a missing tool is `null` |
| `config.json` | the effective config, with every value that names a command, path, URL or person, and every key Forge doesn't know, replaced by `<redacted>` (`CONFIG_DISCLOSURE` in `lib/config-fields.ts`) |
| `daemon/inbox.log`, `daemon/office.log` | without a job: the last 500 lines of the inbox and office session logs |
| `jobs/<id>/job.json`, `events.jsonl`, `step.json` | the job, every event, and what `forge job step` decides now |
| `jobs/<id>/verify/round-<n>.md` | the last 200 lines of the newest verify round |
| `jobs/<id>/logs/verify-<step>-<ts>.log` | the last 200 lines of the newest verify log per step, at most 20 |
| `jobs/<id>/daemon.log` | the last 500 lines of the job's daemon session log |
| `jobs/<id>/text/<path>.md`, `jobs/<id>/diff.patch` | with `--include-text` only: the job dir's markdown (not `verify/`) and the branch's net diff from its merge base |

Each entry keeps at most its last 2 MiB. Files are read without following symlinks or blocking on FIFOs, and only from inside the job dir or the runtime dir; anything else is listed under `skipped`. A file or directory name in the job dir made of anything but letters, digits, `.`, `_` and `-` (or `..`) is skipped as `<unsafe name>`, never shown raw, so no name can carry a terminal escape or a path out of the zip.

**Agent text stays out by default.** In `job.json`, `events.jsonl` and `step.json`, the string values of `title`, `reason`, `summary`, `note`, `text`, `body`, `brief`, `prompt`, `message`, `output`, `comment`, `description` and `report` become `<omitted: n chars>` (`error` stays). Daemon log lines are reduced to a skeleton: their structure, numbers and the strings of id, type, name and state keys stay, and every other string (prompts, replies, tool input and output) becomes `<omitted: n chars>`. `--include-text` keeps all of it, still redacted.

**Redaction**, over every entry and entry name, in this order:
1. likely secrets (the secret scanner's provider patterns and entropy check, with no allowlist) become `<secret:kind>`;
2. the repo root becomes `<repo>`, the worktrees root (`worktrees.root`) `<worktrees>` and the home directory `~`;
3. email addresses become `<email>`;
4. known identities (git `user.name`, the OS user, the machine's host name and its first label, the owners of the github.com and gitlab.com remotes, and `tracker.github.repo`'s owner, `tracker.github.project.owner`, `tracker.github.ready.assignee` and `pr.reviewers`) become `<login>`, as do the owner in any `github.com/<owner>` or `gitlab.com/<owner>` and any `@mention`.

Redaction is pattern-based and best-effort: a secret no pattern knows, or a login Forge doesn't know written as a plain word, can survive. Read the manifest stderr prints, and open the zip, before you attach it to a public issue.

## Stability

Forge follows semver for this contract. Any release may add commands, flags, JSON fields, error codes and environment variables. Renaming or removing a JSON field, an error code or an exit number is a breaking change: it ships only in a release whose version says so (a new major version, or a new minor version while Forge is below 1.0) and is called out in [CHANGELOG.md](../CHANGELOG.md). Message and hint text, human-mode output, and the order of JSON keys, are not covered: match on `code` and `exit`, never on `message`. `test/cli-contract.test.ts` pins the JSON keys of `forge job list|show|step`, `forge status --json`, `forge verify`, `forge stats --json` and `forge version --json` (`version`, `commit`, `installedAs`, `node`), so an accidental rename fails the build.
