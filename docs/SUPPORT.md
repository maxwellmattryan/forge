# Support matrix

Where Forge runs, what each level of support promises, and what it refuses. `forge doctor` reports your platform's tier as its first check.

| Platform | Versions | Tier | Meaning |
|---|---|---|---|
| macOS (`darwin`) | Node ≥ 22.18 (CI runs 22.18.0 and the latest 24), git ≥ 2.38, gh ≥ 2.40 | **supported** | tested in CI on every PR |
| Linux (`linux`, not WSL) | Node ≥ 22.18 (CI runs 22.18.0 and the latest 24), git ≥ 2.38, gh ≥ 2.40 | **supported** | tested in CI on every PR |
| WSL2 (`linux` whose `/proc/version` names Microsoft) | as Linux | **supported with notes** | best effort, not in CI |
| native Windows (`win32`) | as Linux | **unsupported** | refused where it is known to break |
| any other `process.platform` | — | **unsupported** | not tested; nothing is refused |

gh is needed only for pull requests (`pr.enabled`) and the GitHub tracker. `forge doctor` checks the git and gh minimums.

## What each tier means

- **Supported**: the full verify list (typecheck, dashboard checks and build, every test, plugin validation) runs on Ubuntu and macOS, on Node 22.18.0 and the latest Node 24, on every pull request and every push to `main`. A bug here is a bug.
- **Supported with notes**: expected to work, because WSL2 is Linux to Node, but no CI runs it. Bugs are fixed on a best-effort basis. The notes below are requirements, not tips.
- **Unsupported**: Forge refuses the features it knows break, with a message that links here, instead of failing later. Everything else may run but is not supported, and bugs that only reproduce there may be closed.

## WSL2

Keep the repo and its worktrees on the Linux filesystem (for example `~/src/<repo>`), never under `/mnt/` (the Windows drives). Forge creates a worktree per job beside the repo (`worktrees.root`, by default `../<repo>.worktrees`), and git and the file watchers on the 9P-mounted Windows filesystem are slow and miss changes. `forge doctor` checks this on WSL2: its `repo on the Linux filesystem (WSL2)` check fails and names the path when the repo root or the worktrees root is under `/mnt/`.

## Native Windows

- **Refused**: the daemon (the session pool `forge dash` runs) and `forge update`. The daemon needs POSIX process groups and `ps` to stop and prove its sessions, so the pool refuses to start and the dashboard serves without it. `forge update` exits 1 without detecting the install: update the plugin from Claude Code, or `git pull` your clone.
- **Runs, but not supported**: the rest of the CLI and the dashboard.
- **`forge dash --stop` stops nothing.** Forge proves the dashboard's record with `ps` before it signals its pid, so on native Windows every record is stale: `--stop` clears it without stopping a background dashboard, and `forge dash` starts another one on the next free port. Stop a dashboard there with Ctrl-C in its terminal.
- **Command templates** (`commands.*`, `worktrees.setup`, eval checks) are POSIX `sh`. Off Windows they run as `$SHELL -lc <cmd>` (`/bin/sh` when `$SHELL` is unset), and under the daemon as `/bin/sh -c <cmd>`, with no login profile (docs/CONFIG.md "Daemon"). On native Windows they run under Git for Windows' `sh` (Git Bash): the first `sh.exe` on PATH, else `%ProgramFiles%\Git\bin\sh.exe`. Without one, the command is refused with a message saying so.
- **CI**: none. Forge's CI runs on Linux only, so nothing guards the Windows fixes against regressions.

For anything beyond that, use WSL2.

## Reporting a platform problem

File a [bug report](https://github.com/maxwellmattryan/forge/issues/new?template=bug_report.yml) with the `forge doctor` output (its first check is the platform tier), your OS, Node, git and gh versions, and the Claude Code version. Say whether the problem also happens on a supported platform.
