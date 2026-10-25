# lib/ layers and the big-file splits

Status: decided 2026-10-21 (#303). The groundwork landed in #412: the glossary words, header comments, the tripwire tests in `test/invariants/`, `npm run docs:map` and this doc. The move landed in #421: every `lib/` file sits in its layer and module, with a folder map in each layer and module folder. The aliases landed in #370: imports across layers go through `package.json` "imports". The types split landed in #413, the PR split in #414, the server split in #415, the daemon split in #416, the worktree split in #417, the `forge job` split in #418 and the release split in #419; the test layout (#420) is pending.

This replaces the flat "~18 top-level modules" plan of 2026-10-19.

## Why

`lib/` is 200 source files and about 48k lines, 132 of them flat in one folder beside `commands/`, `step/` and `trackers/`. It mixes several libraries with different purposes: the HTTP server, the CLI, the long-running sessions, the pipeline engine, and code that talks to GitHub, Claude Code, Docker and git. Eighteen files are over 600 lines, and the biggest (`pr.ts`, `server.ts`, `daemon.ts`, `api-types.ts`, `worktree.ts`, `types.ts`) run from 1.2k to 1.8k. An agent that lists `lib/` sees 132 names and no grouping, and reads the big files in chunks. The goal is folders, names and a small map per folder that lead an agent to the right ~300 lines, and import rules a test enforces.

## Layers

Each lib layer is a top-level folder under `lib/` with its own modules inside, and imports go one way only ([GLOSSARY.md › Code layout](../GLOSSARY.md#code-layout)).

```
cli ─▶ server ─▶ office ─▶ engine ─▶ integrations ─▶ core ─▶ api
dashboard ─▶ api (type-only)
```

| Rank | Layer | Holds |
|---|---|---|
| 0 | `lib/api/` | Forge's public contracts, with no Node imports: the `/api` and SSE shapes, the `as const` lists they derive from, and the tracker adapter contract (`statusKey`, `STATUS_KEYS`). |
| 1 | `lib/core/` | Foundations with no pipeline policy: state shapes, schema and migrations, the job store and its lease, config loading and validation, paths, errors, fs, process and OS helpers. |
| 2 | `lib/integrations/` | All code that knows an outside system's API, CLI or file format, one folder per system (below). |
| 3 | `lib/engine/` | What Forge does: the pipeline (step, brief, panel, verifiers), worktrees, the PR lifecycle, tracker sync, integrity, protected paths and secrets, releases, environments and backing services, evals, stats and usage. It runs the repo's own configured commands. |
| 4 | `lib/office/` | The long-running runtime: sessions, the pool, the reconciler, the Foreman, notifications. |
| 5 | `lib/server/` | HTTP only: route table, guards, SSE, static files. |
| 6 | `lib/cli/` | The entry, argument parsing, `commands/`, render and help. |

Rules:
- A file imports its own layer and lower ones only. Every edge counts: runtime, type-only, side-effect, re-export and dynamic `import()`.
- `cli` may import `server`, because `forge dash` starts it. Nothing imports `cli`.
- `api` imports nothing outside `api`, Node built-ins included, so the dashboard can import it type-only.
- Integrations hold mechanism and engine holds policy: `integrations/github/` opens a PR and reads its checks, while when to retarget, rework on a red CI or merge stays in `engine`.
- The security wrappers (secret scanning of outgoing text, fencing of incoming text) live in engine's loaders around every adapter, built-in or custom, never inside one adapter.
- `office` starts long-running listeners (a Slack Socket Mode connection, later); their client code lives in `integrations`.
- Node built-ins and OS process tools stay in `core`; the repo's own configured commands (verify, dev servers) stay in `engine`.

`test/invariants/layers.test.ts` holds these rules, through `test/invariants/layer-map.ts`. Decided in #370: `server` and `cli` get no alias, because nothing below them may import them. The imports from `lib/cli/` into `lib/server/` (`cli/activity.ts` → `server/types.ts`, and `cli/commands/dash.ts` → `server/start.ts` and `server/types.ts`), and the tests' imports of `lib/cli/` and `lib/server/`, stay relative. That needs no exception list: the alias check flags only a relative import that crosses into an aliased layer's folder.

## `lib/integrations/`

Grouped by outside system, so each has one client (auth, timeouts, output parsing) shared by everything that uses it:

```
git/          runner.ts (one wrapper: env, pins, write flag), repo-slug.ts
github/       gh.ts (gh + GraphQL, default timeout), tracker.ts, pull-requests.ts, preview.ts, actor.ts
claude/       Claude Code session argv and permission modes, transcripts, model ids and pricing.json
docker/       runner.ts (sync and async)
webhook/      notify transport
backlog/      the built-in markdown backlog tracker (not third-party, but it implements the same contract)
slack/ discord/ jira/ gitlab/ …   later (M014 and after)
```

`integrations` imports only `core` and `api`, never `engine` or `office`.

## Conventions

These apply to all new `lib/` code, before and after the move.

- **Folders.** Inside a layer: `lib/<layer>/<module>/<file>.ts`. A concept gets a sub-module only once it has 3 or more files. 3–12 entries per folder, where an entry is a subfolder or a `.ts`, `.mjs` or `.json` file (`AGENTS.md` and tests are not entries). Three kinds of folder are exempt: registries, folders whose files are entries in one table (`cli/commands/`, `cli/commands/render/`), may hold more; an `integrations/<system>/` folder may hold fewer, one folder per outside system; and the shrinking `SMALL` list in `test/invariants/layout.test.ts` may hold fewer until its split lands. `test/invariants/layout.test.ts` holds these rules.
- **Standard names.** `types.ts` for a module's shapes, `constants.ts` for module-wide constants only. Helpers and files are named by purpose; `utils.ts` holds only small leftovers.
- **No stutter, no `index.ts`, no barrels.** A file never repeats its folder's name (`plan/plan.ts`). A runtime barrel loads a whole folder on every CLI start, which undoes the start-up cache (docs/architecture/startup-cache.md) and makes cycles easier to hit; importers name the file they need. The one exception is the transitional type-only `core/types.ts`.
- **Aliases.** Cross-layer imports use `package.json` subpath aliases (`#core/…`), never tsconfig `paths` (#370). `server` and `cli` have none. Inside a layer, imports stay relative.
- **Folder maps.** Each module folder has an `AGENTS.md`: a few hand-written lines (what belongs here, the invariants, and last a `Design:` bullet linking the `docs/architecture/` topics that govern the folder), then a table of each file and the first sentence of its header comment, between the `forge:map` markers. `npm run docs:map` writes the tables and `test/invariants/docs-map.test.ts` fails when one is stale. `lib/engine/pipeline/step/AGENTS.md` was the first; `lib/`, each layer folder and each folder directly inside a layer has one, and a deeper folder is listed in its parent's table unless it has its own. Area gotchas move out of the root `AGENTS.md` into these, so each rule is stated in one place.
- **Header comments.** Every `lib/` source opens with a comment (after at most a shebang) whose first sentence says what the file holds; that sentence is its map row.
- **Size.** No `lib/**/*.ts` file over 600 lines, except the pinned files on the shrinking allowlist in `test/invariants/file-size.test.ts`. The target for new files is 400.
- **Glossary first.** A new word for a layer or module goes in `docs/GLOSSARY.md` before the code uses it.

**Open item for the move: nested `AGENTS.md`.** Checked on the installed Claude Code 2.1.308: in a project with no `CLAUDE.md` (Forge has none), it loads `AGENTS.md` files as project instructions exactly where it would load `CLAUDE.md`, nested folders included (its default `claude-md-or-agents-md` mode). The pinned 2.1.299 was not checked directly. The maps keep the `AGENTS.md` name, like `dashboard/AGENTS.md`. They are written to be read on demand, and the root `AGENTS.md` points to them, so they work whether or not 2.1.299 auto-loads nested `AGENTS.md` files. Checking the pinned version (does `/memory` list `lib/engine/pipeline/step/AGENTS.md` after reading a file there?) is a human step after #421's PR opens; record the answer here.

## The module map

Every `lib/` file sits under `lib/<layer>/`, except the two deprecated tracker re-exports, `lib/trackers/status.ts` and `lib/trackers/status.mjs`, which `FLAT_LAYERS` in `test/invariants/layer-map.ts` gives to `api`. The move (#421) settled the names within the folder rules: a name drops the prefix its folder now says, and `a ← b` means `a` was `b` before the move. Each folder's `AGENTS.md` maps it file by file.

### api

| Module | Files |
|---|---|
| `types.ts` | ← `api-types.ts`; now a type-only barrel over the owner modules below (#428) |
| `enums.ts` | the unions the /api shapes share, derived from `constants.ts` |
| `job.ts` | a job as job.json and events.jsonl hold it, as /api/state and /api/jobs/:id serve it |
| `state.ts` | GET /api/state, /api/requests, /api/focus, /api/budget/ack, and the JSON error body |
| `jobs.ts` | /api/jobs and /api/jobs/:id/*, and the environment routes with GET /api/environments |
| `daemon.ts` | the session pool's /api/daemon* routes and the /api/events SSE frames |
| `config.ts` | /api/config, /api/doctor and /api/about |
| `stats.ts` | /api/stats, /api/evals and /api/evals/compare |
| `repo.ts` | /api/project, /api/roster, /api/backlog with the tracker item, and /api/github/preview |
| `constants.ts` | `constants.ts` |
| `tracker.ts` | ← `trackers/status.ts`; `trackers/status.ts` and `trackers/status.mjs` stay as deprecated one-line re-exports for one minor release, and the stability contract in docs/RELEASES.md moved to `lib/api/tracker.ts` |

### core

| Module | Files |
|---|---|
| `job/` | store ← `jobs.ts`, `schema.ts`, `requests.ts`, `archive.ts`, fields ← `job-fields.ts`, `focus.ts`, `issue-ref.ts`, `issue-link.ts`, `lens.ts`, session-files ← `daemon-files.ts`, `types.ts` (the job, findings and archive shapes) |
| `config/` | load ← `config.ts`, defaults ← `config-defaults.ts`, validate ← `config-validate.ts`, fields ← `config-fields.ts`, set ← `config-set.ts`, models ← `config-models.ts`, trust ← `config-trust.ts`, `components.ts`, sinks ← `config-sinks.ts`, `release-strategy.ts`, `types.ts` (the config shapes), and `validators/` |
| `config/validators/` | backing ← `backing-config.ts`, checkout ← `checkout-config.ts`, endpoints ← `endpoints-config.ts`, notify ← `notify-config.ts`, secret-refs ← `secret-refs-config.ts`, `policy-check.ts`, `deprecations.ts` (moved from `config/` in #413) |
| `os/` | `platform.ts`, and process, fs and lock from `util.ts` |
| `format/` | `yaml.ts`, `zip.ts`, `ansi.ts` |
| `versions/` | `steps.ts`, `config.ts`, `job.ts`, `event.ts`: the append-only version step lists, moved out of `job/schema.ts` in #426 |
| leaves | `types.ts` (transitional type-only barrel: re-exports `api/types.ts`, `job/types.ts` and `config/types.ts`, and declares the tracker contract), `paths.ts`, `shape.ts`, `glob.ts`, and errors, text and utils from `util.ts` |

Why these sit in core, and why so:
- `requests.ts` and `daemon-files.ts` are stores that about 20 engine modules write or read. `office` is the layer that acts on them, so they sit below engine rather than in office.
- `components.ts`, `config-sinks.ts`, `release-strategy.ts`, `policy-check.ts` and the `*-config.ts` validators parse config, so they sit with it.
- `issue-link.ts` is pure, like `issue-ref.ts`.
- Laid out as leaves, `core/` would hold 16 entries and `config/` 17, over the 12-entry cap. So `os/` takes `platform.ts` and the process, fs and lock pieces of `util.ts`, `format/` takes `yaml.ts`, `zip.ts` and `ansi.ts`, and `config/validators/` takes the five `*-config.ts` validators and `policy-check.ts`.
- `util.ts` split by purpose into `errors.ts`, `os/process.ts`, `os/fs.ts`, `os/lock.ts`, `text.ts` and `utils.ts`, bodies unchanged; `errors.ts` is the only dependency they share, so no cycle runs among them.

### integrations

| Module | Files |
|---|---|
| `git/` | runner ← `git.ts`, `repo-slug.ts` |
| `github/` | `gh.ts`, tracker ← `trackers/github.ts`, preview ← `github-preview.ts`, `actor.ts`, `pull-requests.ts` (the PR mechanism, split out in #414) |
| `claude/` | `argv.ts` (the session argv and env, from `daemon.ts` in #416), `transcripts.ts`, `pricing.ts` + `pricing.json` |
| `docker/` | runner ← `docker.ts`, `types.ts` |
| `backlog/` | tracker ← `trackers/local.ts` |
| `webhook/` | arrives when notify's transport splits out of `office/notify.ts` |

### engine

| Module | Files |
|---|---|
| `pipeline/` | `step/`, `step.ts`, `brief.ts`, `panel.ts`, `verifiers.ts`, `roster.ts`, `acs.ts`, `findings.ts`, `scope.ts`, `member-panel.ts`, `moves/` (the one move `moveJob` and its effects, the Foreman's gate policy, and `deps.ts`), `types.ts` (the step and verifier shapes: `step/` is at its entry cap) |
| `workspace/` | `worktree.ts`, split in #417 into `worktree.ts` (create and remove), `run.ts` and `dev-server.ts` (its process proof in `dev-probe.ts` since #458); `checkout.ts`, `focus-actions.ts`, `editor.ts`, `regenerate.ts`, `job-command.ts` |
| `verify/` | `gate.ts`, `steps.ts` and `e2e.ts` (moved from `workspace/` in #458), `record.ts` (the one reader of `job.verifyRuns`) |
| `guard/` | `integrity.ts`, `protected.ts`, `secrets.ts`, `known-secrets.ts`, `secret-refs.ts`, `redact.ts`, `attribution.ts`, `command-env.ts`, `types.ts` |
| `environment/` | `backing.ts`, `backing-db.ts`, `ports.ts`, `endpoints.ts`, status ← `environment.ts`, lifecycle ← `environment-lifecycle.ts`, record ← `environment-record.ts`, `config-sinks-apply.ts`, `types.ts` |
| `project/` | `member-repos.ts`, `member-trackers.ts`, `job-repos.ts`, graph ← `project.ts`, `repo-order.ts`, `repo-proposals.ts`, `links.ts`, `downstream.ts` |
| `pr/` | `adopt.ts`, `body.ts`, `branch.ts`, `members.ts`, `sync.ts`, `open.ts`, `integrate.ts`, `merge.ts` (the PR policy, split out in #414), `delta.ts` |
| `trackers/` | load ← `trackers/index.ts`, mirror ← `trackers/mirror.ts`, link ← `tracker-link.ts`, `triage.ts`, `request-refresh.ts` |
| `release/` | plan ← `release-plan.ts`, run ← `release-run.ts`, approval ← `release-approval.ts`, `interim.ts`, `interim-apply.ts`; `manifest.ts`, `steps.ts`, `render.ts` and `files.ts` (split out of `plan.ts` in #419) |
| `evals/` | run ← `evals.ts`, overlay ← `eval-overlay.ts`, stats ← `eval-stats.ts`, `experiments.ts`, `learnings.ts`, `retro.ts`, `recall.ts`, `scoring.ts`, `outcome.ts`, `autonomy.ts`, `provenance.ts`, `types.ts` |
| `metrics/` | `stats.ts`, `usage.ts`, `spend.ts`, `budget.ts`, `repo-budget.ts`, `types.ts` |
| `ops/` | `doctor.ts`, `bundle.ts`, `update.ts`, `version.ts`, `retention.ts`, `delete.ts`, `audit.ts`, `detect.ts`, `detect-components.ts`, `title.ts`, `types.ts` |

### office

| Module | Files |
|---|---|
| `session/` | lifecycle ← `daemon.ts`, split in #416 into `contract.ts`, `control.ts`, `holds.ts`, `launch.ts`, `log.ts`, `owned.ts`, `records.ts` and `timers.ts` |
| pool | ← `daemon-pool.ts` |
| owner | ← `daemon-owner.ts` |
| leaves | `driver.ts` (#459: the id helpers out of `owner.ts`, and the one release), `session-agents.ts`, `reconcile.ts`, `foreman.ts`, `notify.ts` |

### server

| Module | Files |
|---|---|
| `start.ts` | ← `server.ts`: `startServer`, the route table and dispatch (split in #415) |
| `types.ts` | the server's shapes outside `/api`: options, `ServerCtx`, the route rows, `RequestInfo` |
| `http.ts` | the Host, token, Origin, JSON and read guards, body readers, response writers |
| `static.ts` | the dist allowlist, the page, hashed assets, the logo, screenshots |
| `sse.ts` | frames, following a file, `broadcast`, the ping |
| `redact.ts` | known values out of pages and streams |
| `routes/` | `jobs.ts`, `office.ts`, `transcripts.ts`, `environment.ts`, `config.ts`, `misc.ts` |

### cli

| Module | Files |
|---|---|
| main | ← `cli.ts` (`bin/forge` imports it) |
| `commands/` | `commands/` (unchanged inside, except registry ← `render/index.ts`) |
| leaves | `activity.ts` (only `commands/dash.ts` imports it, and it types against the server), `types.ts` (the CLI's own shapes) |

Where the names differ from a plain prefix drop, the folder rules decided:
- **No stutter.** A name that would repeat its folder takes the name the later split leaves: `git/runner.ts` (matching `docker/runner.ts`), `server/start.ts` (#415), `session/lifecycle.ts` (#416), `evals/run.ts`, `environment/status.ts` (the environment as the dashboard shows it) and `project/graph.ts` (the project graph).
- **No `index.ts`.** `cli/commands/render/index.ts` became `render/registry.ts`, because its header calls it the renderer registry.

## Today's upward edges

With the placement above, 15 imports point up a layer. `ALLOWED_EDGES` in `test/invariants/layer-map.ts` is the live list; it may only shrink, and an entry that no longer exists or no longer points up fails as stale.

| Edges | What removes them |
|---|---|
| `core/job/store.ts` reaches `engine/guard/known-secrets.ts`, `engine/evals/overlay.ts`, `engine/evals/provenance.ts`, `integrations/github/actor.ts`, `integrations/git/repo-slug.ts` and `integrations/claude/pricing.ts`; `core/paths.ts` reaches `integrations/git/runner.ts` | hooks or parameters in the job store (like `onTransition`), or the pieces moving down to a core leaf |
| `core/job/schema.ts` reaches `engine/pr/delta.ts` and `engine/project/member-repos.ts`; `core/config/validate.ts` and `core/job/lens.ts` reach `engine/project/member-repos.ts` | the value validators (`isSha`, `REPO_NAME`, `isSafeBranch`, the repo problems) moving into `core/config/` |
| `engine/ops/doctor.ts`, `engine/pr/open.ts` and `engine/guard/secrets.ts` reach `office/notify.ts` | notify's transport splitting to `integrations/webhook/` and the queue to engine |
| `integrations/github/tracker.ts` reaches `engine/guard/attribution.ts` | the tracker loader's security wrappers (attribution stripping applied in engine) |

## Tests

| Kind | Definition | Lives in |
|---|---|---|
| Unit | Imports one module and calls its functions in-process. No subprocess, no git repo, no network; temp files are fine. | Beside the module: `lib/core/job/store.test.ts`, `dashboard/src/lib/board.test.ts` |
| Integration | One entry point for real (a CLI command, an HTTP endpoint, a pool session, an adapter), with outside systems faked | `test/integration/<entry point>/` |
| E2E | A whole flow across layers in a scratch git repo | `test/e2e/<flow>/` |
| Invariants | Rules about the repository itself, not behaviour: workflow security, docs sync, the dashboard invariants, the layer and file-size tripwires | `test/invariants/` |
| Support | Helpers, fake binaries and fixtures; no tests but the job-state builders' own table test | `test/support/` |

`test/invariants/` has started: `layers.test.ts` (with `layer-map.ts`), `file-size.test.ts` and `docs-map.test.ts`, run by `npm run test:invariants`. The other invariant tests (`ci-workflow`, `governance`, `dashboard-invariants` and the rest) move there with #420, along with the tsconfig includes and CI sharding by kind. A `*.test.ts` under `lib/` is scanned for imports and given a layer, but is outside the 600-line cap (tests have their own 800-line cap) and the maps.

## The big-file splits

Each split is its own PR and changes no behaviour; the existing tests, unchanged apart from paths, are the proof. `step.ts` already split into `lib/step/` (#347).

### pr.ts → `engine/pr/` and `integrations/github/` (#414)

Landed in #414. The `gh` mechanism sits in `integrations/github/pull-requests.ts`, the policy in small files in `engine/pr/`, which import in this order and never back: `pull-requests.ts` ← `body.ts`, `branch.ts`, `adopt.ts` ← `members.ts` ← `sync.ts` ← `merge.ts`; `open.ts` imports `adopt`, `body`, `branch` and `members`; `integrate.ts` none of them.

| File | Contents | ≈ lines |
|---|---|---|
| `integrations/github/pull-requests.ts` | the parsers that check each PR read once into a snapshot (`parsePr`, `parsePrBody`, `parseClosing`, `parseFeedback`), the gh adapter behind the `GitHub` interface in `types.ts` (`createGhGitHub`, `ghGitHub`, one gh call per operation), `repoSlug`, `assertJobPr`, the checks on gh's answers (`safePrNumber`, `SLUG_RE`, `PR_STATES`) and the check helpers (`summarizeChecks`, `failingCheckNames`, `checksText`) | 270 |
| `engine/pr/adopt.ts` | `findPr`, `refuseUnsafeRefs` | 60 |
| `engine/pr/body.ts` | PR text and body, escalation approval, sibling section, issue lines | 130 |
| `engine/pr/branch.ts` | `refreshBase`, `pushBranch`, `pullPrHead` | 80 |
| `engine/pr/members.ts` | member-repo PRs: check, open, record, sibling links, sync | 285 |
| `engine/pr/sync.ts` | `syncPr`, transitions, CI reworks, reopen, human delta, pr-feedback.md | 385 |
| `engine/pr/open.ts` | `openPr`, interim open plan, protected-paths re-check, retarget | 275 |
| `engine/pr/integrate.ts` | `integrate`, `integrateContinue` | 195 |
| `engine/pr/merge.ts` | `mergePr`, targets, linked merges, `readyPr`, release-gate message | 400 |

`findPr` stays in engine, against the first plan: it records the adopted PR in `job.json` and applies the fork, safe-ref and trusted-closing-PR rules, which is adoption policy, so only its `gh` calls moved.

### server.ts → `server/` (#415)

Landed in #415. Most of the file was one closure inside `startServer`. The closure's state (token, SSE clients, pool, projects dir, previewer, caches) is now an explicit `ServerCtx` that `createContext` builds once per server, and the `if (p === …)` chain is the route table `ROUTES` of `{ method, path | RegExp, guards?, handler(ctx, req, res, match) }`. That table is the server's map: dispatch runs the POST guard on every POST row, and each GET row names its own guards.

| File | Contents | ≈ lines |
|---|---|---|
| `start.ts` | `startServer`, `createContext`, `GUARDS`, `ROUTES`, `matchRoute`, dispatch, the activity-log hook | 234 |
| `types.ts` | `ServerOptions`, `RunningServer`, `RequestInfo`, `ServerCtx`, `Guard`, `RouteMatch`, `Handler`, `Route` | 100 |
| `http.ts` | the loopback Host check, the token, Origin, JSON, read and query-token guards, body readers, `send`, `json`, `jsonStatus`, `safeJoin` | 115 |
| `static.ts` | dist allowlist, page, immutable assets, the logo, images, screenshots | 170 |
| `sse.ts` | frames, `followFd`, `broadcast`, the ping | 160 |
| `redact.ts` | `redactPage`, `knownReader` | 20 |
| `routes/jobs.ts` | POST jobs, job detail, file and raw, requests, effort, delete, repos, run, editor | 360 |
| `routes/office.ts` | `/api/events`, session log, daemon, mode, permission | 185 |
| `routes/transcripts.ts` | locate, page, events, agent rows and activity | 160 |
| `routes/environment.ts` | job environment GET/POST, its log stream, every running environment | 270 |
| `routes/config.ts` | config GET/POST, webhook masking, budget ack | 90 |
| `routes/misc.ts` | state, stats, evals, roster, project, backlog, about, doctor, bundle, GitHub preview, focus | 280 |

Keeping `http.ts` small and alone is the security win: the loopback, token, Origin and JSON rules become one file a reviewer reads whole.

Where it differs from the plan, and why: `routes/environment.ts` was added, because the plan had no home for the environment routes. The requests routes went to `routes/jobs.ts`, beside `resumeHeld`, which POST repos also uses. `/api/events` went to `routes/office.ts`, so `sse.ts` stays mechanism only. `redact.ts` was added for the redaction both the transcript and environment streams share. Guards are declared in the table rather than called by handlers. `.github/CODEOWNERS` needed no change: `/lib/server/**` already covers `http.ts`.

### daemon.ts → `office/session/` and `integrations/claude/` (#416)

Landed in #416, in two commits so the moves read as moves. Step 1 moved the pure parts out verbatim; step 2 broke `createSession`'s 940-line closure into factories that share one `SessionCore`, a set of accessors over `createSession`'s own variables, so every read and write of the session's state stays where it was. Child lifecycle (spawn, stdout, result, exit, kill, the turn) and `state()` stay in `lifecycle.ts`. The factories import `contract.ts` for types only, and none imports `lifecycle.ts`.

| File | Contents | ≈ lines |
|---|---|---|
| `integrations/claude/argv.ts` | `DENY_TOOLS`, `FILE_TOOLS`, `absRule`, `PROMPT_TOOL`, `PERMISSION_MODES`, the permission-mode and effort flags, `modeReach`, `apiKeyVars`, `sessionEnv`, `parseTemplate`, `buildArgv` | 196 |
| `office/session/contract.ts` | `SessionEvent`, `LogSink`, `DaemonOptions`, `Redactor`, `SessionOptions` and `sessionOptions`, `SessionContext`, `ChildMeta`, `DaemonChild`, `Session`, `SessionCore` | 221 |
| `office/session/control.ts` | every stdin line (`TURN`, `TURN_LINE`, permission answers, mode switches), `sessionGrant`, `ruleText`, and `createControl`: prompts and mode switches | 243 |
| `office/session/holds.ts` | `heldByBudget`, `heldByRepoBudget`, `routeHolds`, `parseRateLimit`, `LIMIT_TEXT` | 89 |
| `office/session/launch.ts` | `checkLaunch`: tracker symlinks, the one read of config.yml, the trust digest, the confine digest, `daemon.enabled`, `daemonProblems` | 56 |
| `office/session/confine.ts` (#382) | `WRITE_ROOTS_ENV`, `writeRoots`, `hooksDir`, `denyRules`, `confineDigest`, `spawnConfinement`: what a session may write | 150 |
| `office/session/log.ts` | `capLine`, `splitter`, `stamped`, and `createSessionLog`: the sink, offsets, the replay ring, rotation, backpressure | 207 |
| `office/session/owned.ts` | `LOST_SUMMARY` and `createOwned`: kept, facts, agents lost, the lease and claimed requests on exit | 89 |
| `office/session/records.ts` | `withSessionId`, `isOurChild`, `otherOwner`, `reapOrphans` | 99 |
| `office/session/timers.ts` | `createTimers`: the turn limit and the idle stop | 82 |
| `office/session/lifecycle.ts` | `TRUST_CHANGED`, `createSession` | 589 |

Where it differs from the plan, and why: `TURN` and `TURN_LINE` went to `control.ts`, not `contract.ts`, because the turn is one of only three kinds of stdin line and that file now holds all three, so a security reviewer reads them in one place. `records.ts` replaced `files.ts`: the record files themselves live in `lib/core/job/session-files.ts` (with `readLogPage`), so what is left is what a record says about its child. `log.ts` holds the live log rather than the readers, and `launch.ts` and `owned.ts` were added for the spawn checks and what an exit lets go. `session-agents.ts` stayed in `lib/office/`, so `forge daemon status` reads it without loading the supervisor. The old `test/integration/pool/daemon.test.ts` was gone with the test teardown (#447), so step 2 went in behind `test/integration/server/security.test.ts`, which drives the pool with in-memory children, and a new in-process `lib/office/session/lifecycle.test.ts` over the seams step 2 cut.

#457 then moved Claude Code's stream-json protocol out of `office/session/` into `integrations/claude/`: `types.ts` (`ClaudeEvent`, `ClaudeChild`, `ClaudeAdapter`), `stream.ts` (every stdin line from `control.ts`, `LIMIT_TEXT` and `parseRateLimit` from `holds.ts`, `splitter`, `stamped` and `STDERR_CAP` from `log.ts`, and `createStream`, the decoder) and `child.ts` (`claudeAdapter`, with the process-group kill from `contract.ts`). `DaemonOptions.spawn` and `killTree` became `claude`, `DaemonChild` became `{ claude, meta }`, and the session reacts to `ClaudeEvent`s only, so its tests drive `fakeClaude` (`test/support/claude-adapter.ts`) with events instead of writing claude's JSON into `PassThrough` children. `buildArgv` stays called by the office, so a template error stays a repo-wide refusal and a spawn error a session-only one.

### worktree.ts → `engine/workspace/` (#417)

Landed in #417. The 1320-line file held four concerns: worktree create and remove, configured commands, `forge verify` and the background dev server. Bodies moved verbatim; the only edits are imports, header comments and `export` on the helpers now shared across files. `worktree.ts` keeps its name and create/remove, so the importers of `createWorktree` and `removeWorktree` kept their path. Imports run one way: `run.ts` ← `verify-steps.ts` ← `verify.ts`, `verify.ts` and `worktree.ts` also import `run.ts`, and `dev-server.ts` imports none of them.

| File | Contents | ≈ lines |
|---|---|---|
| `worktree.ts` | `MemberWorktreeResult`, `CreateWorktreeResult`, `createWorktree` and its root and member halves, `addWorktree`, `sparseCheckout`, `cloneIsolated`, `copyUntracked`, `globFiles`, `writeSharedCargoTarget`, `removeWorktree` and its root, member and backing halves, `realpath`, `insideDir`, `isDir` | 420 |
| `run.ts` | `CommandResult`, `RunOptions`, `fillCommand`, `placeholdersArePlainWords`, `commandTemplate`, `prepareCommand`, `prepareMemberCommand`, `memberComponent`, `memberVars`, `recordCommand`, `runCommand`, `runCommandAsync`, `lockSnapshot`, `restoreLocks` | 235 |
| `verify.ts` | `VerifyResult`, `verify`, `verifiedHead` | 268 |
| `verify-steps.ts` | `VerifyStep`, `verifyLockSnapshot`, `restoreGroup`, `notesStep`, `MemberVerify`, `verifyMember`, `renderSteps` | 208 |
| `dev-server.ts` | `startBackground`, `parseDevProbe`, `ownDevProcess`, `stopDevProven`, `portAnswers`, the probe constants, and its own `realpath` | 205 |
| `job-command.ts` (existing) | adds `MAX_OUTPUT` and `shellAsync`, the async twin of `shell` | +53 |

Judgement calls: no `workspace/types.ts`, so each shape sits with the function that returns it and the folder stays at 11 entries under the cap of 12. `VerifyStep` lives in `verify-steps.ts` because both verify files need it and `verify-steps.ts` must not import `verify.ts`. `realpath` is copied into `dev-server.ts` rather than shared, matching the private copies in `ops/update.ts` and `ops/version.ts`. Verify splits in two so neither file passes the 400-line target. `MemberVerify` is exported, beside the functions verify imports, because `verify.ts` annotates its member runs with it.

### verify out of workspace (#458)

Landed in #458. `verify.ts`, `verify-steps.ts` and `e2e.ts` moved from `workspace/` to a new `engine/verify/` module as `gate.ts`, `steps.ts` and `e2e.ts` (`pipeline/` is at its entry cap). `record.ts` is new: the one reader of `job.verifyRuns`. It answers this round's runs, the last run, the next attempt and whether a HEAD is verified, from job data alone, and appends a run with its legacy `verify` and `verifyRetries` writes. A job's latest verify run is this round's last run, and a HEAD is verified only when that run has `ok === true` on the root HEAD and on every member HEAD, so step, `pr open`, `forge job show` and `forge job interim publish` give one answer. Imports run one way: `record.ts` imports nothing in the folder, and `steps.ts` ← `gate.ts`.

Two seams make the gate testable without a worktree. `verify` and `verifyMember` take a `CommandRunner` (`COMMAND_RUNNER` outside tests), and both group loops share `runGroups` in `steps.ts`. In `workspace/`, `parseDevProbe` and `ownDevProcess` moved from `dev-server.ts` to `dev-probe.ts`, where `ownDevProcess` reads the OS through a `ProcessProbe` (`systemProbe`: ps, lsof and `/proc`). Folder counts: `engine/` 12, `workspace/` 9, `verify/` 4.

### commands/job.ts → `cli/commands/job/` (#418)

Landed in #418. The 1048-line file held `forge job`'s help table and one 500-line `switch` with every subcommand. Bodies moved verbatim into one handler function per subcommand; the only edits are `const id = rest[0]` where a body used `id`, imports, `export` and header comments, so every daemon, inbox and office refusal runs at the same point as in its `case`. `job.ts` keeps its header, `JOB_HANDLERS` (subcommand word → handler, in the help table's order) and `jobCmd`, which runs the office allowlist check, then an `Object.hasOwn` lookup (so `constructor` and its kind stay usage errors, as the `switch` default made them), then the handler. `lib/cli/main.ts` keeps its import path, and `advance` stays routed there, documented in the table but with no handler. `JobHandler` lives in `lib/cli/types.ts` beside `Dispatch`, so no handler file imports `job.ts`. Imports run one way: `help.ts` imports nothing in the folder, `lease.ts` (`epochFence`) ← `state.ts` and `agent.ts`, `state.ts` (`refuseEffortInDaemon`) ← `create.ts`, and every file that calls `usageError(JOB, …)` imports `JOB` from `help.ts`.

| File | Contents | lines |
|---|---|---|
| `job.ts` | `JOB_HANDLERS`, `jobCmd` | 66 |
| `job/help.ts` | `NO_JOB`, `BODY`, `JOB`, `HELP` | 354 |
| `job/create.ts` | `newCmd` (`new`), `fromRef` (`from-ref`), `link`; `newJobIssues`, `FORCE_DAEMON_REFUSAL`, `refuseForceInDaemon` | 120 |
| `job/read.ts` | `listCmd`, `show`, `get`, `audit`, `progressCmd`, `paths`, `links`, `scope`, `panel`, `acs`, `findings`; `jobPaths`, `compactJob` | 122 |
| `job/state.ts` | `set`, `effort`, `note`, `refreshRequestCmd` (`refresh-request`), `budget`; `EFFORT_DAEMON_REFUSAL`, `refuseEffortInDaemon` | 91 |
| `job/lease.ts` | `claim`, `release`, `stepCmd` (`step`); `epochFence`, `TERMINAL_STATES` | 70 |
| `job/decide.ts` | `human`, `handoff`, `assistCmd` (`assist`, wrapping `assist`); `HUMAN_ACTIONS`, `REPO_ACTIONS` | 131 |
| `job/repos.ts` | `repo`, `interim` | 70 |
| `job/agent.ts` | `agent` | 88 |
| `job/review.ts` | `round`, `verdicts`, `decision`, `score` | 89 |
| `job/retention.ts` | `archive`, `deleteCmd` (`delete`), `pruneCmd` (`prune`); `refuseRetentionInDaemon` | 47 |

Judgement calls: handlers are grouped by concern into 9 files rather than one file per subcommand, since thirty-five files of 3–30 lines would need a registry exception and scatter the shared helpers; "one handler per subcommand" is one function per subcommand in one dispatch table. A `Cmd` suffix marks a handler whose bare name is a reserved word or would shadow an import (`newCmd`, `deleteCmd`, `listCmd`, `pruneCmd`, `progressCmd`, `stepCmd`, `refreshRequestCmd`, `assistCmd`). `JOB_HANDLERS` is exported only so `lib/cli/commands/job.test.ts` can check it against the help table. `JobHandler` goes in `lib/cli/types.ts` rather than a `job/types.ts`, which would be an 11th entry for one type. The security lens's paths in `.forge/config.yml` gain `lib/cli/commands/job/**`, since the refusals now live there; Forge's own policy changes only by a human on the base branch, so that line lands outside this job.

### release/plan.ts → `engine/release/` (#419)

Landed in #419. The 632-line file held the plan's shapes and planner, the manifest reader, the mechanism table, `release.md`'s renderer and the runtime files. Bodies moved verbatim; the only edits are imports, header comments and `export` on `labelOf`, `ecosystemOf` and `rollbackFor`, which another file now needs, so `assertNoSymlinks`, `readPlanFile`'s `selection` checks, `readState` and `freshPlan`'s hash comparison run at the same points in `writeReleasePlan`, `runRelease` and the approval path. `plan.ts` keeps its name and `selectionFrom`, so the CLI's import of it is unchanged, and re-exports nothing. Imports run one way: `manifest.ts` imports nothing in the folder, `steps.ts` imports only types from `plan.ts`, `plan.ts` imports `steps.ts` and `manifest.ts`, `render.ts` imports `plan.ts`, and `files.ts` imports `plan.ts` and `render.ts`. `labelOf` lives in `steps.ts` because a runtime import of it from `plan.ts` would form the cycle `plan.ts` ↔ `steps.ts`.

| File | Contents | lines |
|---|---|---|
| `plan.ts` | `RELEASE_FILE_VERSION`, `CHECK_KINDS`/`CheckKind`, every shape (`ReleaseSelection`, `ReleaseStep`, `ReleasePackage`, `ReleaseRepo`, `ReleaseSkip`, `ReleasePlan`, `StepStatus`, `StepState`, `ReleaseState`, `GitReader`, `CloneResolver`, `PlanOptions`), `cloneGit`, `defaultClone`, `repoBase`, `repoRemote`, `strategyOf`, `planHash`, `SINCE`, `planRelease`, `freshPlan`, `selectionFrom` | 295 |
| `manifest.ts` | `NPM_NAME`, `CARGO_NAME`, `VERSION`, `MANIFEST_MAX`, `readManifest`, `unquote`, `readManifestPackage`, `ecosystemOf` | 88 |
| `steps.ts` | `ROOT_LABEL`, `labelOf`, `RepoInput`, `stepsFor`, `rollbackFor` | 74 |
| `render.ts` | `CHECK_TEXT`, `stepCommand`, `SELECTION_TEXT`, `renderReleaseMd` | 63 |
| `files.ts` | `ReleaseFiles`, `releaseFiles`, `assertNoSymlinks`, `readState`, `readPlanFile`, `planSteps`, `doneCount`, `finished`, `writeReleasePlan` | 142 |

Judgement calls: `run.ts` (578 lines, now 573) is not split: it was already under the cap with no pin, and deleting `plan.ts`'s pin meets the goal, so a further split would be churn. There is no `release/types.ts`: the shapes depend on `RELEASE_FILE_VERSION` and `CHECK_KINDS`, which are runtime values, and the other engine `types.ts` files hold no runtime constants, so the shapes stay beside the planner, as #417 kept shapes beside their functions. `selectionFrom` stays in `plan.ts` beside `ReleaseSelection`. Folder count: `release/` 10.

## Order of work

One PR each.

1. **Groundwork (#412, landed):** glossary words, header comments, `test/invariants/` with the layer, file-size and folder-map tests on today's flat tree, `npm run docs:map` with `lib/step/AGENTS.md`, and this doc.
2. **The move (#421, landed):** `git mv` and an import-rewriting codemod into the seven layers, with no content edits beyond the `util.ts` split, renames and the paths computed from the plugin root. It leaves only the two deprecated tracker re-exports in `FLAT_LAYERS`, re-keys `ALLOWED_EDGES` and the size pins, and updates CODEOWNERS, the hook, `bin/forge`, prompts and doc paths (`ci.yml` names only `lib/trackers/status.mjs`, which stays). It adds each layer and module folder's `AGENTS.md` and slims the root one, and adds the folder layout test (`test/invariants/layout.test.ts`: 3–12 entries, no stutter, no `index.ts`, the maps).
3. **Aliases (#370, landed):** the `#core/…` subpath map and its cross-layer relative-import test.
4. **types.ts by owner (#413, landed)**, with the transitional type-only barrel. Each shape moved to the `types.ts` of the module that owns it; `core/types.ts` re-exports the api, job and config shapes and keeps the tracker contract. `e2e.ts` moved from `pipeline/` to `workspace/` and `deprecations.ts` from `config/` into `config/validators/` to make room, and the four types-split edges and the `core/types.ts` size pin are gone.
5. **pr.ts (#414, landed)**, **server.ts (#415, landed)**, **daemon.ts (#416, landed)**, **worktree.ts (#417, landed)** (create/remove, command templating, `verify`, the dev server), **commands/job.ts (#418, landed)** (`HELP` apart, one handler per subcommand), **the release split (#419, landed)** (`release-plan.ts`; `release-run.ts` already fit under the cap). Each deletes its size pin and the upward edges it removes.
6. **Tests (#420):** unit tests beside their modules, the rest into `test/{integration,e2e,invariants,support}/`, with the tsconfig includes and CI sharding by kind.

## Timing

- The move conflicts with every open job branch, so land it between waves, with no Forge jobs open.
- #292, #288, #298 and #281 rework the pool, sessions and Foreman. Don't run them at the same time as the `office/` move.
- #280 (the schema reset) lands last before 1.0.0, after the move.

## Done when

- The layer test passes with an empty allowlist, and every folder passes the layout rules (registries apart).
- No `lib/**/*.ts` file is over 600 lines, except files still on the shrinking allowlist.
- `grep` for `git`, `gh`, `docker` or `claude` process calls outside `lib/integrations/` finds nothing.
- Every test is in the place its kind dictates; `test/` has no test files at its top level.
- Each module has an `AGENTS.md` map that `npm run docs:map` keeps current, and the root `AGENTS.md` is slimmer.
- No behaviour changes: the existing tests pass unchanged apart from paths, and the AGENTS.md verify list passes.
