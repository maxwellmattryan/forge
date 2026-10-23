# lib/api/

Forge's public contracts, with no Node imports: the `/api` and SSE shapes, the runtime lists they derive from, and the tracker adapter contract.

- Nothing here imports outside `api/`, Node built-ins included, so the dashboard type-checks these files without Node's types (the dashboard's `src/lib/types.ts` re-exports `types.ts` with `export type *`).
- `types.ts` is a type-only barrel (`export type *`) over the owner modules below, and every consumer imports it. The type modules import only `constants.ts` (only `enums.ts` does) and each other, with `import type` and no cycles; `constants.ts` and `versions.ts` import nothing.
- A new shape goes in the module that owns its endpoint or stream.
- An `/api/*` or SSE shape change appends a named step (`{ id: '<kebab-id>' }`) to `API_CHANGES` in `versions.ts`, whose length + 1 is `API_VERSION`, and sets the dashboard's literal to match; on conflict keep both, in merge order. `npm run check:dashboard` shows what the dashboard must handle.
- `tracker.ts` is a stable API for custom tracker adapters (docs/RELEASES.md): renaming or removing an export is a breaking change.
- Design: [Data and versioning](../../docs/architecture/versioning.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `config.ts` | The Settings modal's endpoints: /api/config, /api/doctor and /api/about. |
| `constants.ts` | The runtime lists the /api shapes in types.ts derive from, plus the daemon scopes the dashboard pins. |
| `daemon.ts` | The session pool: /api/daemon, /api/daemon/mode, /api/daemon/permission, /api/daemons/log and the /api/events SSE frames. |
| `enums.ts` | The unions the /api shapes share, each derived from its runtime list in constants.ts; the only type module that imports constants.ts. |
| `job.ts` | A job as job.json and events.jsonl hold it, as /api/state and /api/jobs/:id serve it. |
| `jobs.ts` | /api/jobs and /api/jobs/:id/*: the job detail, transcript and files, the job POSTs, and the environment routes with GET /api/environments. |
| `repo.ts` | What the repo holds outside any job: /api/project, /api/roster, /api/backlog with the tracker item, and /api/github/preview. |
| `state.ts` | GET /api/state, plus /api/requests, /api/focus and /api/budget/ack, whose replies are slices of it; and the shared JSON error body. |
| `stats.ts` | GET /api/stats, /api/evals and /api/evals/compare: the Analytics and Evals pages. |
| `tracker.ts` | The tracker adapter contract: the handful of statuses a job's stage and state collapse to. |
| `types.ts` | The /api/* and SSE shapes `forge dash` serves, type-only: a barrel over the owner modules mapped in lib/api/AGENTS.md. |
| `versions.ts` | The /api version steps: `apiVersion` is this list's length plus one. |
<!-- forge:map:end -->
