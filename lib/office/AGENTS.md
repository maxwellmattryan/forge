# lib/office/

Forge's long-running runtime: the session pool, per-job sessions, the reconciler, the Foreman and notifications.

- `forge dash` runs the pool (`pool.ts`): one inbox session, an office session for gate requests when `foreman.enabled`, and per-job sessions. `owner.ts` says what a daemon session may not do.
- Whether a lease's driver is one of a session's ids is asked only of `driver.ts` (`drivenBy`, `whoDrives`), and everything a gone session held is let go only through its `releaseSession`: never compare `lease.driver` with a session id elsewhere.
- The session records and logs live in `lib/core/job/session-files.ts`, below engine, because engine modules write and read them too.
- `office` starts long-running listeners; their client code lives in `lib/integrations/`.
- Design: [Daemon](../../docs/architecture/daemon.md), [Daemon runtime](../../docs/architecture/daemon-runtime.md), [Foreman](../../docs/architecture/foreman.md), [Daemon security](../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `driver.ts` | Who drives a job and whether that driver is one of this pool's sessions, by every id the session has had; and the one release of everything a gone session held. |
| `foreman.ts` | The Foreman's session side: who owns a gate for the dashboard, the checks on a foreman decision and on the office's `forge job set`, and hand-offs; the gate policy is lib/engine/pipeline/moves/foreman-gates.ts. |
| `modes.ts` | The permission modes `forge dash`'s pool holds for its sessions: a human's choice per scope, and the default for job sessions without one. |
| `notify.ts` | Notifications: a small, fixed-shape message to the team's webhooks and command when a job needs a human, a PR opens or merges, a job fails, the daemon stops, a budget is exceeded or a secret is found. |
| `owner.ts` | The refusals that keep the inbox and office daemon sessions from driving a job: the inbox only routes and the office only decides gates. |
| `pool.ts` | The session pool `forge dash` supervises when `daemon.enabled`: one inbox session for requests with no job, an office session for gate requests when `foreman.enabled`, plus up to `daemon.maxConcurrent` job sessions, each spawned on demand for the job its requests name. |
| `reconcile.ts` | The reconciler: the one place that asks "is this running job being driven?" and acts when it is not. |
| `session-agents.ts` | What a job session's agents say about keeping it. |
| `session/` | One supervised headless Claude Code session (`createSession`) and the pieces it is built from. |
| `sync-child.ts` | The periodic `forge sync` child of `forge dash`: outside any daemon scope, as the human who started the dashboard, with git pinned (SYNC_PINS) so a hook or program the checkout's config names never runs on its fetches. |
<!-- forge:map:end -->
