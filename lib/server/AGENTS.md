# lib/server/

The dashboard's HTTP server: `/api` endpoints, server-sent events and the built dashboard, for loopback Hosts only, with token- and Origin-checked POSTs.

- Preserve the security posture (docs/ARCHITECTURE.md "Dashboard security"): answer loopback Hosts only; every POST needs the token, a matching Origin and JSON.
- The static allowlist is `dashboard/dist/manifest.json`, so a new dashboard module needs no server change. An `/api` shape change bumps `API_VERSION` and changes `lib/api/types.ts`.
- `http.ts` holds every guard, and the route table in `start.ts` names each route's guards: dispatch runs the POST guard on every POST route, and a GET that does work or reads logs lists `read`, `token` or `queryToken`. A new route is a row there and a handler in `routes/`.
- Per-server state lives in `ServerCtx` (`types.ts`), built once per `startServer`, never at module level.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `http.ts` | The request guards and HTTP plumbing every route shares: the loopback Host check, the token, Origin, JSON and read guards, body readers and response writers. |
| `redact.ts` | Known values taken out of what the server pages and streams: a log or transcript page, and a per-stream reader of a job's known values. |
| `routes/` | The dashboard's route handlers, one file per area; the route table in `lib/server/start.ts` maps each method and path to one of them and names its guards. |
| `sse.ts` | Server-sent events: the stream head, state, line and text frames, following a file through one descriptor, the broadcast to open streams and the keep-alive ping. |
| `start.ts` | The dashboard's HTTP server (`forge dash`): startServer, the route table that names each route's handler and guards, and the dispatch that answers loopback Hosts only. |
| `static.ts` | The built dashboard and job images: the dist allowlist, the page with its token, hashed assets, the logo, and screenshots confined to the job dir. |
| `types.ts` | The server's shapes outside /api, type-only: startServer's options and result, the per-server context every route gets, the route table's rows, and what the onRequest hook reports. |
<!-- forge:map:end -->
