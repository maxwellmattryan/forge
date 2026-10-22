# lib/server/

The dashboard's HTTP server: `/api` endpoints, server-sent events and the built dashboard, for loopback Hosts only, with token- and Origin-checked POSTs.

- Preserve the security posture (docs/ARCHITECTURE.md "Dashboard security"): answer loopback Hosts only; every POST needs the token, a matching Origin and JSON.
- The static allowlist is `dashboard/dist/manifest.json`, so a new dashboard module needs no server change. An `/api` shape change bumps `API_VERSION` and changes `lib/api/types.ts`.
- `start.ts` is pinned in `test/invariants/file-size.test.ts`; #415 splits it into a route table here.

<!-- forge:map:start (generated from each file's header comment by npm run docs:map; edit those) -->
| File | What it holds |
|---|---|
| `start.ts` | The dashboard's HTTP server (`forge dash`): the `/api` endpoints, server-sent events and the built dashboard, for loopback Hosts only, with token- and Origin-checked POSTs. |
<!-- forge:map:end -->
