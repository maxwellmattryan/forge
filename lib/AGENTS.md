# lib/

Forge's engine, in seven lib layers that import downward only: api, core, integrations, engine, office, server, cli.

- A file imports its own layer and the ones below it (`cli` → `server` → `office` → `engine` → `integrations` → `core` → `api`); `test/invariants/layers.test.ts` holds the rule, with the shrinking upward edges in `test/invariants/layer-map.ts`. Imports across layers use the `package.json` aliases (`#core/…`; none for `server` or `cli`); imports inside a layer stay relative. docs/design/lib-layout.md says what each layer holds.
- A new file goes in `lib/<layer>/<module>/`, opens with a header comment whose first sentence says what it holds, and stays under 600 lines. Folders hold 3–12 entries, with no `index.ts` and no name that repeats its folder (`test/invariants/layout.test.ts`).
- Read a folder's `AGENTS.md` before working in it. Each row below is a folder's first sentence or a file's header comment: edit those, then run `npm run docs:map`.
- `trackers/status.ts` and `trackers/status.mjs` are deprecated re-exports of `api/tracker.ts` for custom tracker adapters, removed one minor release after the move ships.
- Design: [Architecture](../docs/ARCHITECTURE.md), [Layers](../docs/architecture/layers.md), [Why a CLI does the bookkeeping](../docs/architecture/cli-bookkeeping.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `api/` | Forge's public contracts, with no Node imports: the `/api` and SSE shapes, the runtime lists they derive from, and the tracker adapter contract. |
| `cli/` | The `forge` command: the entry that routes, the command groups and the activity log. |
| `core/` | Foundations with no pipeline policy: shared shapes, the job store and schema, config, paths, errors, and OS and text helpers. |
| `engine/` | What Forge does: the pipeline, worktrees, PRs, tracker sync, guards, releases, environments, evals, metrics and operations. |
| `integrations/` | Code that knows an outside system's API, CLI or file format, one folder per system: mechanism only, never pipeline policy. |
| `office/` | Forge's long-running runtime: the session pool, per-job sessions, the reconciler, the Foreman and notifications. |
| `server/` | The machine's dashboard HTTP server: one per machine, serving every project registered in the machine index under `/api/p/<project>/`, plus the page, its assets and the machine's own `/api` endpoints, for loopback Hosts only, with token- and Origin-checked POSTs. |
| `trackers/status.mjs` | Deprecated: import lib/api/tracker.ts. |
| `trackers/status.ts` | Deprecated: import lib/api/tracker.ts. |
<!-- forge:map:end -->
