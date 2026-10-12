# Running Forge on any agent runtime

Forge is packaged for Claude Code, but nothing in its design is specific to one model or vendor. The orchestrator procedure is markdown, the roles are markdown, and all state goes through a CLI. Any runtime that can run shell commands, read and write files, and start sub-agents (or fresh-context runs) can drive it.

## Pieces

| Piece | Path | Role in another runtime |
|---|---|---|
| Orchestrator procedure | `skills/forge/SKILL.md` + `skills/forge/reference/*.md` | the orchestrator's instructions |
| Roles | `agents/<role>.md` | each sub-agent's system prompt (ignore the YAML frontmatter, except `model` as a hint) |
| Review lenses | `reviewers/<lens>.md`, `.forge/reviewers/<lens>.md` | handed to the reviewer role as its checklist |
| CLI | `bin/forge` (Node ≥ 20) | install with `npm i -g github:maxwellmattryan/forge` so `forge` is on PATH for the orchestrator and every sub-agent |

## Substitutions when reading SKILL.md

| In SKILL.md | Use |
|---|---|
| `$ARGUMENTS` | the user's request |
| `${CLAUDE_SESSION_ID}` | any id unique to this orchestrator session (e.g. `<runtime>-<timestamp>`) |
| `${CLAUDE_PLUGIN_ROOT}` | where Forge is installed (`npm root -g`/@maxwellmattryan/forge, or a clone) |
| "spawn with the Agent tool, `subagent_type: "forge:<role>"`, `model`" | start a sub-agent (or a fresh-context run) whose system prompt is `agents/<role>.md` and whose user message is the brief; pick the model from `runtime.models` translated to your provider |
| "run in the background / wait for notifications" | run sub-agents concurrently if your runtime can; otherwise sequentially, which is slower but equivalent |
| "SendMessage to resume the builder" | start a fresh builder with the same brief plus rework inputs. Roles recover from files by design. |
| `forge job agent … --import` | omit `--import`; pass whatever usage your runtime reports (`--tokens`, `--tool-uses`, `--duration-ms`), or nothing |
| AskUserQuestion (init) | ask the questions in plain text |

Set `runtime.provider`/`runtime.host` in `.forge/config.yml` so humans and the dashboard know what drove a job. Model names in `runtime.models` can be any ids your runtime accepts. Add their prices under `usage.pricing.models` if you want cost estimates.

## The minimum contract

Whatever drives Forge must:
1. change job state only through `forge` commands
2. give each role its inputs as **paths**, and accept only the outputs that role owns
3. stop at human gates (`waiting`), and record why
4. keep builders and integrators inside the job's worktree

Everything else (dashboard, PR sync, trackers, evals, retros) works the same regardless of runtime.
