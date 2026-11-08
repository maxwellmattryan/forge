# Daemon runtime: the HTTP surface and terminal

Part of [Daemon runtime](../daemon-runtime.md).

## HTTP surface

Consumed by the dashboard; every route below is a project route, served at `/api/p/<project>/…`.

### State

`/api/p/<project>/state` has:
- `config.daemon: {enabled, jobBudget, billing}` (`billing` is `{ vars, passed, warn }` for the API keys, provider switches and `ANTHROPIC_BASE_URL` set in `forge dash`'s environment, which sessions inherit, or null when none is; `warn` is true when a provider switch or `ANTHROPIC_BASE_URL` is among them, `forge doctor`'s rule; the Workers popover shows a line while it is non-null, in warning tone only when `warn`), `config.effort`
- and `daemons: {enabled, wanted, maxConcurrent, live, lastError, needsApproval, inbox, office, foreman, gates, jobs, clients}` (`foreman` is `foreman.enabled` from the latest config read; `office` is the office runner's `{enabled, live, held, runs}`, the live office run and the 50 latest, newest first, not seeded across restarts; `gates` is the gate runner's `{enabled, parallel, live, held, runs}`, `runs` being the live gate runs and the 50 latest, newest first, each `{request, gate, job, mandate, status, outcome, reason, startedAt, endedAt, attempts, usd, tokens}`; `needsApproval` is true while the machine dashboard keeps this project's pool off until a human presses Start, see ["Daemon security"](../daemon-security.md)),
- and each job row has `gateOwner` (`foreman`, `human`, or `null` when it waits on nothing or the foreman is off),
- where `inbox`, `office` and each `jobs[id]` are `{scope, wanted, running, status, sessionId, pid, lastTurnAt, lastResultAt, turns, failures, held, waiting, lastError, permissions, permissionMode, kept, effort, contextTokens}` (`kept` is `"agents"` while a child runs, the session isn't `stopping` and a running agent keeps it, else `null`; `effort` is the `--effort` Forge passed the running child, else `null`; `contextTokens` is the running child's latest turn context ([Rotation](sessions.md#rotation)), `null` while no child runs or before its first reading, for every session kind; the Workers popover appends it to a job session's row as ` · 245k context`);
- `jobs` lists a session while it runs or stops, waits, is held, has an error, or was stopped by a human.

### Streams and log pages

`GET /api/events?session=<scope>` streams that session's `event: state` on connect (an off state for an unknown session) and on every change, its buffered lines after `Last-Event-ID`, then `event: line` with `id: <offset>` per new line (lines over 64 KiB become a `forge-truncated` marker), and `: ping` every 15 s; lines of other sessions are never sent.

`GET /api/daemons/log?session=<scope>&before=<offset>` returns a page of complete lines read backwards from `before` (at most 256 KiB or 1000 lines, lines over 64 KiB as markers at their real offset, at most 16 MiB scanned) as `{scope, lines: [{offset, line}], start, end, more}`; only the current `<scope>.log` is served.

### Pool, requests and jobs

`POST /api/daemon {"action":"start"|"stop", "scope"?}` answers 200 with the pool state; without a scope it starts or stops the pool (409 `{error}` for `start` while `daemon.enabled` is false or the `daemon.*` config has a problem), with one it starts or stops that session (400 for an invalid scope, 404 for an unknown job, 409 `start the daemon first` for a scoped start while the pool isn't wanted).

`POST /api/requests` answers with the request plus `daemon: <pool wanted>`, and 400 for a `gate` request (only the CLI writes those), for a `run` without a valid `args.ref`, an `args.link` outside `approve` or not `new`, `none` or a ref, or an `args.n` outside `next` or 1..16.

`POST /api/jobs {text, title?}` creates a job (title derived from the text unless given; 400 for missing, blank or over-20,000-character text or an empty title, 409 before `/forge init`), queues its `resume`, and answers `{id, title, branch, request, daemon}`.

`POST /api/jobs/<id>/effort {"effort": "low" | "medium" | "high" | "xhigh" | "max" | null}` sets or (null) clears the job's effort through the same `setJobEffort` as `forge job effort`, and answers `{id, effort, previous, changed}`; it works while the pool is wanted, because `job.json` is outside the trust digest, and is 400 for any other body and 404 for an unknown id or `_inbox`.

`POST /api/jobs/<id>/repos {"decision": "approve" | "reject", "repos": [names], "note"?: string | null}` decides a job's pending repo proposals through `decideRepoProposals` with the dashboard as actor, and answers `{id, decision, repos, added, pending, resumed}`; when nothing is left pending and the job sits on the RP1 park it sets the job running and queues a `resume` unless a live session holds it (`resumed`). It is 404 for an unknown id, 400 for any other body (a `repos` that isn't a non-empty list of repo names, or a note over 2,000 characters), and 409 when nothing is pending, when `repos` is not exactly the pending set, or when a clone check fails.

`GET /api/jobs/<id>` includes the job's `requests` (every status, oldest first, the last 50) and `request`, its `request.md` without the title line (at most 2,000 characters), which opens the drawer's Thread, with `requestTruncated` true when it was cut (the Thread's **Show the whole request** then reads `request.md` through `GET /api/jobs/<id>/file`), and `requestFromTracker`, true only when the job's `created` event carries an issue with a ref (its `issues`, or a pre-v11 `source`; a job started from an issue), so a job linked later still shows `request` as the user's words.

## Terminal

`forge daemon status` prints the dashboard and every session record from the runtime files (no server call). `dashboard` comes from the machine dashboard's record, `<FORGE_HOME>/dashboard.json`, else this repo's legacy `.forge/runtime/dashboard.json` (an older per-repo `forge dash`). It is `{pid, url, alive: true}` only when that record is proven to name a running `forge dash` (["Daemon security"](../daemon-security.md)); a record that names an integer pid but fails the proof is `{pid, url: null, alive: false}`, and no record (or no integer pid) is `null`.

Each session has `{scope, job, pid, alive, sessionId, startedAt, lastTurnAt, logBytes, kept, agents}`: `agents` lists the sorted roles of the running agents of the job that session owns (read from the record's `sessionId` and the job's `job.json`), and `kept` is `"agents"` when one of them keeps it; both are `null` and `[]` when the session is not alive, is the inbox or the office, or owns no agents. The office sorts right after the inbox, then the jobs.

`forge daemon log <job>|--inbox|--office|--gates [--lines N] [--follow]` (combining two of `--inbox`, `--office` and `--gates`, or `--gates` with a job, is a usage error) prints a session log's tail, or with `--gates` the gate log's, as raw JSONL with every C0/C1 control character escaped, and `--follow` keeps printing new lines across rotations.
