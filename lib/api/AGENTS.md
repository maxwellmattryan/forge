# lib/api/

Forge's public contracts, with no Node imports: the `/api` and SSE shapes, the runtime lists they derive from, and the tracker adapter contract.

- Nothing here imports outside `api/`, Node built-ins included, so the dashboard type-checks these files without Node's types (the dashboard's `src/lib/types.ts` re-exports `types.ts` with `export type *`).
- `types.ts` is type-only and imports only `constants.ts`; `constants.ts` imports nothing.
- An `/api/*` or SSE shape change bumps `API_VERSION` in `lib/core/job/schema.ts`; `npm run check:dashboard` shows what the dashboard must handle.
- `tracker.ts` is a stable API for custom tracker adapters (docs/RELEASES.md): renaming or removing an export is a breaking change.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `constants.ts` | The runtime lists the /api shapes in types.ts derive from, plus the daemon scopes the dashboard pins. |
| `tracker.ts` | The tracker adapter contract: the handful of statuses a job's stage and state collapse to. |
| `types.ts` | The /api/* and SSE shapes `forge dash` serves, type-only. |
<!-- forge:map:end -->
