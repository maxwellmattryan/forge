# lib/office/

Forge's long-running runtime: the session pool, per-job sessions, the reconciler, the Foreman and notifications.

- `forge dash` runs one pool (`pool.ts`) per registered project: one inbox session, one office session for draft and direct requests, up to `foreman.assistants.sessions` assistant foremen that claim gate requests when `foreman.enabled`, and per-job sessions. The pools share the machine cap through `slots.ts`. `owner.ts` says what a daemon session may not do.
- With `foreman.enabled` the pool also runs the Office pass (`forge office pass`, `mandates/pass.ts`) as a child (`sync-child.ts`, like `forge sync`), one at a time; `mandates/cadence.ts` says when one is due (`passDue`, `passWantedAfter`, `mandatesPrint`) and schedules it (`createPassScheduler`). The pool's file is at its size cap: put new pool rules in a module beside it.
- A pool session's child is started and handed work only through `startWork` in `slots.ts`, which also says what kind of session a scope is (`sessionKind`, `counted`): only job sessions count against `daemon.maxConcurrent` and the machine cap.
- Whether a lease's driver is one of a session's ids is asked only of `driver.ts` (`drivenBy`, `whoDrives`), and everything a gone session held is let go only through its `releaseSession`: never compare `lease.driver` with a session id elsewhere.
- The session records and logs live in `lib/core/job/session-files.ts`, below engine, because engine modules write and read them too.
- `office` starts long-running listeners; their client code lives in `lib/integrations/`.
- Design: [Daemon](../../docs/architecture/daemon.md), [Daemon runtime](../../docs/architecture/daemon-runtime.md), [Foreman](../../docs/architecture/foreman.md), [Daemon security](../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `driver.ts` | Who drives a job and whether that driver is one of this pool's sessions, by every id the session has had; and the one release of everything a gone session held. |
| `foreman.ts` | The Foreman's session side: who owns a gate for the dashboard, the checks on a foreman decision and on an office or assistant foreman session's `forge job set`, and hand-offs; the gate policy is lib/engine/pipeline/moves/foreman-gates.ts. |
| `mandates/` | Mandates: the owner's standing instructions to the Office, one file each in `.forge/runtime/mandates/`, written only by `forge mandate` (`lib/cli/commands/mandate.ts`). |
| `modes.ts` | The permission modes `forge dash`'s pool holds for its sessions: a human's choice per scope, and the default for job sessions without one. |
| `notify.ts` | Notifications: a small, fixed-shape message to the team's webhooks and command when a job needs a human, a PR opens or merges, a job fails, the daemon stops, a budget is exceeded, a secret is found, the login service restarted with work in flight, or the Office pass stalled, paused at its budget or closed a mandate. |
| `owner.ts` | The refusals that keep the inbox, office and assistant foreman daemon sessions from driving a job: the inbox only routes, the office does not drive jobs and the assistant foremen only decide gates. |
| `pool.ts` | The session pool `forge dash` supervises when `daemon.enabled`: one inbox session for requests with no job, one office session for draft and direct requests, up to `foreman.assistants.sessions` assistant foremen that take gate requests when `foreman.enabled`, plus up to `daemon.maxConcurrent` job sessions, each spawned on demand for the job its requests name. |
| `reconcile.ts` | The reconciler: the one place that asks "is this running job being driven?" and acts when it is not. |
| `session-agents.ts` | What a job session's agents say about keeping it. |
| `session/` | One supervised headless Claude Code session (`createSession`) and the pieces it is built from. |
| `slots.ts` | The machine cap's slot gate: one per machine dashboard, shared by every project's pool. |
| `sync-child.ts` | The periodic children of `forge dash`, `forge sync` and the Office pass (`forge office pass`): outside any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or program the checkout's config names never runs on their fetches. |
<!-- forge:map:end -->
