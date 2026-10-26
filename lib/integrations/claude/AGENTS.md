# lib/integrations/claude/

Claude Code's command line, protocol, files and prices: the session argv and env, the stream-json protocol and the child that speaks it, transcripts and the model price table.

- `stream.ts` builds every line written to a session's stdin from fixed text or a fixed list: the one turn, permission answers (an allow echoes claude's own input) and mode switches. Nothing from requests, HTTP or config reaches one (docs/architecture/daemon-security.md). Line caps (`maxLineBytes`, `STDERR_CAP`) apply there too. Redaction is the office's job (`lib/office/session/log.ts` `logLine`): integrations can't import engine's known-secrets.
- `DENY_TOOLS` (then the caller's `deny`) and `PROMPT_TOOL` end every argv, `buildArgv` swaps every file tool in `{allowedTools}` for one `Edit(//<root>/**)` rule per write root, and API keys are dropped unless `daemon.auth` is `api-key` (docs/architecture/daemon-security.md).
- `pricing.json` holds the model prices: take them from Anthropic's current pricing, never from memory, and bump `asOf`. `pricing()` and `/api/about` read it through `PLUGIN_ROOT`.
- Transcript paths come from job state only, which an agent or a checkout can write, so each id is checked before it becomes a path segment.
- Design: [Daemon security](../../../docs/architecture/daemon-security.md), [Daemon runtime](../../../docs/architecture/daemon-runtime.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `argv.ts` | Claude Code's command line and environment for a headless session: the permission-mode and effort flags, `daemon.command` to argv, a role child's argv, and the child's env. |
| `child.ts` | The real ClaudeAdapter: spawns claude as the leader of its own process group, feeds its stdout and stderr through the protocol (stream.ts), and signals the whole group to stop it. |
| `pricing.ts` | Model prices (lib/integrations/claude/pricing.json merged with config.usage.pricing) and the cost estimate built on them. |
| `role.ts` | One pipeline role as its own headless claude child: the launch, the brief as its only user message, the answers to its permission prompts, its end once the result is in (stdin closed, then SIGTERM, then SIGKILL to its process group), and the class of a failure. |
| `stream.ts` | Claude Code's stream-json protocol, with no I/O of its own: claude's output lines become ClaudeEvents, and every line written to its stdin is built here: the one fixed turn, permission answers and mode switches from a fixed list, an error reply that repeats claude's own capped subtype back to it, and two free-text lines: in a chat session only, the owner's own message (writeMessage), and in a role child only, the brief `forge job step` built (writeBrief, sent once by role.ts runRoleChild). |
| `transcripts.ts` | Claude Code transcripts of this repo's sessions and their agents, located from job state only. |
| `types.ts` | The shapes of a headless Claude Code child as the office sees it: the domain events its stream-json output means (ClaudeEvent), the handle that is the only way to write to it (ClaudeChild), and the adapter that starts one (ClaudeAdapter). |
<!-- forge:map:end -->
