# hooks
Source: hooks/ · Public surface: hooks/hooks.json (PreToolUse on Bash → `node ${CLAUDE_PLUGIN_ROOT}/hooks/no-ai-attribution.ts`; SessionStart → `node ${CLAUDE_PLUGIN_ROOT}/hooks/plugin-path.ts`), hooks/plugin-path.ts (writes to `$CLAUDE_ENV_FILE`), hooks/no-ai-attribution.ts (reads the hook event JSON on stdin; env `FORGE_AI_ATTRIBUTION`; repo `aiAttribution: allow`).
Old tests: test/plugin-path.test.ts, test/attribution.test.ts, test/engine-ts.test.ts
Baseline coverage: not measured (outside `lib/` and `dashboard/src/lib/`, which `npm run coverage` covers)

## Behaviours
- B1. plugin-path with `CLAUDE_ENV_FILE` unset or empty: exit 0, stdout empty, no file created in the cwd. Old: plugin-path › "SessionStart hook puts the plugin's bin first"
- B2. With `CLAUDE_ENV_FILE=<file>` holding `export FOO=1` (no trailing newline): exit 0, stdout empty; the file keeps `export FOO=1` as its first line and gains exactly one `export PATH='<plugin root>/bin':"$PATH"` line followed by exactly one `export FORGE_MODE=agent` line; a second run changes no byte. Sourcing the file in `/bin/sh` with a decoy `forge` earlier on PATH makes `command -v forge` resolve to `<plugin root>/bin/forge`. Old: plugin-path › "SessionStart hook puts the plugin's bin first"
- B3. A file that already has both lines (the last one without a trailing newline) is left byte-identical; a missing env file is created with the two lines. Old: plugin-path › "SessionStart hook puts the plugin's bin first"
- B4. A file that already has the PATH line (from an older hook) gains only the FORGE_MODE line, after it, and a second run adds nothing; sourcing it overrides an inherited `FORGE_MODE=human` (prints `agent`). Old: plugin-path › "SessionStart hook pins agent output mode"
- B5. hooks.json registers exactly `SessionStart: [{hooks:[{type:'command', command:'node', args:['${CLAUDE_PLUGIN_ROOT}/hooks/plugin-path.ts']}]}]` and `PreToolUse: [{matcher:'Bash', hooks:[{type:'command', command:'node', args:['${CLAUDE_PLUGIN_ROOT}/hooks/no-ai-attribution.ts']}]}]`, and no other hook events. Running the PreToolUse entry's args (with `${CLAUDE_PLUGIN_ROOT}` replaced) on a `git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"` event exits 2 with `Blocked by Forge` on stderr. Old: plugin-path › "hooks.json registers the SessionStart hook"; engine-ts › "hooks.json runs the TypeScript hook"
- B6. KEPT: `hasAttribution`/`stripAttribution` find and strip AI signatures (`Co-Authored-By: Claude …`, `🤖 Generated with [Claude Code](…)`, `Co-authored-by: GitHub Copilot …`, `Claude-Session: …`) but not mere mentions (kept, not rewritten: test/attribution.test.ts). Old: attribution › "finds and strips AI signatures but not mere mentions"
- B7. KEPT: the PreToolUse hook blocks publishing commands carrying attribution (exit 2, the offending line on stderr), including a `--body-file` it reads; a non-attribution commit message, a non-publishing command (`echo "Co-Authored-By: Claude"`), `FORGE_AI_ATTRIBUTION=allow` and a repo with `aiAttribution: allow` pass (exit 0) (kept, not rewritten: test/attribution.test.ts). Old: attribution › "hook blocks publishing commands that carry attribution"
- B8. KEPT: `scrubBranch` rewrites only offending commit messages, keeps trees, authors and committers, refuses when the branch moved past the checked commit, and is idempotent (kept, not rewritten: test/attribution.test.ts). Old: attribution › "scrubBranch rewrites only offending commit messages", "scrubBranch rewrites from the commit it is given and never folds in a later one"

## Edge and corner cases
- E1. An unwritable env file (`<tmp>/no/such/dir/env.sh`) → exit 0, stdout empty, stderr contains `plugin-path hook`: the hook never breaks session start. Setup: B2's runner with `CLAUDE_ENV_FILE=<tmp>/no/such/dir/env.sh`. Old: plugin-path › "SessionStart hook puts the plugin's bin first"
- E2. The hook depends only on where its file sits: no stdin, no cwd, no CLAUDE_PLUGIN_ROOT; on win32 it writes nothing. A copy placed in another plugin dir (with its own package.json `{"type":"module"}`) puts that plugin's bin first. Setup: R1's copied-plugin layout without the hostile name; on win32 nothing to assert. Old: plugin-path › "hook quotes a hostile plugin path"
- E3. The attribution hook exits 0 on unparseable stdin, and for commands that are not publishing ones (only `git commit|tag|notes|merge`, `gh pr|issue|release|api|gist`, `glab mr|issue|release` are checked); message files passed by `-F`, `--file`, `--body-file`, `-t`, `--template` (under 1 MiB, `-` skipped) are scanned too. Setup: the kept attribution test's hook runner (stdin JSON event, `FORGE_AI_ATTRIBUTION: ''`). Old: attribution › "hook blocks publishing commands that carry attribution" (kept)

## Regressions worth keeping
- R1. A hostile plugin path (`a b'c$(touch pwned)\`x\``) is single-quoted in the PATH line: sourcing the env file resolves `forge` to `<that plugin>/bin/forge` and creates no `pwned` file anywhere (in the temp tree or the cwd). Old: plugin-path › "hook quotes a hostile plugin path"
- R2. Resume, clear and compact rerun the hook on the same env file: lines are appended only when missing, so the file never grows duplicate PATH or FORGE_MODE lines (B2, B3, B4). Setup: B2–B4 (rerun on the same env file). Old: plugin-path › "SessionStart hook puts the plugin's bin first"

## Cheapest layer
Both hooks are separate processes by contract: spawn `node hooks/plugin-path.ts` with a controlled env (CLAUDE_ENV_FILE removed unless set), and source the result with `/bin/sh -c '. "$CLAUDE_ENV_FILE"; command -v forge'` under a PATH of `<decoy>:/usr/bin:/bin`. hooks.json is read as JSON. POSIX-only.

## Setup recipes
- A temp dir via `fs.realpathSync(fs.mkdtempSync(...))`; a decoy dir holding an executable `forge` (`#!/bin/sh\necho decoy\n`, mode 0755).
- Hostile plugin copy: `<tmp>/a b'c$(touch pwned)\`x\`/hooks/plugin-path.ts` (copied), a `package.json` `{"type":"module"}` and an executable `bin/forge`.
- Attribution hook input: `JSON.stringify({tool_name:'Bash', tool_input:{command}, cwd})` on stdin with `FORGE_AI_ATTRIBUTION: ''`.

## Dropped on purpose
- plugin-path › "hooks.json registers the SessionStart hook": its `assert.doesNotMatch(src, /from '\.{1,2}\//)` source scan (no relative imports); E2's copy-and-run proves the same.
