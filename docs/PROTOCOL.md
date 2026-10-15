# Running Forge on any agent runtime

Forge is packaged for Claude Code, but nothing in its design is specific to one model or vendor. The orchestrator procedure is markdown, the roles are markdown, and all state goes through a CLI. Any runtime that can run shell commands, read and write files, and start sub-agents (or fresh-context runs) can drive it.

## Pieces

| Piece | Path | Role in another runtime |
|---|---|---|
| Orchestrator procedure | `skills/forge/SKILL.md` + `skills/forge/reference/*.md` | the orchestrator's instructions |
| Roles | `agents/<role>.md` | each sub-agent's system prompt (ignore the YAML frontmatter, except `model` as a hint) |
| Review lenses | `reviewers/<lens>.md`, `.forge/reviewers/<lens>.md` | handed to the reviewer role as its checklist |
| CLI | `bin/forge` (Node ≥ 22.18) | inside Claude Code the plugin puts `bin/` on PATH; elsewhere `git clone` it and run `npm link` so `forge` is on PATH for the orchestrator and every sub-agent |

## Substitutions when reading SKILL.md

| In SKILL.md | Use |
|---|---|
| `$ARGUMENTS` | the user's request |
| `${CLAUDE_SESSION_ID}` | any id unique to this orchestrator session (e.g. `<runtime>-<timestamp>`) |
| `${CLAUDE_PLUGIN_ROOT}` | where Forge is installed (the plugin's directory, or your clone) |
| a `spawn` action's `agent` (`forge:<role>`), `model` and `brief` | start a sub-agent (or a fresh-context run) whose system prompt is `agents/<role>.md` and whose user message is `brief`; translate `model` to your provider |
| "run in the background / wait for notifications" (`parallel: true`, `wait` on `agents`) | run sub-agents concurrently if your runtime can; otherwise sequentially, which is slower but equivalent |
| "SendMessage" to a `resume` agent | start a fresh agent with the same brief. Roles recover from files by design. |
| `forge job agent … --import` | omit `--import`; pass whatever usage your runtime reports (`--tokens`, `--tool-uses`, `--duration-ms`), or nothing |
| AskUserQuestion (init) | ask the questions in plain text |

Set `runtime.provider`/`runtime.host` in `.forge/config.yml` so humans and the dashboard know what drove a job. Model names in `runtime.models` can be any ids your runtime accepts. Add their prices under `usage.pricing.models` if you want cost estimates.

## The minimum contract

Whatever drives Forge must:
1. change job state only through `forge` commands
2. drive each job with the step loop: run `forge job step <id> --session <your session>` (stepping keeps your claim alive), do the one action it returns (`spawn`: run `start`, argv after `forge` (`startShell` is the same as one command line), start the agent with `brief`, then `forge job agent <id> end --role <role> --summary "<its reply line>"`; `run`: execute `command`, argv after `forge`; `wait`: on `agents`, wait for them, on a gate, report `tell` and stop; `procedure`: follow `reference`; `done`: stop), then step again. Don't decide stages yourself. `forge job advance <id> --session <S>` is the faster equivalent: it executes `run` actions in-process and returns the first `spawn`, `wait`, `procedure` or `done` with `ran`; `--max 1` runs one command per call.
3. give each role its inputs as **paths** (step's briefs already do), and accept only the outputs that role owns
4. stop at human gates (`waiting`), and record why
5. keep builders and integrators inside the job's worktree
6. publish only verified commits: `forge verify` after the last commit, before `forge pr open` (which refuses anything else)

Everything else (dashboard, PR sync, trackers, evals, retros) works the same regardless of runtime.
