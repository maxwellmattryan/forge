# Daemon runtime: the code driver

Part of [Daemon runtime](../daemon-runtime.md).

## Code driver

Under `daemon.driver: code` a job scope's Session is lib/office/code/job-driver.ts ([Daemon](../daemon.md) › Code driver says which turns it takes). Its id, `driverId`, is a uuid in the scope's record (`.forge/runtime/daemons/<id>.json`), made once and kept across turns and `forge dash` restarts; a value that is not a uuid is replaced. While a turn runs the scope reports `running`, `busy` and `sessionId: driverId`, and `facts().ids` includes it, so the dashboard and the reconciler see the job driven by its own session.

### A turn

*A turn*:
- a session child left from a fallback turn stops first;
- then `forge job claim <id> --session <driverId>` (exit 3, another live driver: every open request of the turn, whatever its type, is closed `rejected`, `job is driven by session <driver>`; exit 4, blocked: each non-resume request is still applied as below, then the resumes are closed `done` with the CLI's message; any other failure: `rejected` with it, and an `error`);
- then each request of the turn, oldest first, through `forge job apply <id> --request <rid> --session <driverId>` (argv holds only the job id and a request id in the request grammar, never request text): exit 0 logs `applied` with `request`, `requestType`, `status` (`done`, `rejected` or `pending`, a plain resume left for the step loop), `result` and the request's `createdAt`; exit 3 logs `apply-skipped`; anything else is an `error` and `lastError`, and the turn goes on;
- then `forge job advance <id> --session <driverId> --epoch <epoch> --json`, acted on through the moves table (lib/office/code/moves.ts, pure).

A `spawn` starts one `forge job agent run … --role <role> --ipc` per role in `[action, ...spawns]` that has no runner of this driver in flight, all in one tick, waits for each to report `started` (or exit), then advances at once when the action is `parallel` and otherwise after a runner exits. A wait on `agents` waits for the next runner exit while one is live, and otherwise ends each role in `running` `lost` through `forge job agent <id> end --status lost` (a phantom no driver runs) and advances. A wait on a gate, or `done`, ends the turn.

A `procedure` (only RC1's recall eval: its reviews are no job agents `forge job agent run` can run) waits for the live runners, then hands off: the lease is let go, the turn's resumes are closed, one fresh `resume` is queued (`from: code-driver`, the fixed `HANDOFF_TEXT`) and given to the wrapped session as its turn.

A failed advance is tried again, up to 3 in a turn, and its own repeated-failure park (`parked: true`) ends the turn; one capped at `--max` is tried again, up to 10. Advance's exit 3 is a takeover: the live runners stop.

A runner that ends `done`, or `stale_step`, advances; `limit` lets the other runners finish and ends the turn with its requests pending until `resetsAt` (else a backoff from `retryMinMs`, doubling to `retryMaxMs`), during which `route()` is not fresh; `untrusted` stops the pool on the trust change; `auth`, `budget`, `error` or `timeout` advance, so step's L1 respawns the role, and park the second time for the same role in a turn; exit 5 (`exit`, `spawn`) parks; anything it can't read (a signal, exit 2, unparseable output) ends the role `lost` first and kills the role child's group the runner reported, then parks. A `secret_found` from any child parks on `human`.

A park is `forge job set <id> --state waiting --waiting-on escalation --reason=code driver: <what>: <detail> --epoch <epoch>`, one line of at most 200 characters in the joined `--reason=` form, made only while the job is `running`; one that can't be made is an `error` and `lastError`, never silent. More than 200 advances in a turn park too.

*The turn's end* (a gate, `done`, a park, a takeover, a limit, a stop): no child is left running, `releaseSession` runs over `driverId`, the turn's resumes are closed `done` (`RESUME_TAKEN_UP`) except after a limit or a stop, and the pool reconciles and ticks.

### IPC, log and stop

*IPC*: a runner sends `{type: 'forge-role', role, event}` messages, `started` once its start is recorded, `child` with the role child's pid, `reply` at the child's first assistant message, `ask` with `requestId, tool, input, description, agentId, blockedPath, rules, dirs` for each `can_use_tool`, and `cancel` for one claude withdrew; the driver answers an ask with `{type: 'forge-answer', requestId, decision, why?}` to that runner only.

Asks go through the relay (lib/office/code/relay.ts): each field is checked by type and length, a prompt shows in `/api/state` under the job with `role`, and it is answered through `POST /api/daemon/permission` and audited as `daemon-permission` like a session's, with the same unasked denies, `daemon.permissionTimeoutMinutes` and prompt history.

*Log*: the scope log gets `forge-daemon` lines `driver-start`, `claim`, `applied`, `apply-skipped`, `ran` (one per advance entry), `role-start` (with the runner's `pid`), `role-reply`, `role-end`, `fallback` (only a hand-off turn routed to the session later), `handoff`, `park`, `retry`, `driver-end` and `error`, each with a `message` and its `at`.

A dashboard approve's time to the next agent start is the `role-start` line's `at` minus the `applied` line's `createdAt`. `role-reply` carries `handoffMs`, the milliseconds from the exit of the runner whose end led to this spawn to this child's first assistant message (null for a turn's first role): the hand-off metric.

*Stop* (a session or pool stop, a close): SIGTERM to every forge child, so each runner interrupts its role child and ends the role `interrupted`; SIGKILL after `graceMs`; the lease is let go and the requests stay pending. The exit handler's `killSync` sends SIGTERM to all of them, and the next pool boot releases `driverId` with every recorded id.
