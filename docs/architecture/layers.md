# Layers

| Layer | Where | Changes when |
|---|---|---|
| **Engine**: CLI, dashboard, data schemas | `bin/`, `lib/`, `dashboard/` | the plugin is updated |
| **Roster**: orchestrator skill, agent prompts, reviewer catalog | `skills/`, `agents/`, `reviewers/` | the plugin is updated |
| **Repo layer**: config, learnings, role addenda, repo checklists, verifiers, evals, custom trackers | `<repo>/.forge/` (committed) | `/forge init`, humans, retros |
| **Runtime state**: jobs, locks, dashboard inbox, caches | `<repo>/.forge/{jobs,locks,runtime}/` (gitignored) | every Forge action |

Repos never copy the engine or the roster, so there is nothing to drift. Everything repo-specific is data in `.forge/`, and that's also the only layer the retro loop edits.

**Which `forge` runs.** Claude Code appends a plugin's `bin/` to the end of PATH, so a `forge` earlier on PATH (a `~/.local/bin` shim, an `npm link` of another checkout) would run a different install's CLI against the loaded plugin's skills. The SessionStart hook `hooks/plugin-path.ts` appends `export PATH='<plugin root>/bin':"$PATH"` to `$CLAUDE_ENV_FILE`, which Claude Code sources before every Bash command of the session, subagents included, so `forge` is always the loaded plugin's. The line is built only from the hook's own location and single-quoted; the hook prints nothing on stdout and always exits 0. It does nothing when `CLAUDE_ENV_FILE` is unset or empty, on Windows, or when the file already holds the line (resume, clear and compact run it again). Daemon sessions get the same order from `sessionEnv()`.
