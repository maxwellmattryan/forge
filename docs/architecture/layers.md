# Layers

| Layer | Where | Changes when |
|---|---|---|
| **Engine**: CLI, dashboard, data schemas | `bin/`, `lib/`, `dashboard/` | the plugin is updated |
| **Roster**: orchestrator skill, agent prompts, reviewer catalog | `skills/`, `agents/`, `reviewers/` | the plugin is updated |
| **Repo layer**: config, learnings, role addenda, repo checklists, verifiers, evals, custom trackers | `<repo>/.forge/` (committed) | `/forge init`, humans, retros |
| **Runtime state**: jobs, locks, dashboard inbox, caches | `<repo>/.forge/{jobs,locks,runtime}/` (gitignored) | every Forge action |
| **Machine index**: registered projects | `~/.forge/` or `FORGE_HOME` (outside every repo) | `forge project add\|remove` |

**The machine index** is the one machine-wide state: `projects.json` (`lib/engine/project/machine-index.ts`), whose entries are a name (from the directory, never from config), the root repo's realpath and when it was added. It may never hold project config, commands, secrets or job state: those stay in each project's `.forge/`, so one project's config can't leak into what another project's sessions read. `forge project list` never deletes a missing project; only `remove` drops one. `add` and `remove` are refused in daemon sessions, because registering a project is a human's trust decision. A file it can't read (bad JSON or entry, or from a newer Forge) is refused and never rewritten.

Repos never copy the engine or the roster, so there is nothing to drift. Everything repo-specific is data in `.forge/`, and that's also the only Forge layer the retro loop edits, beside the checks it may propose for the repo's own test or lint suite.

**Which `forge` runs.** Claude Code appends a plugin's `bin/` to the end of PATH, so a `forge` earlier on PATH (a `~/.local/bin` shim, an `npm link` of another checkout) would run a different install's CLI against the loaded plugin's skills. The SessionStart hook `hooks/plugin-path.ts` appends `export PATH='<plugin root>/bin':"$PATH"` to `$CLAUDE_ENV_FILE`, which Claude Code sources before every Bash command of the session, subagents included, so `forge` is always the loaded plugin's. The line is built only from the hook's own location and single-quoted; the hook prints nothing on stdout and always exits 0. It does nothing when `CLAUDE_ENV_FILE` is unset or empty, on Windows, or when the file already holds the line (resume, clear and compact run it again). Daemon sessions get the same order from `sessionEnv()`.
