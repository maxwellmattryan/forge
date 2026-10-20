# lib/ layout and the big-file splits

Status: proposal (2026-10-19). Nothing here has landed.

## Why

`lib/` is 99 files in one flat folder (≈39k lines with `commands/` and `trackers/`). An agent that lists it sees 99 names and no grouping. The five biggest files (types, daemon, pr, server, step) are 1.4k to 2.2k lines each, so an agent has to read them in chunks and often misses the part it needed. The goal is a structure where folder names, file names and a small map in each folder lead an agent to the right ~300 lines.

Decisions this proposal takes:

- **Domain folders, not barrels.** A runtime `index.ts` that re-exports a folder would load the whole folder on every CLI start, which undoes the start-up work (ARCHITECTURE.md "Start-up cache"), and makes import cycles easier to hit (the reason `backing-config.ts` exists). The one exception is `types/`: it is type-only, so a `types.ts` barrel is erased by type stripping and costs nothing.
- **Each folder gets a map in its own `AGENTS.md`.** It opens with a few hand-written lines (what belongs here, what doesn't, the invariants), followed by a generated table of `file → first sentence of its header comment`. `npm run docs:map` writes the table, and a test fails when it's stale, the same way `docs:commands` works. This disclosure is progressive: an agent reads a folder's map only when it works in that folder. Before relying on this, confirm that the pinned CLI (2.1.299) loads nested `AGENTS.md` files on demand. If it only loads `CLAUDE.md`, name the files `CLAUDE.md`.
- **Every file starts with a header comment.** Ten files have none today: `config.ts`, `jobs.ts`, `paths.ts`, `pr.ts`, `server.ts`, `usage.ts`, `util.ts`, `trackers/index.ts`, `trackers/status.ts` and `commands/eval.ts`. The map generator fails on a file without one.
- **No `ai/` folder for markdown.** `agents/`, `skills/` and `hooks/` sit where Claude Code's plugin loader expects them. `reviewers/` and `templates/` are read at runtime by path. `docs/` serves humans and agents equally. The useful split is "loaded into a prompt at runtime" (product) versus "read by contributors" (docs), and the repo already makes it. The markdown change worth making is splitting `docs/CONFIG.md` (953 lines) into one file per config section.
- **A size cap that only tightens.** Add `test/file-size.test.ts`: no `lib/**/*.ts` file may exceed 600 lines, except files on an allowlist pinned to their current line counts. An allowlisted file may shrink but never grow, and drops off the list once it fits. The target for new files is ≤ 400 lines.

## The folder map

The map comes from the import graph: each file goes where most of its imports and importers live. Redundant prefixes are dropped inside a folder (`release-plan.ts` → `release/plan.ts`). Otherwise names stay as they are, so grep, memory and muscle memory still work.

| Folder | Files (new names) | Lines now | What it is |
|---|---|---|---|
| `core/` | util, paths, platform, yaml, zip | 1.3k | Leaf helpers with no domain (fan-in 98 for util, 54 for paths) |
| `types/` + `types.ts` | split of types.ts, see below | 2.2k | Shared shapes, type-only |
| `job/` | jobs, schema, actor, requests, archive, deps, audit | 2.0k | Job records, events, migrations, the request inbox |
| `pipeline/` | `step/` (split), brief, panel, lens, member-panel, roster, verifiers, findings, acs, e2e | 3.2k | What runs next and what agents are told |
| `guard/` | integrity, scope, protected, policy-check, secrets, redact, attribution | 2.7k | Checks that refuse or redact: protected paths, secret scanning, diff integrity, no attribution |
| `config/` | config, fields, set, deprecations, detect, detect-components, components | 2.1k | Loading, validating and writing `.forge/config.yml`; init detection |
| `workspace/` | worktree, checkout, checkout-config, focus, focus-actions, editor, regenerate, sinks, sinks-apply | 2.5k | A job's working copy and what gets written into it |
| `services/` | backing, backing-config, ports, endpoints, endpoints-config | 1.0k | What a job runs against: Docker backing services, ports, endpoints |
| `repos/` | members, job-repos, project, order, proposals, slug, links, downstream | 1.6k | Multi-repo: member repos, the component graph, cross-repo links |
| `release/` | plan, run, approval, strategy, interim, interim-apply | 3.1k | Release plans and interim (pre-release) versions |
| `daemon/` | `session` (split), pool, owner, foreman, notify, notify-config | 3.3k | Headless sessions, the pool, the foreman, notifications |
| `metrics/` | stats, usage, spend, budget, repo-budget, transcripts, pricing.json | 1.4k | Tokens, cost, budgets, transcript reading |
| `evals/` | evals, stats, overlay, retro, learnings | 1.1k | Evals and self-improvement |
| `trackers/` | index, github, local, status.ts, status.mjs (unchanged) + issue-ref, issue-link, tracker-link, triage, member-trackers | 1.7k | Everything about issues |
| `server/` | split of server.ts, github-preview, title | 1.7k | The dashboard's HTTP server |
| `pr/` | split of pr.ts, delta | 1.8k | Pull requests: open, sync, integrate, merge |
| `ops/` | doctor, bundle, update, version, retention | 1.4k | Maintenance: health, support bundles, updates, pruning |
| (root) | cli.ts, `commands/` | – | Unchanged: `bin/forge` imports `lib/cli.ts` |

Paths that must not move, because they're public or pinned:

- `lib/trackers/status.ts` and `lib/trackers/status.mjs`. Custom tracker adapters import them (docs/TRACKERS.md).
- `lib/cli.ts`, which `bin/forge` imports.

### What the move reveals

The folders aren't strictly layered. A few low-level files reach upward, and the move makes that visible:

- `job/jobs.ts` imports notify (`daemon/`), focus (`workspace/`), usage (`metrics/`), lens (`pipeline/`), issue-ref (`trackers/`) and slug (`repos/`).
- `job/schema.ts` and `config/config.ts` import the domain validators (`*-config.ts`). That's by design: validation lives next to its domain but stays out of the domain's runtime.
- `retention` imports daemon and worktree, which is why it goes to `ops/` rather than `job/`.

ESM handles these cycles. Fix them only if they hurt; don't fix them as part of the move. An import-boundary test can come later, once the folders have settled.

## Splitting the five biggest files

Each split is its own PR and changes no behaviour. The existing tests, unchanged, are the proof.

### types.ts (2,218 lines, 113 importers) → `types/`

Split along the section banners that are already in the file:

| File | Sections | ≈ lines |
|---|---|---|
| `types/job.ts` | enumerations, job data, events, RepoProposal | 530 → split into `job.ts` + `events.ts` |
| `types/step.ts` | StepAction family, StepInput | 120 |
| `types/guard.ts` | secret scanning, verifiers, protected paths | 140 |
| `types/config.ts` | Config and friends, settings (ConfigField) | 430 → split into `config.ts` + `config-fields.ts` |
| `types/ops.ts` | doctor, bundle, update, archive and prune | 230 |
| `types/tracker.ts` | requests, tracker contract | 70 |
| `types/api.ts` | GET responses (state, jobs, stats, evals, GitHub preview, project, backlog) | 630 → split into `api-state.ts`, `api-stats.ts`, `api-misc.ts` |
| `types/api-post.ts` | SSE frames, POST bodies and replies, focus and backing | 200 |
| `types/cli.ts` | CliContext, Dispatch, CliError, help | 80 |

`lib/types.ts` becomes a type-only barrel: one `export type * from './types/<x>.ts'` line per file, each with a one-line comment. It's free at runtime and doubles as the map. None of the 113 importers has to change, and new code imports the narrow file. Split `dashboard/src/lib/types.ts` (1,291 lines) the same way so that `test/types-parity.ts` compares file by file.

### step.ts (1,363 lines) → `pipeline/step/`

| File | Contents | ≈ lines |
|---|---|---|
| `step.ts` | `RULES`, `RuleId`, `step()`, `decide()`, `blockedRole()` | 180 |
| `input.ts` | `loadStepInput`, `loadIntegrationTouched`, plan/spec parsing | 150 |
| `shell.ts` | `shellLine` and the SAFE_* patterns | 40 |
| `panel.ts` | lens selection, `choosePanel`, `selectPanel` | 130 |
| `actions.ts` | state helpers, action builders, `spawn`, the generic per-role rules | 250 |
| `gates.ts` | `gateTell`, escalation, and the secret, protected, repo-proposal and downstream gates | 160 |
| `stages.ts` | intake, plan, spec, design, build, verify, review, decide | 270 |
| `ship.ts` | integrate, pr, release bump, deferred PR | 200 |

The split also makes purity structural: `input.ts` is the only file that touches the filesystem. A test can assert that no other file in `step/` imports `node:fs`.

### pr.ts (1,685 lines) → `pr/`

| File | Contents | ≈ lines |
|---|---|---|
| `gh.ts` | `gh`, `graphql`, `findPr`, `refuseUnsafeRefs`, `repoSlug` | 100 |
| `open.ts` | `openPr`, interim open plan, retarget, push, PR text and body, escalation approval | 330 |
| `members.ts` | member-repo PRs: check, open, record, sibling links, sync | 300 |
| `sync.ts` | `syncPr`, transitions, reopen, checks summary, feedback | 310 |
| `integrate.ts` | `integrate`, `integrateContinue` | 190 |
| `merge.ts` | `mergePr`, targets, linked merges, `readyPr`, release-gate message | 350 |

### server.ts (1,392 lines) → `server/`

Most of the file is one 670-line closure inside `startServer`. Pass the closure's state (token, SSE clients, pool, projects dir, previewer) explicitly as a `ServerCtx`. Then replace the `if (p === …)` chain with a route table of `{ method, path | RegExp, handler(ctx, req, res, match) }`. That table is the server's map.

| File | Contents | ≈ lines |
|---|---|---|
| `server.ts` | `startServer`, lifecycle, the route table, dispatch | 200 |
| `http.ts` | Host, token, Origin and JSON guards, body readers, `send` and `json`, `safeJoin` | 200 |
| `static.ts` | dist allowlist, page, immutable assets, images, screenshots | 130 |
| `sse.ts` | `broadcast`, frames, `/api/events`, ping | 100 |
| `routes/jobs.ts` | job detail, file and raw, POST jobs, effort, repos, run, editor | 300 |
| `routes/daemon.ts` | daemon, mode, permission, daemon log, session log | 200 |
| `routes/transcripts.ts` | locate, page, events | 150 |
| `routes/config.ts` | config GET/POST, webhook masking, budget ack | 120 |
| `routes/misc.ts` | state, stats, evals, requests, roster, project, backlog, about, doctor, bundle, GitHub preview, focus | 250 |

Keeping `http.ts` small and alone is the security win here: the loopback, token, Origin and JSON rules become one file a reviewer can read whole. `.github/CODEOWNERS` has to name it.

### daemon.ts (1,828 lines) → `daemon/`

| File | Contents | ≈ lines |
|---|---|---|
| `contract.ts` | SessionEvent, LogSink, DaemonOptions, SessionContext, Session | 220 |
| `argv.ts` | permission mode and effort flags, `buildArgv`, `sessionEnv`, `apiKeyVars` | 120 |
| `control.ts` | `sessionGrant`, `ruleText`, `permissionResponse`, `modeRequest` | 110 |
| `holds.ts` | `heldByBudget`, `heldByRepoBudget`, `parseRateLimit`, `sessionAgents` | 130 |
| `files.ts` | session files, info read and write, `reapOrphans`, `otherOwner` | 220 |
| `log.ts` | `readLogPage`, `tailLines`, `capLine`, `splitter` | 140 |
| `session.ts` | `createSession` | 900 → ≈450 after the second step |

`createSession` is a 900-line closure, so split it in two steps. Step 1 is the mechanical moves above. Step 2 extracts closure groups into factories that take a shared `core` object: control-channel handling (`onControl*`, `setPermissionMode`, `answerPermission`; ≈120 lines), idle and missed-turn timers (≈80), and the agent-keepalive logic (≈60). Child lifecycle (spawn, stdout, result, exit, kill) stays in `session.ts`. Step 2 is the riskiest change in this plan, so it goes last, behind `test/daemon.test.ts` (2,895 lines).

## Order of work

1. **Groundwork (small, no moves):** header comments on the ten files, `test/file-size.test.ts` with its allowlist, `scripts/module-map.ts` + `npm run docs:map` + the staleness test.
2. **types/ split** with the type-only barrel. No importer changes. Same PR for the dashboard mirror.
3. **The move.** One mechanical PR: `git mv` plus a codemod that rewrites relative imports in `lib/`, `test/`, `hooks/` and `scripts/`, with no content edits. Reviewers check it with `git diff -M --stat` and by rerunning the codemod. Every in-flight job branch will conflict with it, so land it when no Forge jobs are open. The same PR updates:
   - `.github/CODEOWNERS`, which names `server.ts`, `daemon.ts`, `daemon-pool.ts`, `attribution.ts`, `config-fields.ts` and `schema.ts`. Missing an entry silently drops required review on security-sensitive code.
   - `ci.yml` (it references `lib/server.ts`) and `test/ci-workflow.test.ts`.
   - `hooks/no-ai-attribution.ts`, `agents/builder.md`, `skills/forge/reference/evals.md`.
   - About 94 path mentions across `AGENTS.md`, `README.md` and `docs/`, plus the `PLUGIN_ROOT/lib/pricing.json` read in `server.ts`.
   - Each folder's `AGENTS.md`. The root `AGENTS.md` "Layout" section shrinks to the folder table.
4. **Splits**, one PR each: step, pr, server, daemon (step 1, then step 2).
5. **Tests mirror the folders** (`test/<folder>/*.test.ts`), in its own PR: the glob becomes `"test/**/*.test.ts"` in ci.yml, AGENTS.md and `test/ci-workflow.test.ts`, and the `WINDOWS_SKIP` paths change with it. 194 test files in one folder is the same problem as `lib/`.
6. **Later, as needed:** `docs/CONFIG.md` per section; `commands/job.ts` (985), `worktree.ts` (1,234), `interim-apply.ts` (928) and `integrity.ts` (839) off the allowlist; grouping `dashboard/src/lib` (48 files) by view.
