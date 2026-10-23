# lib/ layers and the big-file splits

Status: decided 2026-10-21 (#303). The groundwork landed in #412: the glossary words, header comments, the tripwire tests in `test/invariants/`, `npm run docs:map` and this doc. The move landed in #421: every `lib/` file sits in its layer and module, with a folder map in each layer and module folder. The aliases landed in #370: imports across layers go through `package.json` "imports". The file splits (#413–#419) and the test layout (#420) are pending.

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

`test/invariants/layers.test.ts` holds these rules, through `test/invariants/layer-map.ts`. Decided in #370: `server` and `cli` get no alias, because nothing below them may import them. The imports from `lib/cli/` into `lib/server/` (`cli/activity.ts` and `cli/commands/dash.ts` → `server/start.ts`), and the tests' imports of `lib/cli/` and `lib/server/`, stay relative. That needs no exception list: the alias check flags only a relative import that crosses into an aliased layer's folder.

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

- **Folders.** Inside a layer: `lib/<layer>/<module>/<file>.ts`. A concept gets a sub-module only once it has 3 or more files. 3–12 entries per folder, where an entry is a subfolder or a `.ts`, `.mjs` or `.json` file (`AGENTS.md` and tests are not entries). Three kinds of folder are exempt: registries, folders whose files are entries in one table (`cli/commands/`, `cli/commands/render/`, later `server/routes/`), may hold more; an `integrations/<system>/` folder may hold fewer, one folder per outside system; and the shrinking `SMALL` list in `test/invariants/layout.test.ts` may hold fewer until its split lands. `test/invariants/layout.test.ts` holds these rules.
- **Standard names.** `types.ts` for a module's shapes, `constants.ts` for module-wide constants only. Helpers and files are named by purpose; `utils.ts` holds only small leftovers.
- **No stutter, no `index.ts`, no barrels.** A file never repeats its folder's name (`plan/plan.ts`). A runtime barrel loads a whole folder on every CLI start, which undoes the start-up cache (ARCHITECTURE.md "Start-up cache") and makes cycles easier to hit; importers name the file they need. The one exception is the transitional type-only `core/types.ts`.
- **Aliases.** Cross-layer imports use `package.json` subpath aliases (`#core/…`), never tsconfig `paths` (#370). `server` and `cli` have none. Inside a layer, imports stay relative.
- **Folder maps.** Each module folder has an `AGENTS.md`: a few hand-written lines (what belongs here, the invariants), then a table of each file and the first sentence of its header comment, between the `forge:map` markers. `npm run docs:map` writes the tables and `test/invariants/docs-map.test.ts` fails when one is stale. `lib/engine/pipeline/step/AGENTS.md` was the first; `lib/`, each layer folder and each folder directly inside a layer has one, and a deeper folder is listed in its parent's table unless it has its own. Area gotchas move out of the root `AGENTS.md` into these, so each rule is stated in one place.
- **Header comments.** Every `lib/` source opens with a comment (after at most a shebang) whose first sentence says what the file holds; that sentence is its map row.
- **Size.** No `lib/**/*.ts` file over 600 lines, except the pinned files on the shrinking allowlist in `test/invariants/file-size.test.ts`. The target for new files is 400.
- **Glossary first.** A new word for a layer or module goes in `docs/GLOSSARY.md` before the code uses it.

**Open item for the move: nested `AGENTS.md`.** Checked on the installed Claude Code 2.1.308: in a project with no `CLAUDE.md` (Forge has none), it loads `AGENTS.md` files as project instructions exactly where it would load `CLAUDE.md`, nested folders included (its default `claude-md-or-agents-md` mode). The pinned 2.1.299 was not checked directly. The maps keep the `AGENTS.md` name, like `dashboard/AGENTS.md`. They are written to be read on demand, and the root `AGENTS.md` points to them, so they work whether or not 2.1.299 auto-loads nested `AGENTS.md` files. Checking the pinned version (does `/memory` list `lib/engine/pipeline/step/AGENTS.md` after reading a file there?) is a human step after #421's PR opens; record the answer here.

## The module map

Every `lib/` file sits under `lib/<layer>/`, except the two deprecated tracker re-exports, `lib/trackers/status.ts` and `lib/trackers/status.mjs`, which `FLAT_LAYERS` in `test/invariants/layer-map.ts` gives to `api`. The move (#421) settled the names within the folder rules: a name drops the prefix its folder now says, and `a ← b` means `a` was `b` before the move. Each folder's `AGENTS.md` maps it file by file.

### api

| Module | Files |
|---|---|
| `types.ts` | ← `api-types.ts` |
| `constants.ts` | `constants.ts` |
| `tracker.ts` | ← `trackers/status.ts`; `trackers/status.ts` and `trackers/status.mjs` stay as deprecated one-line re-exports for one minor release, and the stability contract in docs/RELEASES.md moved to `lib/api/tracker.ts` |

### core

| Module | Files |
|---|---|
| `job/` | store ← `jobs.ts`, `schema.ts`, `requests.ts`, `archive.ts`, fields ← `job-fields.ts`, `focus.ts`, `issue-ref.ts`, `issue-link.ts`, `lens.ts`, session-files ← `daemon-files.ts` |
| `config/` | load ← `config.ts`, defaults ← `config-defaults.ts`, validate ← `config-validate.ts`, fields ← `config-fields.ts`, set ← `config-set.ts`, models ← `config-models.ts`, trust ← `config-trust.ts`, `deprecations.ts`, `components.ts`, sinks ← `config-sinks.ts`, `release-strategy.ts`, and `validators/` |
| `config/validators/` | backing ← `backing-config.ts`, checkout ← `checkout-config.ts`, endpoints ← `endpoints-config.ts`, notify ← `notify-config.ts`, secret-refs ← `secret-refs-config.ts`, `policy-check.ts` |
| `os/` | `platform.ts`, and process, fs and lock from `util.ts` |
| `format/` | `yaml.ts`, `zip.ts`, `ansi.ts` |
| leaves | `types.ts` (transitional type-only barrel), `paths.ts`, `shape.ts`, `glob.ts`, and errors, text and utils from `util.ts` |

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
| `github/` | `gh.ts`, tracker ← `trackers/github.ts`, preview ← `github-preview.ts`, `actor.ts`; `pull-requests.ts` arrives with #414 |
| `claude/` | `transcripts.ts`, `pricing.ts` + `pricing.json`; the session argv arrives with #416 |
| `docker/` | runner ← `docker.ts` |
| `backlog/` | tracker ← `trackers/local.ts` |
| `webhook/` | arrives when notify's transport splits out of `office/notify.ts` |

### engine

| Module | Files |
|---|---|
| `pipeline/` | `step/`, `step.ts`, `brief.ts`, `panel.ts`, `verifiers.ts`, `roster.ts`, `acs.ts`, `findings.ts`, `scope.ts`, `e2e.ts`, `member-panel.ts`, `deps.ts` |
| `workspace/` | `worktree.ts`, `checkout.ts`, `focus-actions.ts`, `editor.ts`, `regenerate.ts`, `job-command.ts` |
| `guard/` | `integrity.ts`, `protected.ts`, `secrets.ts`, `known-secrets.ts`, `secret-refs.ts`, `redact.ts`, `attribution.ts` |
| `environment/` | `backing.ts`, `backing-db.ts`, `ports.ts`, `endpoints.ts`, status ← `environment.ts`, lifecycle ← `environment-lifecycle.ts`, record ← `environment-record.ts`, `config-sinks-apply.ts` |
| `project/` | `member-repos.ts`, `member-trackers.ts`, `job-repos.ts`, graph ← `project.ts`, `repo-order.ts`, `repo-proposals.ts`, `links.ts`, `downstream.ts` |
| `pr/` | lifecycle ← `pr.ts`, `delta.ts` |
| `trackers/` | load ← `trackers/index.ts`, mirror ← `trackers/mirror.ts`, link ← `tracker-link.ts`, `triage.ts`, `request-refresh.ts` |
| `release/` | plan ← `release-plan.ts`, run ← `release-run.ts`, approval ← `release-approval.ts`, `interim.ts`, `interim-apply.ts` |
| `evals/` | run ← `evals.ts`, overlay ← `eval-overlay.ts`, stats ← `eval-stats.ts`, `experiments.ts`, `learnings.ts`, `retro.ts`, `recall.ts`, `scoring.ts`, `outcome.ts`, `autonomy.ts`, `provenance.ts` |
| `metrics/` | `stats.ts`, `usage.ts`, `spend.ts`, `budget.ts`, `repo-budget.ts` |
| `ops/` | `doctor.ts`, `bundle.ts`, `update.ts`, `version.ts`, `retention.ts`, `delete.ts`, `audit.ts`, `detect.ts`, `detect-components.ts`, `title.ts` |

### office

| Module | Files |
|---|---|
| `session/` | lifecycle ← `daemon.ts` (split in #416) |
| pool | ← `daemon-pool.ts` |
| owner | ← `daemon-owner.ts` |
| leaves | `session-agents.ts`, `reconcile.ts`, `foreman.ts`, `notify.ts` |

### server

| Module | Files |
|---|---|
| `start.ts` | ← `server.ts` (the rest of it splits out in #415) |

### cli

| Module | Files |
|---|---|
| main | ← `cli.ts` (`bin/forge` imports it) |
| `commands/` | `commands/` (unchanged inside, except registry ← `render/index.ts`) |
| leaves | `activity.ts` (only `commands/dash.ts` imports it, and it types against the server) |

Where the names differ from a plain prefix drop, the folder rules decided:
- **No stutter.** A name that would repeat its folder takes the name the later split leaves: `git/runner.ts` (matching `docker/runner.ts`), `server/start.ts` (#415), `session/lifecycle.ts` (#416), `pr/lifecycle.ts`, `evals/run.ts`, `environment/status.ts` (the environment as the dashboard shows it) and `project/graph.ts` (the project graph).
- **No `index.ts`.** `cli/commands/render/index.ts` became `render/registry.ts`, because its header calls it the renderer registry.

## Today's upward edges

With the placement above, 26 imports point up a layer. `ALLOWED_EDGES` in `test/invariants/layer-map.ts` is the live list; it may only shrink, and an entry that no longer exists or no longer points up fails as stale.

| Edges | What removes them |
|---|---|
| `core/types.ts` type-imports `engine/pipeline/acs.ts`, `engine/guard/secrets.ts` and `engine/pipeline/findings.ts`; `api/tracker.ts` type-imports `core/types.ts` | the types split (#413): each shape moves to the module that owns it |
| `core/job/store.ts` reaches `engine/guard/known-secrets.ts`, `engine/evals/overlay.ts`, `engine/evals/provenance.ts`, `integrations/github/actor.ts`, `integrations/git/repo-slug.ts` and `integrations/claude/pricing.ts`; `core/paths.ts` reaches `integrations/git/runner.ts` | hooks or parameters in the job store (like `onTransition`), or the pieces moving down to a core leaf |
| `core/job/schema.ts` reaches `engine/pr/delta.ts` and `engine/project/member-repos.ts`; `core/config/validate.ts` and `core/job/lens.ts` reach `engine/project/member-repos.ts` | the value validators (`isSha`, `REPO_NAME`, `isSafeBranch`, the repo problems) moving into `core/config/` |
| `engine/pipeline/step/gates.ts`, `engine/pipeline/step/stages/build.ts`, `engine/pipeline/step/stages/decide.ts`, `engine/pr/lifecycle.ts` and `engine/release/approval.ts` reach `office/foreman.ts` | the Foreman's gate classes and round ceilings moving to engine, with office keeping the session |
| `engine/ops/doctor.ts`, `engine/pr/lifecycle.ts` and `engine/guard/secrets.ts` reach `office/notify.ts`; `engine/ops/doctor.ts` reaches `office/session/lifecycle.ts` | notify's transport splitting to `integrations/webhook/` and the queue to engine; the API-key variables moving to `integrations/claude/` (#416) |
| `integrations/github/tracker.ts` reaches `engine/pr/lifecycle.ts` and `engine/guard/attribution.ts` | the tracker loader's security wrappers (attribution stripping applied in engine) and `repoSlug` moving to `integrations/github/` (#414) |

## Tests

| Kind | Definition | Lives in |
|---|---|---|
| Unit | Imports one module and calls its functions in-process. No subprocess, no git repo, no network; temp files are fine. | Beside the module: `lib/core/job/store.test.ts`, `dashboard/src/lib/board.test.ts` |
| Integration | One entry point for real (a CLI command, an HTTP endpoint, a pool session, an adapter), with outside systems faked | `test/integration/<entry point>/` |
| E2E | A whole flow across layers in a scratch git repo | `test/e2e/<flow>/` |
| Invariants | Rules about the repository itself, not behaviour: workflow security, docs sync, the dashboard invariants, the layer and file-size tripwires | `test/invariants/` |
| Support | Helpers, fake binaries and fixtures; no tests | `test/support/` |

`test/invariants/` has started: `layers.test.ts` (with `layer-map.ts`), `file-size.test.ts` and `docs-map.test.ts`, run by `npm run test:invariants`. The other invariant tests (`ci-workflow`, `governance`, `dashboard-invariants` and the rest) move there with #420, along with the tsconfig includes and CI sharding by kind. A `*.test.ts` under `lib/` is scanned for imports and given a layer, but is outside the size cap and the maps.

## The big-file splits

Each split is its own PR and changes no behaviour; the existing tests, unchanged apart from paths, are the proof. `step.ts` already split into `lib/step/` (#347).

### pr.ts → `engine/pr/` and `integrations/github/` (#414)

| File | Contents | ≈ lines |
|---|---|---|
| `integrations/github/pull-requests.ts` | `graphql`, `findPr`, `refuseUnsafeRefs`, `repoSlug`: the gh mechanism | 100 |
| `engine/pr/open.ts` | `openPr`, interim open plan, retarget, push, PR text and body, escalation approval | 330 |
| `engine/pr/members.ts` | member-repo PRs: check, open, record, sibling links, sync | 300 |
| `engine/pr/sync.ts` | `syncPr`, transitions, reopen, checks summary, feedback | 310 |
| `engine/pr/integrate.ts` | `integrate`, `integrateContinue` | 190 |
| `engine/pr/merge.ts` | `mergePr`, targets, linked merges, `readyPr`, release-gate message | 350 |

### server.ts → `server/` (#415)

Most of the file is one closure inside `startServer`. Pass the closure's state (token, SSE clients, pool, projects dir, previewer) explicitly as a `ServerCtx`, then replace the `if (p === …)` chain with a route table of `{ method, path | RegExp, handler(ctx, req, res, match) }`. That table is the server's map.

| File | Contents | ≈ lines |
|---|---|---|
| `start.ts` | `startServer`, lifecycle, the route table, dispatch | 200 |
| `http.ts` | Host, token, Origin and JSON guards, body readers, `send` and `json`, `safeJoin` | 200 |
| `static.ts` | dist allowlist, page, immutable assets, images, screenshots | 130 |
| `sse.ts` | `broadcast`, frames, `/api/events`, ping | 100 |
| `routes/jobs.ts` | job detail, file and raw, POST jobs, effort, repos, run, editor | 300 |
| `routes/office.ts` | daemon, mode, permission, daemon log, session log | 200 |
| `routes/transcripts.ts` | locate, page, events | 150 |
| `routes/config.ts` | config GET/POST, webhook masking, budget ack | 120 |
| `routes/misc.ts` | state, stats, evals, requests, roster, project, backlog, about, doctor, bundle, GitHub preview, focus | 250 |

Keeping `http.ts` small and alone is the security win: the loopback, token, Origin and JSON rules become one file a reviewer reads whole. `.github/CODEOWNERS` has to name it.

### daemon.ts → `office/session/` and `integrations/claude/` (#416)

| File | Contents | ≈ lines |
|---|---|---|
| `office/session/contract.ts` | SessionEvent, LogSink, DaemonOptions, SessionContext, Session | 220 |
| `integrations/claude/argv.ts` | permission mode and effort flags, `buildArgv`, `sessionEnv`, `apiKeyVars` | 120 |
| `office/session/control.ts` | `sessionGrant`, `ruleText`, `permissionResponse`, `modeRequest` | 110 |
| `office/session/holds.ts` | `heldByBudget`, `heldByRepoBudget`, `parseRateLimit`, `sessionAgents` | 130 |
| `office/session/files.ts` | session files, info read and write, `reapOrphans`, `otherOwner` | 220 |
| `office/session/log.ts` | `readLogPage`, `tailLines`, `capLine`, `splitter` | 140 |
| `office/session/lifecycle.ts` | `createSession` | 900 → ≈450 after the second step |

`createSession` is a 900-line closure, so it splits in two steps. Step 1 is the mechanical moves above. Step 2 extracts closure groups into factories that take a shared `core` object: control-channel handling (`onControl*`, `setPermissionMode`, `answerPermission`), idle and missed-turn timers, and the agent keepalive. Child lifecycle (spawn, stdout, result, exit, kill) stays in `lifecycle.ts`. Step 2 is the riskiest change here, so it goes last, behind `test/integration/pool/daemon.test.ts`.

## Order of work

One PR each.

1. **Groundwork (#412, landed):** glossary words, header comments, `test/invariants/` with the layer, file-size and folder-map tests on today's flat tree, `npm run docs:map` with `lib/step/AGENTS.md`, and this doc.
2. **The move (#421, landed):** `git mv` and an import-rewriting codemod into the seven layers, with no content edits beyond the `util.ts` split, renames and the paths computed from the plugin root. It leaves only the two deprecated tracker re-exports in `FLAT_LAYERS`, re-keys `ALLOWED_EDGES` and the size pins, and updates CODEOWNERS, the hook, `bin/forge`, prompts and doc paths (`ci.yml` names only `lib/trackers/status.mjs`, which stays). It adds each layer and module folder's `AGENTS.md` and slims the root one, and adds the folder layout test (`test/invariants/layout.test.ts`: 3–12 entries, no stutter, no `index.ts`, the maps).
3. **Aliases (#370, landed):** the `#core/…` subpath map and its cross-layer relative-import test.
4. **types.ts by owner (#413)**, with the transitional type-only barrel.
5. **pr.ts (#414)**, **server.ts (#415)**, **daemon.ts (#416)**, **worktree.ts (#417)** (create/remove, command templating, `verify`, the dev server), **commands/job.ts (#418)** (`HELP` apart, one handler per subcommand), **the release splits (#419)** (`release-plan.ts`, `release-run.ts`). Each deletes its size pin and the upward edges it removes.
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
