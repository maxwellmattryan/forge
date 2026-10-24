# lib/server/

The machine's dashboard HTTP server: one per machine, serving every project registered in the machine index under `/api/p/<project>/`, plus the page, its assets and the machine's own `/api` endpoints, for loopback Hosts only, with token- and Origin-checked POSTs.

- Preserve the security posture (docs/architecture/dashboard-security.md): answer loopback Hosts only; every POST needs the token, a matching Origin and JSON.
- The static allowlist is `dashboard/dist/manifest.json`, so a new dashboard module needs no server change. An `/api` shape change appends a named step to `API_CHANGES` in `lib/api/versions.ts` (on conflict keep both, in merge order) and changes its owner module in `lib/api/`.
- `http.ts` holds every guard, and the two route tables in `start.ts` name each route's guards: `ROUTES` (machine routes, matched on the full path) and `PROJECT_ROUTES` (matched on the path after `/api/p/<project>`). Dispatch runs the POST guard on every POST route and every row's guards before it resolves the project, and every GET under `/api` lists `read`, plus `token` or `queryToken` when it does work or streams a session or transcript. A new route is a row in one table and a handler in `routes/`.
- Machine-wide state lives in `MachineCtx` and each project's in its `ServerCtx` (`types.ts`, built by `machine.ts`), both once per `startServer`, never at module level. A project route's event stream is keyed `<project>/<scope>`, so one project's frames never reach another's stream.
- Design: [Dashboard security](../../docs/architecture/dashboard-security.md), [Daemon security](../../docs/architecture/daemon-security.md).

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `http.ts` | The request guards and HTTP plumbing every route shares: the loopback Host check, the token, Origin, JSON and read guards, body readers and response writers. |
| `machine.ts` | The machine dashboard's project entries: one per project registered in the machine index whose directory exists, each with its own context, caches and pool (booted under the old per-repo rule), kept in step with the index by a throttled re-read, and summarised for GET /api/projects. |
| `redact.ts` | Known values taken out of what the server pages and streams: a log or transcript page, and a per-stream reader of a job's known values. |
| `routes/` | The dashboard's route handlers, one file per area; the two route tables in `lib/server/start.ts` map each method and path to one of them and name its guards. |
| `sse.ts` | Server-sent events: the stream head, state, line and text frames, following a file through one descriptor, the broadcast to open streams and the keep-alive ping. |
| `start.ts` | The machine's dashboard HTTP server (`forge dash`): startServer, the two route tables (the machine's, and each project's under /api/p/<project>/) that name each route's handler and guards, and the dispatch that answers loopback Hosts only. |
| `static.ts` | The built dashboard and job images: the dist allowlist, the page with its token, hashed assets, the logo, and screenshots confined to the job dir. |
| `types.ts` | The server's shapes outside /api, type-only: startServer's options and result, the machine context and the per-project context routes get, a loaded project entry, the route tables' rows, and what the onRequest hook reports. |
<!-- forge:map:end -->
