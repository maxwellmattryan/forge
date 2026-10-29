# dashboard/src/lib/core/

The foundations every area imports: the app's state and actions, the `/api` types, shared helpers, the selected project, the login, display labels, request bodies and the shared clock.

- `types.ts` re-exports the engine's `#api/types.ts` with `export type *` and holds only the runtime constants the bundle needs, each pinned with `satisfies` to `#api/constants.ts`. Never redefine an `/api` shape here.
- `app.svelte.ts` is pinned at 675 lines in `test/invariants/dashboard-layout.test.ts`: it may only shrink, so new state or actions go in the module folder for their concern.
- Every per-project request goes through `projectApi` in `project.ts`. `login.ts` trades the login link's key for the HttpOnly cookie; no dashboard code reads or sends a token.
- Design: [Working on the dashboard](../../../AGENTS.md), [Dashboard security](../../../../docs/architecture/dashboard-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `app.svelte.ts` | The dashboard's state and actions, ported from the pre-Svelte app.js: same fetches, toasts and follow-up refreshes. |
| `clock.svelte.ts` | The one shared clock the board's and the drawer's relative times read, so "4s ago" ticks without new data. |
| `labels.ts` | Display names for stages and waiting reasons, typed as complete Records so tsc demands a label for every value lib/core/job/schema.ts defines. |
| `login.ts` | The page's half of the login link: `forge dash` prints `<origin>/?project=<name>#k=<key>`, and before the app mounts the page takes the key from the fragment, clears it from the address bar and history entry, then trades it once for the server's HttpOnly login cookie (POST /api/session). |
| `project.ts` | The selected project, which a project page's route sets (`#/p/<project>/…`, app.svelte.ts route()): every per-project request goes to `/api/p/<project>/…` through projectApi, while the machine's own `/api/about` and `/api/projects` never do. |
| `requests.ts` | The POST /api/requests bodies the dashboard's buttons send, and the toast a queued one shows. |
| `types.ts` | The forge dash HTTP API, for the dashboard. |
| `util.ts` | Shared dashboard helpers. |
<!-- forge:map:end -->
