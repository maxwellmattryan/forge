# Daemon runtime: sessions

Part of [Daemon runtime](../daemon-runtime.md).

## Files

In `.forge/runtime/daemons/`, gitignored, unversioned.

`<scope>.json` holds `{sessionId, resumable, pid, serverPid, argv0, startedAt, spawnSessionId, lastTurnAt, logBase}`, and for a job scope the code driver's `driverId` ([Code driver](code-driver.md#code-driver)).

`<scope>.log` gets every child stdout line verbatim, except that a JSON line with neither claude's `timestamp` (only its `assistant` and `user` lines carry one) nor an `at` gets the receipt time as `at`, so every line has a time; non-JSON stdout as `forge-raw`, stderr as `forge-stderr` (4 KiB per line), and the supervisor's own events as `forge-daemon`.

The `forge-daemon` events are `spawn`, `turn` (with `requests` and the session's turn number), `result`, `exit`, `stop`, `idle-stop`, `waiting`, `finished`, `resume-failed`, `session-changed`, `held`, `retry` (with `at`, `reason`, `attempt`, `requests`), `reaped`, `error`, `line-truncated`, `wake` (a turn claude started by itself), `agents-lost` (with `job` and `roles`), `lease-expired` (with `job`, `session` and `reason`), `requeued` (with `requests` and `rejected`), `requests-closed` (with `requests`: the `resume` requests a working turn written for them took up), `reconcile` (with `action`), `turn-timeout` (with `minutes`), `meter` (with `usd`, `tokens` and `turn`, one per metered result), `rotated` (with `tokens` and `threshold`, once per child: see [Rotation](#rotation)); `stop` and `idle-stop` carry a `reason`.

A stdout line over 8 MiB is dropped and replaced by a `line-truncated` marker. Each session rotates its own log to `<scope>.log.1` at spawn once it passes 20 MiB or, with `retention.logMaxBytes` set, as soon as it reaches that size mid-session (one older generation is kept, logBase grows by the rotated size, and writes still pending on the old descriptor land in `.log.1`, which is why the rotated size counts them); `GET /api/daemons/log` pages from `.log` back into `.log.1` under the same confinement. It pauses its child's stdout while the log stream is full. Pool-wide events (a trust stop, a config refusal) are written to every live session's log.

A chat's session keeps these files under its `_chat-<id>` scope like any session, and its spend goes to `.forge/runtime/meter/_chat-<id>.jsonl`; the chat itself, `chat.json` and its `log.jsonl` history, lives in `.forge/runtime/chats/<id>/` ([Daemon](../daemon.md) › Chats). Gate runs have no session record: forge dash's gate runner keeps one JSON-lines gate log, `_gates.log` (`gate-start`, `gate-end`, `gate-held` and `error` lines), and meters into `.forge/runtime/meter/_gates.jsonl`.

Each session's own usage per turn (session usage, [Policies](../policies.md) › Usage accounting) goes, for the inbox, to `.forge/runtime/session-usage/_inbox.jsonl` (and `_office.jsonl`, which only the retired office session wrote; office runs write none) (one `{v, ts, scope, session, turn, model, usage, numTurns, durationMs, ok}` line per turn with usage), and for a job session to its job's `session-usage` events; chats and gate runs record none.

## Offsets

Every log line has an offset: `logBase` plus the line's byte position in `<scope>.log`. A rotation adds the rotated file's size to `logBase`, so offsets only grow. Offsets are the SSE ids and the history keys, so the dashboard merges live lines and older pages without duplicates. The last 200 lines of each session stay in memory for SSE replay.

## Session and resume

Each scope keeps its own session id. The inbox (`_inbox`) never resumes: every spawn (after an idle, slot or human stop, a failed start, a restarted `forge dash`) gets a new `--session-id <uuid>`, whatever the record's `resumable` says, so it never carries a conversation that grows without bound. Job and chat sessions resume: the first spawn gets a fresh `--session-id <uuid>`; once a child of that session has written a line, `resumable` is set and later spawns (a restarted `forge dash`, new work after an idle or slot stop) use `--resume <uuid>`, passing `--plugin-dir` again because resume does not restore it, until a job session rotates (below). A `system`/`init` with another `session_id` replaces the stored one (`session-changed`).

## Rotation

A job session retires its conversation once it grows past `daemon.freshAfterTokens` (default 200000; `null` never rotates), so a long job's every resume does not rewrite hundreds of thousands of tokens into the prompt cache; its next child rebuilds its state from `forge job step`.

At every `result` (working or failed) the stream reports the turn's **context**: the `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the turn's last main-loop `assistant` line (a subagent's line, with a non-empty `parent_tool_use_id`, never counts; neither does the cumulative cost the meter reads), each count finite and ≥ 0 or else 0; a turn with no such line has no reading and changes nothing. The first time a child's turn context is more than the threshold, the session sets `resumable: false` in its record (so whatever stops this child next, the next spawn gets a new session id), logs `rotated` with `tokens` and `threshold`, and is due to stop.

At that result and every later one, after the meter and the post-turn confine check, it stops at the first safe boundary: the child still runs, the session is `idle`, no running agent of its job keeps it (the `kept` rule), and claude's last `background_tasks_changed` reported no task. Until then the conversation keeps running; a background agent's end wakes the orchestrator, and that wake turn's result checks again (the `background` event itself never stops it: claude's wake `init` follows it at once).

The log then reads `rotated`, `stop` with `reason: "rotate"`, `exit`, `lease-expired` with `reason: "rotate"` and `requeued`: the usual release, with no agents lost since none ran. The session stays wanted, so its next work (a new request, or the reconciler's resume of the job whose lease expired) spawns a child on a new conversation, metered from a baseline of 0. The inbox and chat sessions never rotate.

A `--resume` child that exits non-zero without ever emitting `system`/`init` lost its transcript: the supervisor logs `resume-failed`, undoes whatever that child's error `result` committed, starts one fresh session and re-ticks, without counting a failure.

## Failures

Failures are per session. A spawn `error` with no pid (ENOENT, EACCES) stops wanting that session (`cannot start daemon: …`), with no retry. Unexpected exits with no `result` since spawn are counted; at 3 the session stops wanting itself (`daemon stopped after 3 failed starts: …`); any `result` resets the count. `idleStopMinutes` ends stdin and stops an idle child, keeping the session wanted. The window counts from the later of the last spawn or `result` and the last agent end, and never runs out while a running agent keeps the session.

**Lost agents:** whenever a job session's child exits, for any reason (pool or session stop, `forge dash` shutdown, a trust change or other pool-wide stop, a permission-mode narrowing, failed-turn strike-out, a job-finished or idle stop, a crash), every agent still marked `running` on a job one of its ids drives is ended with status `lost` and summary `lost: its daemon session ended`, through the same `recordAgent` path as `forge job agent <id> end --status lost` (an `agent-end` job event), and the session logs one `agents-lost` with `job` and `roles` per job. It happens before the stop resolves. Agents that already ended, and another owner's agents, are never touched, so the next session's `step` respawns the role (L1) or retries the reviewer (M1) instead of waiting on phantoms (G5).

A job that finishes (`done` or `cancelled`) with an agent still marked `running` ends it the same way in the write that finishes it, with summary `lost: the job was <state> while it ran` and an `agent-end` event, and a job an older Forge finished that way reads as `lost` (no event), so nothing waits on an agent a finished job can never end. A failed `job.json` read or write here is logged as an `error` and the exit still completes. The synchronous last-resort SIGTERM from an `exit` handler marks nothing; the next orchestrator handles those agents as before.

A `result` with `is_error` (claude reports an expired login or an exhausted quota that way, often with subtype `success`) means no request made progress: the child stays up, nothing is committed, and the session's `lastError` reads `last turn failed: …; retry at <time>` until a turn works or the session is stopped on purpose, so the dashboard shows it failing rather than idle. The session writes no turn before that time, which a `retry` log line records with its `reason` and `attempt`: when the child printed a `rate_limit_event` with `status: "rejected"` during the turn, the retry is at that window's `resetsAt`; otherwise it is a backoff that doubles from 1 minute (5 minutes for a limit without a reset time, such as an API key's spend cap) to 1 hour.

A failure is a `limit` when that event was seen or the message says so (usage or rate limit, 429, 529, overloaded): limits are retried for as long as it takes. Any other failure is a strike, and at 3 in a row the session stops wanting itself (`daemon stopped after 3 failed turns: …`) and stops its child so the slot frees. A `result` whose `subtype` is `error_max_budget_usd` (the child reached the `--max-budget-usd` cap its spawn passed, logged as `capUsd` in the `spawn` line) is a failed turn whatever `is_error` says, never a limit, and stops the session at once the same way, with a `lastError` naming the cap and the child stopped with reason `budget-cap`.

A working turn clears the strikes and the backoff, as does a human's Start. In every case the other sessions keep running and the pool stays wanted; a session that isn't wanted spawns nothing until a human starts it (or the whole pool) again. What is repo-wide stops the whole pool and every child, with the error on the pool and in every session log: a trust-digest change, `daemon.enabled: false` at spawn, a `daemon.*` config problem, and symlinks under `.forge/trackers/`.

## Start and stop

A pool start (dashboard Start, or `forge dash` booting with `enabled: true`) refuses while another live `forge dash` owns any record; otherwise it wants the pool, resets every session's wanted flag, failures and error, takes a new trust snapshot only when no child runs anywhere, and ticks. Stop stops every child. One session can be started (only inside a wanted pool, and never with a new snapshot) or stopped from its job panel's header (the Inbox session from its log; the office session is retired, so there is none to start or stop); a stopped job session stays listed and spawns nothing for new work until started again.

## Effort

At every spawn, a session resolves its effort with `resolveEffort` (`lib/core/config/models.ts`), the one place levels combine. A session runs the orchestrator, so it resolves with no role: its job's `job.effort`, else `runtime.effort`, from the config bytes that spawn just hashed and the `job.json` read then. The inbox uses `runtime.effort` alone, and so does a session whose job is missing or unreadable. A level adds `--effort <level>` to argv after Forge's `--permission-mode` and before `--disallowedTools`, replacing every `--effort x` and `--effort=x` in `daemon.command`; with none, Forge passes nothing and the template's own `--effort`, if any, applies.

The log records `{"event":"effort","level":<level> | "inherit","source":"job" | "config" | "none"}` right after `spawn` (a session never gets the `panel`, `role` or `complexity` sources that `resolveEffort` gives agents), and the session's `effort` in `/api/state` is the level its running child got (null while none runs, or when Forge passed none). A changed effort never stops, signals or messages a running child: it applies at that session's next spawn (an idle stop, a slot handover, a human's stop and start).

Agents inherit their session's effort, since no `forge:*` agent's frontmatter sets one, and also get the level explicitly: every `spawn` from `forge job step` carries `effort` and every brief an `Effort:` line, which the orchestrator passes as the Agent tool's `effort`. An agent's level is resolved for its role: `job.effort`, the lens's panel `effort`, `runtime.efforts.<role>`, `runtime.effortByComplexity[job.complexity]`, then `runtime.effort`, and a builder on round 2 or later gets one level more unless the job's own effort set it. So agents started after a change already run at the new level while the session itself switches at its next spawn.

## Stopping and orphans

Children are spawned `detached` with no shell, so each leads its own process group. A stop SIGTERMs the group and SIGKILLs it after 5 s. `forge dash` stops every session on SIGTERM/SIGINT before exiting, and an `exit` handler sends a synchronous SIGTERM to each as a last resort. `forge dash --stop` signals the server only when `dashboard.json` is proven to name it (["Daemon security"](../daemon-security.md)) and waits up to 12 s for it; a stale record is cleared without signalling anything, so `stopped` is false. Either way it then reaps (`daemonReaped: true` when anything was). A pool being created also reaps.

Each record (every `daemons/<scope>.json`, regular files with a valid scope name only) is proven on its own: if it names a live pid whose server is gone, the pid is signalled only after it is proven to be the recorded child: it is > 1 and not us or our group, it leads its own process group, `ps` reports a start time within 30 s of `startedAt`, its command line contains the recorded `claude` executable and `--session-id`/`--resume` followed by the recorded uuid. A live `serverPid` other than ours in any record means another dashboard owns the daemon, and a pool start refuses. None of this runs on Windows, so on native Windows a pool start is refused outright (`lastError` says why and links [SUPPORT.md](../../SUPPORT.md)), nothing is spawned, and the dashboard serves without the daemon; `forge dash` prints the refusal (`daemonRefused` under `--background`) and skips the `daemon.auth` question.

## Recorded framing

Recorded with claude 2.1.296, headless run in a scratch repo with the default `command` and `--plugin-dir` pointing at this checkout. The only line the daemon writes, `TURN_LINE`:
```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"/forge requests"}]}}
```
followed by `\n`. Observed on stdout, one JSON object per line:
- `system`: `hook_started`, `hook_progress`, `hook_response`, `commands_changed`, `init` (at the start of every turn, carrying `session_id`, `agents` with the `forge:*` roles, `slash_commands` with `forge:forge`, `plugins` with this checkout as `forge@inline`, and `permissionMode`, the mode `daemon.command` passes), `task_started` / `task_updated` / `task_notification` around a subagent, `thinking_tokens`.
- `assistant`: content blocks `thinking`, `text`, `tool_use` (an `Agent` call with `subagent_type: "forge:builder"` ran the plugin's builder and returned a `tool_result`).
- `user`: `tool_result` blocks; a subagent's own messages carry `parent_tool_use_id`.
- `rate_limit_event`.
- `result`: one per turn (`subtype: "success"`, `is_error: false`, `num_turns`, `result`, `session_id`), the same `session_id` across turns of one process. Each also carries `total_cost_usd` and `modelUsage` (per model: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`). This repo's own session logs (Claude Code 2.1.3xx) settle how they count: both are cumulative per conversation, growing across every turn of a process; they carry over a `--resume` (the `_office` log shows 57 spawns and no drop, and `_inbox` grew from $34 to $65 across resumed spawns over two days); they include background subagents (an `opus` builder's cost appears in the `sonnet` orchestrator's result); and a fresh session id starts again from 0. `usage` on the same line is the main loop's last turn only, which is why it is the session-usage record's source (`turn-ended`'s `usage`, "Session usage" in [Policies](../policies.md)) and never the meter's. The supervisor meters these (`turn-ended`'s `cost`, "Metered spend" in [Policies](../policies.md)), logging a `meter` event (`usd`, `tokens`, `turn`) per record in the session log.

`/forge requests` is expanded headless as the plugin's skill: the session ran the skill's opening `forge doctor`, `forge sync`, `forge requests`. A second stdin turn in the same process produced a second `result` with the same `session_id`; closing stdin made the process exit 0; a new process with `--resume <id> --plugin-dir <checkout>` accepted a turn and remembered the first process's conversation. `--resume` of an unknown id prints one `{"type":"result","subtype":"error_during_execution","is_error":true,"num_turns":0,…}` line, `No conversation found with session ID: <id>` on stderr, and exits 1.
