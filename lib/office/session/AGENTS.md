# lib/office/session/

One supervised headless Claude Code session (`createSession`) and the pieces it is built from.

- The session reacts to `ClaudeEvent`s from `lib/integrations/claude/` and never parses claude's output; it writes to claude only through the `ClaudeChild` handle, whose lines `lib/integrations/claude/stream.ts` builds from fixed text. Every `log` event goes through `logLine`, which redacts known secrets before the file, the ring and SSE see it.
- `launch.ts`'s checks run before every spawn, on the one read of `.forge/config.yml` that argv is then built from: never add a second read between the digest and the argv.
- A session runs with the repo as cwd, so its executable is a bare `claude` or an absolute path, never a relative one (docs/architecture/daemon-security.md).
- Design: [Daemon runtime](../../../docs/architecture/daemon-runtime.md), [Daemon security](../../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `budget-cap.ts` | The dollar cap a job session's spawn passes as --max-budget-usd: what is left of the job's usd limit after its spent figure (the metered one when the supervisor has metered it), recomputed at every spawn because the flag caps one process. |
| `confine.ts` | What a daemon session may write: its write roots (the job folders and every worktrees root), the deny rules for the checkout's protected paths, the env that tells hooks/write-guard.ts the same roots, and the confine digest the post-turn check compares. |
| `contract.ts` | The session's contract with its pool: the events it reports, the context and options it is built with (sessionOptions fills in the real defaults), the child it supervises and the Session it returns. |
| `holds.ts` | What keeps a request waiting: a job parked on its budget, or the repo budget. |
| `launch.ts` | The checks every spawn passes before claude starts, on the one read of `.forge/config.yml` that argv is then built from. |
| `lifecycle.ts` | One supervised headless session. |
| `log.ts` | A session's log: `<scope>.log` on disk, the replay ring the dashboard reads, and the redaction every line gets on its way into both. |
| `meter.ts` | The supervisor's meter for one session: each result's cost, as a delta against a baseline held per spawn, appended to the scope's meter file (lib/engine/metrics/meter.ts), then enforced. |
| `owned.ts` | What a session answers for: whether its job's agents keep it (sessionAgents, which `forge daemon status` reads without loading the supervisor), the reconciler's facts, the one release (lib/office/driver.ts releaseSession) its exit runs over every id it has had, and the resumes its working turns took up. |
| `permissions/control.ts` | The permission-prompt and mode-switch policy: which prompts a human sees and which are denied unasked, the deny a prompt nobody answers within daemon.permissionTimeoutMinutes gets (with the session's in-memory history of those and its job's permission-timed-out event), and what a refused or unconfirmed mode switch does. |
| `permissions/history.ts` | The prompt history: one line per permission prompt a pool session answered (`.forge/runtime/permission-prompts.jsonl`), holding only the scope, tool, candidate rules, decision and reason, never the input, the agent's description, the blocked path or the suggested folders. |
| `permissions/suggest.ts` | The read-only report `forge daemon prompts` builds from the prompt history (history.ts): prompts grouped by exact candidate rule, ranked by how often each was asked, and the daemon.allowedTools rules a human may add by hand. |
| `records.ts` | What a session record (`.forge/runtime/daemons/<scope>.json`) says about its child, and reaping the children a dead `forge dash` left behind. |
| `timers.ts` | A session's two timers: the turn limit (daemon.turnTimeoutMinutes), which stops a hung turn, and the idle stop (daemon.idleStopMinutes), which stops a child nothing keeps; and its freshness: the inbox and the office start a new conversation at every spawn, and a job session whose turn's context passed daemon.freshAfterTokens stops at a safe boundary and starts its next spawn fresh. |
<!-- forge:map:end -->
