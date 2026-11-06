# Daemon runtime: role runs

Part of [Daemon runtime](../daemon-runtime.md).

## Role runs

`forge job agent run <id> --session S [--spawn-index N | --role R] [--epoch N] [--cold] [--ipc]` (lib/cli/commands/job/agent-run.ts) runs one spawn `forge job step` returned as its own headless child, a **role run**, instead of a subagent of the job's session; its child half, `runRoleChild` in lib/integrations/claude/role.ts, knows nothing of jobs. The [code driver](code-driver.md#code-driver) calls it with `--role` and `--ipc`; nothing else calls it automatically.

*Before anything is written* it checks the flags (`--role` is a role name or `reviewer:<lens>`, never with `--spawn-index`; `--ipc` needs a Node IPC channel to the parent, else it is a usage error), the job, the scope (`refuseInboxDrive`, and under `FORGE_DAEMON=1` only the job's own session: the child carries that job's scope), that S holds the lease (and `--epoch`), that step still returns a spawn with index N in `[action, ...spawns]`, or with role R (else `stale_step`), the config read once (`trackerSymlinks`, `daemonProblems`, and under `FORGE_DAEMON=1` a `FORGE_DAEMON_TRUST` equal to the digest of those bytes), the worktree (`jobWorktreeProblem`, and under one of the write roots' worktrees roots) and the brief.

*The start* is `forge job agent start`'s path (role, model, `--output`, `--retry`), fenced by `{epoch, session}` plus a check that re-runs step under the job lock, so of two callers racing for one spawn exactly one starts.

*argv* is `roleArgv` (lib/integrations/claude/argv.ts):
- `daemon.command`'s first word, then `-p --input-format stream-json --output-format stream-json --verbose --plugin-dir <plugin> --agent forge:<role> --setting-sources '' --strict-mcp-config --disable-slash-commands --tools <tools>` (`''` is one empty argument: no setting source loads, neither the worktree's own `CLAUDE.md`, `.claude/settings*.json` and `.mcp.json`, which are files the branch's agents wrote, nor the user's settings, plugins and hooks, none of them Forge's, so only the plugin and managed settings load; `<tools>` is the built-in tools of the agent's `tools:` frontmatter, read by `agentTools` in lib/engine/pipeline/roster.ts, its `mcp__…` entries dropped, every name matching `^[A-Z][A-Za-z]+$`, and an agent without the list refuses the run before anything is written),
- `--model` and `--effort` when valid,
- `--append-system-prompt-file <file>` when the run has a trusted prefix (below),
- `--mcp-config <json>` when the spawn gets Forge's browser (below),
- `--permission-mode` from the template,
- `--allowedTools` with every file tool swapped for one `Edit(//<root>/**)` per write root (and the browser's named page tools last with the browser, `BROWSER_ALLOWED`, since no one can answer a role child's prompt; never the whole `mcp__forge-browser` server),
- `--session-id <uuid>` or `--resume <uuid>`,
- `--disallowedTools` with the absolute deny rules only (`absoluteDenyRules`, lib/office/session/confine.ts), then with the browser `mcp__forge-browser__browser_run_code_unsafe` (`BROWSER_DENIED`),
- and `--permission-prompt-tool stdio`;

the template's other words are ignored.

*The browser* is `browserMcpConfig` (lib/integrations/claude/browser.ts): one `forge-browser` server, `<absolute npx> -y --prefix <root>/.forge/runtime/browser @playwright/mcp@<exact version> --headless --isolated --allowed-origins http://localhost:<port>;http://127.0.0.1:<port> --output-dir <job dir>/screenshots` with `env.PATH` set to the session's PATH minus its relative and empty entries, built from the job's integer `port`, Forge paths and that PATH only. The `npx` is looked up in those absolute entries alone, and the prefix is an empty directory Forge makes (a real one, never a link), so a branch's `.npmrc` and `node_modules` choose nothing; with no `npx` there is no browser.

A role run passes it when `needsBrowser` (lib/engine/pipeline/brief.ts) holds, for the builder, the designer or a reviewer whose lens is `ui`, `ux`, `accessibility` or `design`, while the spec has a UI AC (`specUiAcs`, the builder's `UI proof:` ACs), and the job has a port; a job session's spawn passes it under the same spec and port rule (`sessionBrowser`, lib/office/slots.ts), with its `allowedTools` unchanged, so browser calls are prompts as other MCP calls are, and `browser_run_code_unsafe` denied as in a role run; the inbox, office, chat and gate-run sessions never get it.

Without it a role has no browser, and when Chrome is missing the server fails to start and the role runs without browser tools. `--output-dir` covers files the server names itself; a tool's `filename` is resolved against its workspace root (cwd), and docs/architecture/daemon-security.md lists what that leaves open.

*The trusted prefix* (lib/engine/guard/prompt-prefix.ts) is one file, `.forge/runtime/prompt-prefix/<sha256>.md`, holding a fixed head and then the main checkout's copies of the role's `project.instructions` files, `.forge/notes/learnings.md` and `.forge/notes/<role>.md`, those that exist, in that order: no job id, round, path, lens or checklist, so every lens of a panel, the next round and the next job get the same bytes and the same path, and claude's prompt cache serves them instead of writing them again (#374 measured the shared prefix rise from 15,062 to 23,910 tokens).

It is built before the start, reused when a regular file with those bytes is there and otherwise replaced atomically, and it goes on the first launch, the resume and the fresh-session fallback alike. With it, the brief's `Instructions:` line becomes the fixed `PREFIX_INSTRUCTIONS_LINE` (inserted after `Effort:` when the brief had none), and every other line stays.

A refused source (a link, a non-regular file, more than 256 KiB, a linked parent directory, an instruction entry under `.forge/` or a write root), a prefix over 256 KiB, a write that fails or a prefixed brief over the cap run the role exactly as before, with no flag and the brief unchanged. No source at all is no prefix and no refusal.

*env* is `sessionEnv` (`FORGE_DAEMON=1`, `FORGE_MODE=agent`, the git pins, no API key or provider switch unless `daemon.auth: api-key`), plus `FORGE_ROOT` (pinned to the main checkout, as the pool pins it for every session), `FORGE_DAEMON_WRITE_ROOTS`, `FORGE_DAEMON_SCOPE=<id>` and `FORGE_DAEMON_TRUST` (the caller's own under `FORGE_DAEMON=1`, else the digest just taken: whoever runs the CLI outside a session is the trust anchor).

*cwd* is the realpath of the job's worktree, the path that was checked. The child's env never carries `NODE_CHANNEL_FD` or `NODE_CHANNEL_SERIALIZATION_MODE`, so a role child can't reach the runner's IPC channel.

*stdin* gets the brief as one stream-json user line (`briefLine`, at most 200,000 characters), and stays open for permission answers; with no one there, every `can_use_tool` request is denied with the fixed `UNATTENDED_DENIED` text and counted as `denied`. With `--ipc` the runner reports to its parent instead ([Code driver](code-driver.md#code-driver)) and waits for its answer to each prompt of the role's own child (a context child stays unattended); when the channel disconnects, every prompt still waiting is denied unattended and the role is interrupted, and the runner disconnects the channel itself before it returns. When claude's `init` reports a uuid session id the runner records `agent attach` with it, so the Thread view and activity line follow the run.

*The end*: after the `result` line the runner closes stdin, waits 10 s, then SIGTERMs the child's process group and SIGKILLs it 5 s later (`daemon.turnTimeoutMinutes` bounds a run that never reaches a result; SIGINT or SIGTERM to the runner stops the child first). It records `forge job agent end`'s path (the output check, the secret scan, budget enforcement, lease renewal) fenced by `{epoch}`, so a session that took the job over meanwhile refuses it (`stale_epoch`, the run log kept): `done` with the result's first non-empty line as the summary (redacted of the job's known secrets), or `failed` with `<class>: <reason>`, the class one of `limit` (with `resetsAt`), `auth`, `budget`, `error`, `timeout`, `untrusted` (the trust digest or the confine digest, the one a session's turns are held to, changed during the run), `interrupted` (exit 1), `exit` or `spawn` (exit 5).

Step's L1 rule respawns a failed role. The JSON also carries `prefix`, the trusted prefix file passed or `null`, and `prefixRefused`, the fixed reason naming the source's checkout-relative path, when a refusal made the run go without one.

*Usage* is the result's `modelUsage` summed into one exact AgentUsage, under the model that used the most tokens. A child that started but sent no cost (a timeout, a kill, an exit before the result) is measured from its session transcript as a resume without a sidecar is, and flagged `unmeasured` when there is none.

*Files* (`.forge/runtime/agents/<id>/`, gitignored): `<session>.log` gets every stdout and stderr line redacted of the job's known secrets, plus the runner's own `forge-permission` lines, and `<session>.json` is the sidecar `{v: 1, cum, at, role, context}` with the last cumulative cost, the role that ran the session (`context` for a context child) and its last turn's context ([Rotation](sessions.md#rotation); absent without a reading), written after every result that carried a cost. Both are opened through dirs created a level at a time and never through a link.

## Resume

A spawn whose `resume` is a uuid gets `--resume` instead of a context-session fork, `agent-start` records `resume`, and its usage is the new cumulative less the baseline that session's sidecar holds; without a sidecar it falls back to importing the session transcript (`<projects>/<slug(worktree)>/<uuid>.jsonl`), else `unmeasured`. A resume that fails before `init` is retried once as a fresh, cold session (`resumeFailed: true` in the JSON and on `agent-end`); a `resume` that is not a uuid starts fresh.

Step gives a `resume` to N2's and IG10b's answered agent and, under `pipeline.resumeRework` (default true), to a **rework resume**: B4's builder and each RV4 or RV10 lens whose role (`builder`, `reviewer:<lens>`) already has an ended run, from any round, so a lens back after a `narrow` skip continues its own last run and a builder re-run after a failed verify continues its own.

`reworkResume` (lib/engine/pipeline/step/facts.ts) checks, in order, and the first that applies is the spawn's `resumeSkipped` (`--resume-skipped` on its start line, on `agent-start` and in the JSON): `off`; `last run failed` (its status is not `done`); `no session` (its `agentId` is not a uuid, or no runner sidecar names that session for that role: an in-session subagent, a run from before this, or an id planted on another role); `model changed` (the spawn's model is not the role's last `agent-start` model, `runtime.reworkModel` for one); `spec changed` (a `revise-spec` decision, or a spec-writer run that ended, after that run started); `no transcript` (no `<uuid>.jsonl` under the job's own worktree's project dir); `context unknown`; `context over ceiling` (its last context above `RESUME_CONTEXT_CEILING`, 120000 tokens; exactly 120000 resumes).

A role's first run carries neither, and the brief is the same either way. `loadLastSessions` (lib/engine/pipeline/step/input.ts) reads those facts once, at stages build and review only.

## Lean sessions

What a session or role child loads is read from claude's own `system`/`init` line. The probe, in a scratch git repo (with `FORGE_ROOT` and `FORGE_HOME` pointed away from real projects): `claude -p --model haiku --output-format stream-json --verbose --setting-sources '' --strict-mcp-config --disable-slash-commands --tools Read,Write --plugin-dir <plugin> "reply ok"`; add `--agent forge:<role>` and that agent's `--tools` for a role child, or swap the four lean flags for the default `daemon.command`'s for a session. Read the init's `plugins`, `mcp_servers`, `tools`, `skills` and `slash_commands`.

On Claude Code 2.1.311 with `--plugin-dir` at this checkout, the lean probe listed only `forge` and three `cc-plugin-*@builtin` entries (`cc-plugin-agents-md`, `cc-plugin-telemetry`, `cc-plugin-plugin-authoring`), no MCP servers, no skills or slash commands, and the tools `[Read, Write]`; every `forge:*` agent was listed, the only hook was Forge's own SessionStart (`hooks/plugin-path.ts`), and the first request read 4.3K cached tokens and wrote 0.7K. With `--setting-sources user --strict-mcp-config`, the same probe loaded 13 user plugins, 103 skills, 142 slash commands and 26 tools: 11.4K read and 16.9K written. The `cc-plugin-*` entries are Claude Code's own (`path: builtin`) and load under every flag; they are not the user's. Auth came from the login under both, never from settings.

## Context sessions

Reviewers and rework builders re-read the same round inputs (#374 measured 32% of Reads repeating an earlier agent's in the same job, 43% for reviewers), so a role run may fork a **context session** that read them once (lib/engine/workspace/context-session.ts; `docs/design/prompt-cache.md` › Recommendation › For #376).

*Eligible* spawns, never a resume (a rework resume of the role's last session wins over the fork; a spawn with `resumeSkipped` forks as before): a `reviewer:<lens>` on an `RV*` rule (not the integration reviews `IG8`, `IG12`), and a `builder` whose job's `build.md` is a regular file (a rework build). Every other spawn runs as before, with `context: null` in the JSON and no `context` on its `agent-end`.

*The key* is the job round, `sp.agent`, `sp.model` (`inherit` when none), `sp.effort` and the trusted prefix file, so the lenses of one panel on one model share a context, and the opus security lens and the builder each get their own.

*Find or start*: after the fenced start, the runner takes `.forge/locks/context/<jobId>-<first 16 hex of sha256(key)>` (an 11-minute wait, then the run goes cold `context busy`; SIGINT or SIGTERM while waiting fails the role `interrupted` with nothing launched), reloads the job and looks for the newest `job.contexts` record with the key whose `lastReadAt` is at most 50 minutes old (the prompt cache's hour, less a margin). A ready one is forked; a failed one makes the run cold with its reason, so a failing context costs one start per key and round, not one per lens; none (or only a stale one) starts a new context under the lock, so concurrent lenses start exactly one.

*Inputs*, in order: `spec.md`, `design.md`, `build.md`, the first of `verify/round-<n>.md` and `verify/round-<n-1>.md`, the first of the matching `-verifiers.md` reports, `scope.md`, and the first of `review/round-<n>/diff.patch` and `review/round-<n-1>/diff.patch`, each kept only when `readRegular` reads it (no link, no FIFO, no block), its parent's realpath is its own path under the job dir's realpath, it is at most 256 KiB and the total stays within 384 KiB; each is recorded with its sha256. No usable input is cold `no inputs`, with no record.

*The context child* takes the spawn's own `roleArgv` with a fresh `--session-id`, the job's worktree, the same env, a 10-minute timeout and unattended denies; its brief (`contextBrief`) names the job, `Role: context session · <agent>`, the round, the worktree and `Inputs (JSON)`, tells it to Read each input in full and reply exactly `READY`, and ends in `UNTRUSTED_LINE`.

It is *ready* only when its result is ok, its whole text, trimmed, is `READY`, its main loop called no tool but `Read` (the stream's `tool-use` events, returned as `tools`) with no call denied and no stdout line dropped unread (over the line cap, not JSON, or a protocol error, counted as `dropped`: any could have held a tool call), and no trusted or protected file moved while it ran (the trust and confine digests, checked right after it); otherwise it is failed with its failure class (`untrusted` for a moved file, which also fails the launching role `untrusted` without starting it) or `not ready`.

Its usage (from its result, else its transcript, else `unmeasured`) goes to `job.usage` under role `context` and onto a `context-session` event, which the spend ledger counts, and `job.contexts` (newest 20) records it: id, round, agent, model, effort, prefix, status, reason, inputs with sha256, times, `lastReadAt`, `startPrefix` (its first request's input + cache read + cache write) and usage. Its log and sidecar are `.forge/runtime/agents/<id>/<ctx>.log`/`.json`.

*The fork* is the spawn's `roleArgv` with `--resume <ctx> --fork-session` instead of `--session-id`, so its agent, model, effort and prefix equal the context's; its brief is the role's usual one plus `Context (JSON): {"session","inputs","changed"}` before `Untrusted:`, where `changed` lists each recorded input whose sha256 moved, or which is now missing or unusable. The record's `lastReadAt` moves to the fork's launch.

*Cold* is today's launch, with a reason: `cold flag` (`--cold`, for measurement: no context child), `no inputs`, `context failed: <class>` or `context failed: not ready` (a find-or-start that itself fails, say a lock directory that can't be made, is `context failed: error`: the role runs cold, never left `running`), `context busy`, `brief over the cap`, `fork failed` (the fork failed before `init`; the role is then launched once more, cold) and `cache miss` (the fork ran, but its first request read no more cache than the context's `startPrefix`; only logged).

*Records*: every eligible run's `agent-end` and JSON carry `context: {mode: 'fork' | 'cold', session, reason, firstRead}`, `firstRead` being the first request's cache read (the stream's `first-request` event).

*Fork usage* is the fork's cumulative less the context's sidecar cumulative when the fork's is at or above it on `usd` and every token field of every model it holds (claude carried it over), else the whole cumulative; `wallMs` starts once the context is resolved, and the context's own wall time is on its record. A `stale_epoch` while recording the context ends the run with the context's log path, launching nothing.
