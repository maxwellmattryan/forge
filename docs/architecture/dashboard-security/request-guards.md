# Dashboard security › Request guards

Part of [Dashboard security](../dashboard-security.md).

## Loopback bind and peer check
The server binds 127.0.0.1 only and answers only requests whose Host is a loopback name, which defeats DNS rebinding; before the Host check, dispatch also refuses a request whose socket peer is not a loopback address (IPv4 `127.0.0.0/8`, `::1` or `::ffff:127.x.x.x`) with 403 `not loopback`, defence in depth should the bind ever change.

## The read guard
GETs are read-only, and every GET under `/api` takes the read guard: a foreign Origin is a 403 `bad origin` and a `Sec-Fetch-Site` other than `same-origin` or `none` is a 403 `cross-site`, so another site's no-cors GETs (`<img>`, `<script>`, `fetch` with `no-cors`, which carry no Origin and whose replies it can't read anyway) can't loop the expensive reads such as `/api/stats`. A signed-in request with neither header (curl or the CLI with the token header) passes the read guard. Only `/`, `/index.html`, `/assets/*` and `/forge.png` are served on the Host check alone. `GET /api/backlog?refresh` refetches from the tracker for any signed-in request; a signed-out one is a 401 like every `/api` route, so no other site can spend the tracker's rate limit.

## The POST guard
POSTs need the login, a matching Origin and a JSON content type, so other sites in your browser can't trigger work. The POST routes:
- enqueue a request: `/api/requests`
- create a job from free text: `/api/jobs`
- start or stop the daemon: `/api/daemon`
- answer a session's permission prompt: `/api/daemon/permission`
- switch a session's permission mode: `/api/daemon/mode`
- change a setting: `/api/config`
- set a job's effort: `/api/jobs/:id/effort`
- decide a job's repo proposals: `/api/jobs/:id/repos`
- merge a job's PR now with the job id typed back: `/api/jobs/:id/merge`
- raise or acknowledge a job's budget: `/api/jobs/:id/budget`
- acknowledge the repo budget: `/api/budget/ack`
- act on the Shelved list: `/api/shelf`
- set or clear focus: `/api/focus`
- start a job's dev server: `/api/jobs/:id/run`
- start, stop or restart a job's dev server or backing services: `/api/jobs/:id/environment`
- open a job's worktree in an editor: `/api/jobs/:id/editor`
- register a project: the machine's `/api/projects`
- the mandate writes `/api/mandates` and `/api/mandates/:id/edit|pause|resume|close|cancel|delete`
- the chat routes `/api/chats`, `/api/chats/:id/rename`, `/api/chats/:id/archive` and `/api/chats/:id/messages`

## Body limits and comparison
After those three checks, a `Content-Length` over 64 KiB is a 413 `body too large` before the handler runs or anything is written. A body is counted in bytes as it arrives and decoded once at the end; one that passes 64 KiB, or is still incomplete after 10 s, is cut off (the request is destroyed, so the client sees the connection close) and answered 400, so a signed-in client can't hold the server with an endless, oversized or trickled body. Every token comparison, cookie, header or login key, is constant-time.

## Where the guards live
The guards live in `lib/server/http.ts`, and the route tables in `lib/server/start.ts` name each route's guards: dispatch checks the login on every `/api` route but the `open` `POST /api/session`, then runs the POST guard on every POST route, before its own guards, the project lookup and its handler.
