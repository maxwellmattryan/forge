# lib/ layout and the big-file splits

Status: decided (2026-10-19). Nothing here has landed. The conventions below were settled with the maintainer and supersede the first draft of this file.

## Why

`lib/` is 99 files in one flat folder (≈39k lines with `commands/` and `trackers/`). An agent that lists it sees 99 names and no grouping. The five biggest files (types, daemon, pr, server, step) are 1.4k to 2.2k lines each, so an agent has to read them in chunks and often misses the part it needed. The goal is a structure where folder names, file names and a small map in each folder lead an agent to the right ~300 lines, so builders and planners spend less time and fewer tokens finding their way.

## Conventions

These apply to all new `lib/` code from now on, before and after the move.

- **Nested modules.** Code lives at `lib/<module>/<file>.ts`. A concept gets its own sub-module (`lib/<module>/<sub>/<file>.ts`) once it has at least 3 files of its own, roughly 500+ lines. Nothing goes deeper than `lib/module/sub/file.ts`.
- **Folder size.** About 18 top-level modules, and 3–12 entries per folder. Registries, folders whose files are entries in one table, are exempt (`cli/commands/`, `cli/commands/render/`, `server/routes/`).
- **Standard names.** A module's shared shapes go in its `types.ts`, and its module-wide constants in `constants.ts`. A constant used in one file stays in that file.
- **Name by purpose.** Helpers are named for what they do (`gh.ts`, `lock.ts`), and `utils.ts` holds only small leftovers. Files are named for their purpose too (`release/plan/build.ts`).
- **No stutter.** A file never repeats its folder's name (`plan/plan.ts`, `server/server.ts`, `config/config.ts` are wrong) and drops a prefix its folder already says (`release-plan.ts` → `release/plan/`).
- **No `index.ts` and no runtime barrels.** A barrel that re-exports a folder loads the whole folder on every CLI start, which undoes the start-up work (ARCHITECTURE.md "Start-up cache"), and makes import cycles easier to hit (the reason `backing-config.ts` exists). Importers name the file they need. The one exception is the transitional `lib/types.ts` (see below), which is type-only and erased by type stripping.
- **Per-folder `AGENTS.md` maps.** Each module folder has an `AGENTS.md`: a few hand-written lines (what belongs here, what doesn't, the invariants), then a generated table of `file → first sentence of its header comment`. `npm run docs:map` writes the table, and a test fails when it's stale, the same way `docs:commands` works. Before relying on this, confirm that the pinned CLI (2.1.299) loads nested `AGENTS.md` files on demand; if it only loads `CLAUDE.md`, name the files `CLAUDE.md`.
- **A slimmer root `AGENTS.md`.** The root file (≈23 KB) keeps the essentials, the rules and the verify list. Area-specific gotchas move to the nested file of the area they concern: dashboard gotchas to `dashboard/AGENTS.md`, session and transcript gotchas to `lib/office/AGENTS.md`, the start-up cache to `lib/cli/AGENTS.md`, and so on. Its "Layout" section shrinks to the module table.
- **Every file starts with a header comment.** Ten files have none today: `config.ts`, `jobs.ts`, `paths.ts`, `pr.ts`, `server.ts`, `usage.ts`, `util.ts`, `trackers/index.ts`, `trackers/status.ts` and `commands/eval.ts`. The map generator fails on a file without one.
- **CLI on top.** The CLI is the highest layer: `lib/cli/` holds the entry and `cli/commands/`, built on the domain modules. Domain modules never import from `cli/`.
- **Small files stay files.** Don't make a folder for one concept that fits in one file: `release/approval.ts` and `release/strategy.ts` stay files, while `release/plan/` and `release/run/` are sub-modules. `office/foreman.ts` stays a file until #281 grows it.
- **`test/` mirrors `lib/`.** `lib/<module>/<file>.ts` is tested by `test/<module>/<file>.test.ts`. `test/helpers.ts` and `test/fixtures/` stay at the root.
- **A flat-folder rule with a tripwire.** AGENTS.md states the principle in one line, and `test/layout.test.ts` enforces it for `lib/` and `test/`: at most 12 entries per folder (registries exempt), no path deeper than `lib/module/sub/file.ts`, no `index.ts`, and no file named like its folder.
- **A size cap that only tightens.** `test/file-size.test.ts`: no `lib/**/*.ts` file may exceed 600 lines, except files on an allowlist pinned to their current line counts. An allowlisted file may shrink but never grow, and drops off the list once it fits. The target for new files is ≤ 400 lines.

Not part of this: an `ai/` folder for markdown. `agents/`, `skills/` and `hooks/` sit where Claude Code's plugin loader expects them, and `reviewers/` and `templates/` are read at runtime by path. The markdown change worth making later is splitting `docs/CONFIG.md` (982 lines) into one file per config section.

## The module map

Each file goes where most of its imports and importers live. Names drop the prefix their folder now says; otherwise they stay as they are, so grep and habit still work. Glossary words name modules where the glossary has one (`project`, `environment`, `release`); `office` and `workspace` are added to `docs/GLOSSARY.md` before the move.

| Module | Files (new names) | Lines now | What it is |
|---|---|---|---|
| `cli/` | `main.ts` (was `cli.ts`), `commands/` (unchanged inside, `render/index.ts` → `render/registry.ts`) | 0.3k + commands | The CLI entry and one module per command group; `bin/forge` imports `lib/cli/main.ts` |
| `core/` | `errors.ts`, `process.ts`, `fs.ts`, `lock.ts`, `text.ts`, `git.ts`, `utils.ts` (split from util.ts), `paths.ts`, `platform.ts`, `yaml.ts`, `zip.ts` | 1.3k | Leaf helpers with no domain (fan-in 98 for util, 54 for paths) |
| `job/` | `store.ts` (was jobs.ts), `schema.ts`, `actor.ts`, `requests.ts`, `archive.ts`, `deps.ts`, `audit.ts`, `types.ts` | 2.0k | Job records, events, migrations, the request inbox |
| `pipeline/` | `step/` (split, see below), `review/` (panel, lenses, members, findings), `brief.ts`, `verifiers.ts`, `roster.ts`, `acs.ts`, `e2e.ts`, `types.ts` | 3.2k | What runs next and what agents are told |
| `guard/` | `integrity.ts`, `scope.ts`, `protected.ts`, `policy-check.ts`, `secrets.ts`, `redact.ts`, `attribution.ts`, `types.ts` | 2.7k | Checks that refuse or redact: protected paths, secret scanning, diff integrity, no attribution |
| `config/` | `load.ts` (was config.ts), `fields.ts`, `set.ts`, `deprecations.ts`, `detect.ts`, `detect-components.ts`, `components.ts`, `types.ts` | 2.2k | Loading, validating and writing `.forge/config.yml`; init detection |
| `workspace/` | `worktree.ts`, `checkout.ts`, `checkout-config.ts`, `focus.ts`, `focus-actions.ts`, `editor.ts`, `regenerate.ts` | 2.0k | A job's working copy and what points at it |
| `environment/` | `backing.ts`, `backing-config.ts`, `ports.ts`, `endpoints.ts`, `endpoints-config.ts`, `sinks.ts`, `sinks-apply.ts` | 1.5k | What a job runs against: backing services, ports, endpoints, config sinks |
| `project/` | `members.ts`, `job-repos.ts`, `graph.ts` (was project.ts), `order.ts`, `proposals.ts`, `slug.ts`, `links.ts`, `downstream.ts` | 1.6k | Member repos, the project graph, local links |
| `release/` | `plan/` (split of release-plan.ts), `run/` (split of release-run.ts), `approval.ts`, `strategy.ts`, `interim.ts`, `interim-apply.ts` | 3.1k | Release plans and interim references |
| `office/` | `session/` (split of daemon.ts), `pool.ts`, `inbox.ts`, `owner.ts`, `foreman.ts`, `notify.ts`, `notify-config.ts`, `constants.ts` | 3.3k | Headless sessions, the pool, the inbox, the Foreman, notifications |
| `metrics/` | `stats.ts`, `usage.ts`, `spend.ts`, `budget.ts`, `repo-budget.ts`, `transcripts.ts`, `pricing.json` | 1.4k | Tokens, cost, budgets, transcript reading |
| `evals/` | `run.ts` (was evals.ts), `stats.ts`, `overlay.ts`, `retro.ts`, `learnings.ts` | 1.1k | Evals and self-improvement |
| `trackers/` | `load.ts` (was index.ts), `github.ts`, `local.ts`, `status.ts`, `status.mjs` + `issue-ref.ts`, `issue-link.ts`, `link.ts`, `triage.ts`, `members.ts` | 1.7k | Everything about issues |
| `server/` | split of server.ts with `routes/`, `github-preview.ts`, `title.ts`, `types.ts` (the `/api` shapes) | 1.7k | The dashboard's HTTP server |
| `pr/` | split of pr.ts, `delta.ts` | 1.8k | Pull requests: open, sync, integrate, merge |
| `ops/` | `doctor.ts`, `bundle.ts`, `update.ts`, `version.ts`, `retention.ts` | 1.4k | Maintenance: health, support bundles, updates, pruning |

`office/inbox.ts` is the inbox lane carved out of `daemon-pool.ts` as a move, without behaviour changes; #292 and #298 then change what it does.

Paths that must not move, because they're public:

- `lib/trackers/status.ts` and `lib/trackers/status.mjs`. Custom tracker adapters import them (docs/TRACKERS.md).

`bin/forge` changes its one import to `lib/cli/main.ts` in the move PR, and its start-up cache keys by content, so nothing goes stale.

### What the move reveals

The modules aren't strictly layered. A few low-level files reach upward, and the move makes that visible:

- `job/store.ts` imports notify (`office/`), focus (`workspace/`), usage (`metrics/`), lens (`pipeline/`), issue-ref (`trackers/`) and slug (`project/`).
- `job/schema.ts` and `config/load.ts` import the domain validators (`*-config.ts`). That's by design: validation lives next to its domain but stays out of the domain's runtime.
- `retention` imports the session code and worktree, which is why it goes to `ops/` rather than `job/`.

ESM handles these cycles. Fix them only if they hurt; don't fix them as part of the move. An import-boundary test can come later, once the modules have settled. The one boundary enforced from the start is "nothing outside `cli/` imports `cli/`".

## Splitting types.ts

`types.ts` (2,238 lines, 113 importers) splits by owner: each section moves to the `types.ts` of the module that owns the shape, along the section banners already in the file.

| Destination | Sections |
|---|---|
| `job/types.ts` | enumerations, job data, events, RepoProposal |
| `pipeline/types.ts` | StepAction family, StepInput |
| `guard/types.ts` | secret scanning, verifiers, protected paths |
| `config/types.ts` | Config and friends, settings (ConfigField) |
| `ops/types.ts` | doctor, bundle, update, archive and prune |
| `trackers/types.ts` | requests, tracker contract |
| `server/types.ts` | GET responses, SSE frames, POST bodies and replies (split into `api/` files only if it passes 600 lines) |
| `cli/types.ts` | CliContext, Dispatch, CliError, help |

During the move `lib/types.ts` stays as a type-only barrel, one `export type * from './<module>/types.ts'` line per module, so none of the 113 importers has to change at once. New code imports the module's file. The barrel is deleted once nothing imports it. Split `dashboard/src/lib/types.ts` (1,291 lines) to match `server/types.ts` so that `test/types-parity.ts` compares file by file.

## Splitting the four other big files

Each split is its own PR and changes no behaviour. The existing tests, unchanged, are the proof.

### step.ts (1,422 lines) → `pipeline/step/`

The split landed as `lib/step/` (issue #347): ordered rule tables per stage, with `lib/step.ts` kept as re-exports; the proposal below is the earlier plan.

| File | Contents | ≈ lines |
|---|---|---|
| `decide.ts` | `RULES`, `RuleId`, `step()`, `decide()`, `blockedRole()` | 180 |
| `input.ts` | `loadStepInput`, `loadIntegrationTouched`, plan/spec parsing | 150 |
| `shell.ts` | `shellLine` and the SAFE_* patterns | 40 |
| `panel-choice.ts` | lens selection, `choosePanel`, `selectPanel` | 130 |
| `actions.ts` | state helpers, action builders, `spawn`, the generic per-role rules | 250 |
| `gates.ts` | `gateTell`, escalation, and the secret, protected, repo-proposal and downstream gates | 160 |
| `stages.ts` | intake, plan, spec, design, build, verify, review, decide | 270 |
| `ship.ts` | integrate, pr, release bump, deferred PR | 200 |

The split also makes purity structural: `input.ts` is the only file that touches the filesystem, and a test asserts that no other file in `step/` imports `node:fs`.

### pr.ts (1,684 lines) → `pr/`

| File | Contents | ≈ lines |
|---|---|---|
| `gh.ts` | `gh`, `graphql`, `findPr`, `refuseUnsafeRefs`, `repoSlug` | 100 |
| `open.ts` | `openPr`, interim open plan, retarget, push, PR text and body, escalation approval | 330 |
| `members.ts` | member-repo PRs: check, open, record, sibling links, sync | 300 |
| `sync.ts` | `syncPr`, transitions, reopen, checks summary, feedback | 310 |
| `integrate.ts` | `integrate`, `integrateContinue` | 190 |
| `merge.ts` | `mergePr`, targets, linked merges, `readyPr`, release-gate message | 350 |

### server.ts (1,391 lines) → `server/`

Most of the file is one 670-line closure inside `startServer`. Pass the closure's state (token, SSE clients, pool, projects dir, previewer) explicitly as a `ServerCtx`. Then replace the `if (p === …)` chain with a route table of `{ method, path | RegExp, handler(ctx, req, res, match) }`. That table is the server's map.

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

Keeping `http.ts` small and alone is the security win here: the loopback, token, Origin and JSON rules become one file a reviewer can read whole. `.github/CODEOWNERS` has to name it.

### daemon.ts (1,829 lines) → `office/session/`

| File | Contents | ≈ lines |
|---|---|---|
| `contract.ts` | SessionEvent, LogSink, DaemonOptions, SessionContext, Session | 220 |
| `argv.ts` | permission mode and effort flags, `buildArgv`, `sessionEnv`, `apiKeyVars` | 120 |
| `control.ts` | `sessionGrant`, `ruleText`, `permissionResponse`, `modeRequest` | 110 |
| `holds.ts` | `heldByBudget`, `heldByRepoBudget`, `parseRateLimit`, `sessionAgents` | 130 |
| `files.ts` | session files, info read and write, `reapOrphans`, `otherOwner` | 220 |
| `log.ts` | `readLogPage`, `tailLines`, `capLine`, `splitter` | 140 |
| `lifecycle.ts` | `createSession` | 900 → ≈450 after the second step |

`createSession` is a 900-line closure, so split it in two steps. Step 1 is the mechanical moves above. Step 2 extracts closure groups into factories that take a shared `core` object: control-channel handling (`onControl*`, `setPermissionMode`, `answerPermission`; ≈120 lines), idle and missed-turn timers (≈80), and the agent-keepalive logic (≈60). Child lifecycle (spawn, stdout, result, exit, kill) stays in `lifecycle.ts`. Step 2 is the riskiest change in this plan, so it goes last, behind `test/integration/pool/daemon.test.ts` (the pool and session tests #360 split out of `test/daemon.test.ts`).

## Order of work

1. **Groundwork (small, no moves):** add `office` and `workspace` to `docs/GLOSSARY.md`; header comments on the ten files; `test/file-size.test.ts` with its allowlist; `scripts/module-map.ts` + `npm run docs:map` + the staleness test; the flat-folder rule in AGENTS.md. `test/layout.test.ts` lands here too, with today's flat `lib/` on its allowlist, so the move only shrinks the list.
2. **The move.** One mechanical PR: `git mv` plus a codemod that rewrites relative imports in `lib/`, `test/`, `hooks/`, `scripts/` and `bin/forge`, with no content edits beyond the `util.ts` split and the renames above. Reviewers check it with `git diff -M --stat` and by rerunning the codemod. Every in-flight job branch will conflict with it, so land it when no Forge jobs are open. The same PR updates:
   - `.github/CODEOWNERS`, which names `server.ts`, `daemon.ts`, `daemon-pool.ts`, `attribution.ts`, `config-fields.ts` and `schema.ts`. Missing an entry silently drops required review on security-sensitive code.
   - `ci.yml` (it references `lib/server.ts`) and `test/ci-workflow.test.ts`.
   - `hooks/no-ai-attribution.ts`, `agents/builder.md`, `skills/forge/reference/evals.md`.
   - About 94 path mentions across `AGENTS.md`, `README.md` and `docs/`, plus the `PLUGIN_ROOT/lib/pricing.json` read in `server.ts`.
   - Each module's `AGENTS.md`, and the slimmed root `AGENTS.md`.
3. **types.ts by owner**, with the transitional type-only barrel. Same PR for the dashboard mirror.
4. **Splits**, one PR each: step, pr, server, daemon (step 1, then step 2), then `release/plan/` and `release/run/`.
5. **Tests mirror the modules** (`test/<module>/*.test.ts`), in its own PR. #360 already widened the glob to `"test/**/*.test.ts"` in ci.yml, AGENTS.md and `test/ci-workflow.test.ts`, and placed its merged files where this step wants them (docs/TESTING.md › Layout). 207 test files in one folder is the same problem as `lib/`.
6. **Later, as needed:** delete the `lib/types.ts` barrel; `docs/CONFIG.md` per section; `cli/commands/job.ts` (984), `workspace/worktree.ts` (1,233), `config/load.ts` (971), `release/interim-apply.ts` (927) and `guard/integrity.ts` (838) off the allowlist; grouping `dashboard/src/lib` (48 files) by view.

## Timing against other work

- The move (step 2) conflicts with every open job branch. Land it between waves, with no Forge jobs open.
- #292, #288 and #298 rework the pool and sessions, and #281 grows the Foreman. Either land the `office/` move before them, or land them first and move their result; don't run both at once.
- #280 resets every schema version for 1.0.0 and lands last before the tag, so it touches `job/schema.ts` after the move, not before.
