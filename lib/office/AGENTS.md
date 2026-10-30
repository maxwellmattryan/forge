# lib/office/

Forge's long-running runtime: the session pool, per-job sessions, the reconciler, the Foreman and notifications.

- `forge dash` runs one pool (`pool.ts`) per registered project: the intake runner (`inbox/runner.ts`) that answers the inbox's requests in code with `bin/forge` children, one at a time, an inbox session spawned only for a request type the runner doesn't handle, one office session for draft and direct requests, the gate runner (`foreman/run.ts`) that decides gate requests in code when `foreman.enabled`, up to `foreman.assistants.parallel` at once, and per-job sessions. No session takes a gate request. The pools share the machine cap through `slots.ts`; gate and intake runs count against neither cap. `session/permissions/owner.ts` says what a daemon session may not do.
- Only the gate runner records a foreman decision or hand-off: it holds the `ForemanAuthority` (`foreman/AGENTS.md`). Never pass one from a CLI path.
- The intake runner's claims and argv rules are in `inbox/AGENTS.md`: every call is a CLI child in the `_inbox` scope, never an in-process call.
- With `foreman.enabled` the pool also runs the Office pass (`forge office pass`, `mandates/pass.ts`) as a child (`inbox/children.ts`, like `forge sync`), one at a time; `mandates/cadence.ts` says when one is due (`passDue`, `passWantedAfter`, `mandatesPrint`) and schedules it (`createPassScheduler`). The pool's file is at its size cap: put new pool rules in a module beside it.
- A job scope's Session is the code driver (`code/job-driver.ts` `createCodeDriver`), which wraps a `createSession` and passes every call through under `daemon.driver: session`; the inbox, office and chats are plain sessions. Under `code` it runs every `forge` command as a child (`code/children.ts` `startForge`), never in the server, and it counts as one job session however many role runs it has.
- A pool session's child is started and handed work only through `startWork` in `slots.ts`, which also says what kind of session a scope is (`sessionKind`, `counted`): only job sessions count against `daemon.maxConcurrent` and the machine cap.
- A chat (scope `_chat-<id>`) is a shared session started only by its owner's message: the pool's `sendChat` hands it to `chat/send.ts`, the one path owner text takes to any session's stdin. The tick never routes or turns a chat.
- Whether a lease's driver is one of a session's ids is asked only of `driver.ts` (`drivenBy`, `whoDrives`), and everything a gone session held is let go only through its `releaseSession`: never compare `lease.driver` with a session id elsewhere.
- The session records and logs live in `lib/core/job/session-files.ts`, below engine, because engine modules write and read them too.
- `office` starts long-running listeners; their client code lives in `lib/integrations/`.
- Design: [Daemon](../../docs/architecture/daemon.md), [Daemon runtime](../../docs/architecture/daemon-runtime.md), [Foreman](../../docs/architecture/foreman.md), [Daemon security](../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `chat/` | The owner's chats with the Foreman: each chat's files in `.forge/runtime/chats/<id>/`, the one path an owner's message takes to its chat session, what a chat may not decide, and the brief a chat session reads first. |
| `code/` | Work the pool does in code instead of a model session: the code driver, and the `forge` children it runs. |
| `driver.ts` | Who drives a job and whether that driver is one of this pool's sessions, by every id the session has had; and the one release of everything a gone session held. |
| `foreman/` | The Foreman's gate decisions: the policy checks on every foreman decision, forge dash's gate runner that decides each `gate` request in code, its one-shot forge:assistant, and the verdict parser and gate table. |
| `inbox/` | The inbox's requests answered in code: forge dash's intake runner, its per-type plans, the one-shot forge:triage child inside a `next`, and the pool's `forge` children (the periodic sync and Office pass, and the intake calls). |
| `mandates/` | Mandates: the owner's standing instructions to the Office, one file each in `.forge/runtime/mandates/`, written by the owner through `mandateWrite` (`store.ts`), which `forge mandate new\|edit\|pause\|resume\|close` (`lib/cli/commands/mandate.ts`) and the dashboard's Office page (`lib/server/routes/mandates.ts`) both call, with the same checks. |
| `modes.ts` | The permission modes `forge dash`'s pool holds for its sessions: a human's choice per scope, the run's launch mode (`forge dash --permission-mode`) that the job, inbox and office sessions start in, and the default for job sessions, which starts at the launch mode and only the popover moves. |
| `notify.ts` | Notifications: a small, fixed-shape message to the team's webhooks and command when a job needs a human, a PR opens or merges, a job fails, the daemon stops, a budget is exceeded, a secret is found, the login service restarted with work in flight, or the Office pass stalled, paused at its budget or below its quality floor, or closed a mandate. |
| `pool.ts` | The session pool `forge dash` supervises when `daemon.enabled`: the intake runner (lib/office/inbox/runner.ts) that answers job-less requests in code (an inbox session spawns only for a type it doesn't handle), one office session for draft and direct requests, the gate runner (lib/office/foreman/run.ts) that decides gate requests in code when `foreman.enabled`, up to `daemon.maxConcurrent` job sessions, each spawned on demand for its job, and a session per chat (sendChat). |
| `reconcile.ts` | The reconciler: the one place that asks "is this running job being driven?" and acts when it is not. |
| `session/` | One supervised headless Claude Code session (`createSession`) and the pieces it is built from. |
| `slots.ts` | The machine cap's slot gate: one per machine dashboard, shared by every project's pool. |
<!-- forge:map:end -->
