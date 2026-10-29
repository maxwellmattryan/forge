# Test rewrite

Forge's test suite is being rewritten around behaviour and edge cases, one test file beside each module, checked in-process wherever it can be. This folder is the entry point: what happened, what was kept, and what each rewrite job builds from.

## What happened and why

The suite had 218 test files, 1,960 tests and 61.6k lines, more than `lib/`'s 48.8k. Most jobs had added one test per acceptance criterion, and 128 files spawned a process (67 started the real CLI). It was slow and hard to change.

Rewriting from a summary is cheaper than migrating 1,960 tests, so the old suite was recorded, tagged and deleted:

- **The tag** `tests-before-rewrite` (on `719783b0`, `develop` after #446) holds the old suite. It is the audit trail for the orchestrator and the maintainer. **Builders don't read it.** That is where the speed comes from, and it keeps them from rebuilding the old shape.
- **The inventories** in [`modules/`](modules/) are what builders read instead: one per module folder, plus the dashboard, `hooks/`, `bin/forge`, `scripts/` and `templates/release-gate/`. Each one lists every behaviour, edge case and regression the old tests checked, with the literal inputs, values, error codes and field names, so it is enough on its own beside the module's source.
- **A short keep list** of tables and tripwires stays as it was (below).

This change suspends docs/TESTING.md's coverage rule ("no file drops more than 1 point") until the rewrite finishes.

The `lib/` splits #415–#419 land after this change. They move code between files inside the same module folders, so the inventories still apply; those jobs only fix an inventory's `Source:` and `Public surface:` lines when a name moves.

## Baseline

The numbers are recorded in [`baseline/`](baseline/): `counts.md`, `times.txt` (each file's time, slowest first, with load average and Node version) and `coverage.txt`; `times-after-teardown.txt` and `coverage-after-teardown.txt` were taken after the deletion.

| | Before (`tests-before-rewrite`) | After teardown |
|---|---|---|
| Test files | 218 | 30 |
| Tests (`it`/`test` with a title) | 1,960 | 123 (710 run: 552 are generated step-table rows) |
| Lines in test files | 61,580 | 4,503 |
| Local wall time (`npm run test:times`, Node 26.3) | 283.3 s | 8.2 s |
| CI wall time | 6 m 14 s | first run on #447 |
| Line coverage, `lib/` + `dashboard/src/lib/` | 99.6% | 94.3% of the 214 files still loaded (55 files no kept test loads drop out of the report) |

## What stays

These are cheap tables and tripwires that a rewrite from a summary would get wrong. They pass unchanged, and their inventories mark their items "kept, not rewritten".

| Kept | Where it lives now | Why |
|---|---|---|
| The repository tripwires: layers, file size, folder layout, folder maps | `test/invariants/layers.test.ts`, `file-size.test.ts`, `layout.test.ts`, `docs-map.test.ts` (+ `layer-map.ts`) | They read the tree; no function exposes it. `layers.test.ts` also holds the colocated-test import rule and "runtime code never imports dashboard sources" (from `dashboard-lib.test.ts`). |
| docs/TESTING.md › Allowed source-text tests | `test/invariants/`: `dashboard-invariants`, `ci-workflow`, `release-workflow` (+ `workflow-lint.ts`), `governance`, `docs-glossary` (whole files); `cli-contract` (README table), `config-set` ("field schema is an allowlist over documented keys"), `version` ("deprecated config keys"), `findings` ("builder prompt example parses"), `engine-ts` (tsconfig strict and erasable-only), `agent-tools` (assistant has no Bash; triage on haiku) (one test each) | Each is on the Allowed list; the single tests were moved out of files that are otherwise deleted. |
| Migration tables | `test/schema.test.ts`, `test/job-repos-schema.test.ts`, `test/outcome-schema.test.ts`, `test/score-schema.test.ts` | The only proof that old jobs still read. |
| Pipeline transition table | `test/step.test.ts`, `test/step-tables.test.ts`, `test/step-rows.ts`, `test/step-fixture.ts` | AGENTS.md requires a row per transition. |
| Server security posture | `test/integration/server/security.test.ts`: "dashboard server rejects DNS-rebound hosts and cross-origin posts", "POST /api/daemon is token, origin and JSON guarded", "POST /api/config is token, origin and JSON guarded" | Loopback Host, token, Origin and JSON checks. |
| Fork-PR refusal | `lib/engine/pr/adopt.test.ts`: "findPr never adopts a fork PR on the job's branch" | Never adopt fork PRs. |
| Start-up cache | `test/integration/cli/startup-cache.test.ts` (whole file: five tests, all about `bin/forge`'s cache; splitting off the ownership and permission checks wasn't worth it) | A sandboxed agent must not plant a module an unsandboxed start runs. |
| No-AI-attribution hook | `lib/engine/guard/attribution.test.ts` (whole file) | The hook and `stripAttribution`/`scrubBranch`. |
| Secret redaction | `lib/engine/guard/known-secrets.test.ts` ("redactors replace raw and JSON-escaped values, longest first"), `lib/engine/guard/secret-refs.test.ts` ("fails closed without the value in the error"), `test/integration/cli/secret-gates.test.ts` ("no gate prints a planted value") | No resolved secret reaches output. |
| Helpers and fixtures | `test/helpers.ts`, `test/support/`, `test/fixtures/`, and `test/built-css.ts`, `dist.ts`, `svelte-markup.ts`, `secret-fixtures.ts`, `effort-cases.ts`, `notify-server.ts`, `job-repos-fixture.ts`, `downstream-fixture.ts`, `repo-proposals-fixture.ts`, `retention-fixture.ts`, `repo-budget-fixture.ts` | A kept test imports it, or an inventory's Setup recipes name it, so builders never go to the tag for a fixture. |

The tests beside their modules (`lib/**`) follow the new layout. The tables stay in `test/` because `step-rows.ts` and `step-fixture.ts` are 1,500 lines of data that `lib/`'s file-size, header and layout rules would refuse. `lib/api/constants.test.ts` is new: one tiny colocated test that proves the globs, tsconfigs and CI pick up tests beside modules.

## Rules for new tests

These are also in [docs/TESTING.md › Layout](../TESTING.md#layout).

- **One `<module>.test.ts` beside the module** for its unit behaviour: `lib/<layer>/<module>/<file>.test.ts` or `dashboard/src/lib/<file>.test.ts`. It imports its own module relatively, lower layers through their aliases, and test helpers only through `test/helpers.ts`.
- **`test/integration/` and `test/e2e/` only for entry points and cross-layer flows**: the spawned CLI, the HTTP server, the pool with a stub `claude`, scratch-repo flows. Code outside `lib/` and `dashboard/src/` has no module folder to sit beside, so its tests go to `test/integration/<entry>/`: `bin/forge` to `cli`, `scripts/` to `scripts`, `hooks/` to `hooks`, `templates/release-gate/` to `release-gate`; views and components are not rendered in tests.
- **One test per behaviour**, with its edge cases as rows of a table inside it.
- **In-process first.** At most one spawned-CLI test per command, for its routing, exit code and JSON.
- **No tests of wording, markup, class names or one job's acceptance criteria.**
- **Build job state with the builders.** `jobAt`, `parkedAt`, `withRound` and `withLease` from `test/helpers.ts`, never a hand-copied `createJob` + `setJob` block or a raw `job.json` write. They make no move: a test that needs the gate request or another move effect moves the job itself.
- **No test file over 800 lines.** Split one by behaviour before it gets there (`test/invariants/file-size.test.ts`).
- **Work from the inventory and the source.** Write each B, E and R item (an item may share a test with others); skip what an inventory marks kept. When an item no longer matches the source, check the code and say so in the job, rather than reading the tag.
- **Inventory conventions.** `Old: <name> › <test>` means `test/<name>.test.ts` at the tag (or `test/<dir>/<name>.test.ts` when the inventory's `Old tests:` line lists it there). "Old: none (from source)" marks behaviour no old test covered, read from the code; write a test for it too. Some behaviours appear in two inventories because one old file reached several modules: the module that owns the code (named in the item's tag) writes it, and the other skips it.

## Inventories

The time column is the baseline time of the old files an inventory cites; a file shared by several inventories counts in each.

| Inventory | Unit | Behaviours | Edge cases | Regressions | Old files | Old files' time (s) |
|---|---|---|---|---|---|---|
| [api](modules/api.md) | api | 8 | 2 | 1 | 6 | 115.9 |
| [bin.forge](modules/bin.forge.md) | bin/forge | 7 | 3 | 2 | 10 | 256.1 |
| [cli.commands](modules/cli.commands.md) | cli/commands | 148 | 55 | 12 | 50 | 813.7 |
| [cli](modules/cli.md) | cli | 30 | 6 | 6 | 7 | 189.2 |
| [core.config](modules/core.config.md) | core/config | 93 | 22 | 16 | 36 | 421.7 |
| [core.format](modules/core.format.md) | core/format | 17 | 5 | 2 | 3 | 0.7 |
| [core.job](modules/core.job.md) | core/job | 94 | 23 | 15 | 31 | 416.9 |
| [core](modules/core.md) | core (layer root files) | 25 | 9 | 4 | 14 | 232.5 |
| [core.os](modules/core.os.md) | core/os | 28 | 7 | 5 | 11 | 124.2 |
| [dashboard.lib](modules/dashboard.lib.md) | dashboard/lib | 250 | 33 | 3 | 35 | 93.1 |
| [dashboard.ui](modules/dashboard.ui.md) | dashboard/ui | 23 | 2 | 1 | 3 | 1.2 |
| [engine.environment](modules/engine.environment.md) | engine/environment | 55 | 32 | 3 | 12 | 229.5 |
| [engine.evals](modules/engine.evals.md) | engine/evals | 61 | 55 | 4 | 21 | 125.8 |
| [engine.guard](modules/engine.guard.md) | engine/guard | 89 | 34 | 4 | 20 | 330.6 |
| [engine.metrics](modules/engine.metrics.md) | engine/metrics | 32 | 14 | 1 | 16 | 103.9 |
| [engine.ops](modules/engine.ops.md) | engine/ops | 56 | 32 | 15 | 18 | 202.3 |
| [engine.pipeline](modules/engine.pipeline.md) | engine/pipeline | 172 | 43 | 17 | 23 | 412.9 |
| [engine.pr](modules/engine.pr.md) | engine/pr | 84 | 48 | 5 | 20 | 767.3 |
| [engine.project](modules/engine.project.md) | engine/project | 79 | 36 | 14 | 18 | 227.8 |
| [engine.release](modules/engine.release.md) | engine/release | 74 | 50 | 14 | 9 | 277.8 |
| [engine.trackers](modules/engine.trackers.md) | engine/trackers | 21 | 19 | 2 | 6 | 79.9 |
| [engine.workspace](modules/engine.workspace.md) | engine/workspace | 48 | 15 | 4 | 11 | 280.3 |
| [hooks](modules/hooks.md) | hooks | 8 | 3 | 2 | 3 | 10.8 |
| [integrations.backlog](modules/integrations.backlog.md) | integrations/backlog | 4 | 8 | 0 | 1 | 7.4 |
| [integrations.claude](modules/integrations.claude.md) | integrations/claude | 20 | 8 | 4 | 6 | 35.1 |
| [integrations.docker](modules/integrations.docker.md) | integrations/docker | 5 | 3 | 1 | 4 | 171.4 |
| [integrations.git](modules/integrations.git.md) | integrations/git | 8 | 2 | 3 | 3 | 7.0 |
| [integrations.github](modules/integrations.github.md) | integrations/github | 30 | 16 | 3 | 8 | 176.6 |
| [office](modules/office.md) | office | 106 | 17 | 16 | 14 | 155.3 |
| [office.session](modules/office.session.md) | office/session | 50 | 11 | 12 | 4 | 60.1 |
| [repo.invariants](modules/repo.invariants.md) | repo invariants | 11 | 6 | 0 | 10 | 18.8 |
| [scripts](modules/scripts.md) | scripts | 32 | 12 | 2 | 10 | 93.0 |
| [server](modules/server.md) | server | 93 | 35 | 12 | 14 | 205.5 |
| [templates.release-gate](modules/templates.release-gate.md) | templates/release-gate | 5 | 3 | 1 | 2 | 8.0 |
| **Total** | 34 inventories | 1866 | 669 | 206 | | |

## Suggested jobs

There are 13 groups, each about a day of one builder's work, in order of risk. Run them in this order. Groups 1–4 hold the shapes and rules everything else rests on, so let each merge before the next starts. After that, groups that touch different modules can run side by side.

| # | Group | Inventories | Why here |
|---|---|---|---|
| 1 | Job state | core.job, core.os | Every other module reads and writes jobs through it; leases and locks. |
| 2 | Config | core.config, core.format, core | Validation and defaults every command loads. |
| 3 | Pipeline | engine.pipeline | `forge job step` and the gates; the kept transition table stays beside it. |
| 4 | Server | server | The dashboard's API and SSE, and the security posture around them. |
| 5 | Pull requests and GitHub | engine.pr, integrations.github, integrations.git | Writes to GitHub; fork refusal and PR sync. |
| 6 | Office | office, office.session, integrations.claude, integrations.docker | The pool, sessions, liveness and hand-offs. |
| 7 | Guard and environment | engine.guard, engine.environment | Secrets, redaction, protected paths, backing services. |
| 8 | Workspace and project | engine.workspace, engine.project | Worktrees, verify, multi-repo jobs. |
| 9 | Release and ops | engine.release, engine.ops, templates.release-gate | Interim releases, doctor, retention. |
| 10 | Evals and metrics | engine.evals, engine.metrics, engine.trackers, integrations.backlog | Retros, scoring, stats, trackers. |
| 11 | Command layer | cli.commands | Routing, exit codes and JSON for every command, one spawn each. |
| 12 | Entry points | cli, api, bin.forge, hooks, scripts, repo.invariants | The start-up path, hooks, dev and release scripts. |
| 13 | Dashboard | dashboard.lib, dashboard.ui | Plain-TS helpers and rune state; no rendering. |
