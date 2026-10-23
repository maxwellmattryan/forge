# lib/office/

Forge's long-running runtime: the session pool, per-job sessions, the reconciler, the Foreman and notifications.

- `forge dash` runs the pool (`pool.ts`): one inbox session, an office session for gate requests when `foreman.enabled`, and per-job sessions. `owner.ts` says what a daemon session may not do.
- The session records and logs live in `lib/core/job/session-files.ts`, below engine, because engine modules write and read them too.
- `office` starts long-running listeners; their client code lives in `lib/integrations/`.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `foreman.ts` | The foreman: with `foreman.enabled`, a job parking on a gate the foreman decides becomes a `gate` request for the `_office` daemon session, which hands the judgement to a forge:assistant sub-agent and records the verdict with `forge job human … --actor foreman`. |
| `modes.ts` | The permission modes `forge dash`'s pool holds for its sessions: a human's choice per scope, and the default for job sessions without one. |
| `notify.ts` | Notifications: a small, fixed-shape message to the team's webhooks and command when a job needs a human, a PR opens or merges, a job fails, the daemon stops, a budget is exceeded or a secret is found. |
| `owner.ts` | What the daemon's session records say about who drives what: the ids `forge dash` sessions ran under (the supervisor expires their leases when they exit, lib/office/session/owned.ts and lib/office/pool.ts), and the refusals that keep the inbox and office sessions from driving a job. |
| `pool.ts` | The session pool `forge dash` supervises when `daemon.enabled`: one inbox session for requests with no job, an office session for gate requests when `foreman.enabled`, plus up to `daemon.maxConcurrent` job sessions, each spawned on demand for the job its requests name. |
| `reconcile.ts` | The reconciler: the one place that asks "is this running job being driven?" and acts when it is not. |
| `session-agents.ts` | What a job session's agents say about keeping it. |
| `session/` | One supervised headless Claude Code session (`createSession`) and the pieces it is built from. |
<!-- forge:map:end -->
