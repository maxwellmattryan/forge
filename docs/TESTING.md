# Testing

> **Rewrite in progress.** The suite was torn down to a keep list and is being rewritten from per-module behaviour inventories: see [docs/test-rewrite/README.md](test-rewrite/README.md). Until the rewrite finishes, the Coverage rule below (no file drops more than 1 point) is suspended; a rewrite job compares its module against `docs/test-rewrite/baseline/coverage.txt` instead.

A job adds a test per new behaviour, not per acceptance criterion. Extend the nearest existing test or table first, and add a test file only for a new module. A test checks lasting behaviour through a module's public functions or the CLI's JSON. It never checks one job's output, the wording of prompts or docs, markup or class names, or that a removed thing is gone. Several acceptance criteria may share one proof, and an existing test, a command or a manual step is a proof too. Never delete, skip or weaken a test to get green.

## Layout
A module has one unit file beside it and one integration (or e2e) file per entry point, so there is one place to find and extend each behaviour. `npm test` runs `test/**/*.test.ts`, `lib/**/*.test.ts` and `dashboard/src/**/*.test.ts`; each kind also has its own script, and together the four run exactly what `npm test` runs.

- **One `<module>.test.ts` beside the module** for its unit behaviour (`lib/engine/pr/adopt.test.ts` beside `adopt.ts`).
- **`test/integration/` and `test/e2e/` only for entry points and cross-layer flows.**
- **One test per behaviour**, with its edge cases as rows of a table inside it.
- **In-process first**: at most one spawned-CLI test per command.
- **No tests of wording, markup, class names or one job's acceptance criteria.**

| Folder | What goes there | Script |
|---|---|---|
| `lib/**/<module>.test.ts`, `dashboard/src/**/<module>.test.ts` | **Unit**: one module's functions called in-process, with fakes injected, beside the module it tests. It imports its own module relatively, lower layers through their aliases, and test helpers only through `test/helpers.ts` (`test/invariants/layers.test.ts` holds this). The engine and dashboard tsconfigs exclude these files; `test/tsconfig.json` type-checks them. | `npm run test:unit` |
| `test/` | **Kept tables**: the migration tables (`schema.test.ts`, `*-schema.test.ts`) and the pipeline transition table (`step.test.ts`, `step-tables.test.ts`, `step-rows.ts`, `step-fixture.ts`), plus shared fixture modules (`*-fixture.ts`). No new unit files go here. | `npm run test:unit` |
| `test/integration/<entry>/` | **Integration**: one entry point with outside systems faked. The entries are `cli` (spawns `bin/forge`), `server` (HTTP against `lib/server/start.ts`), `pool` (`createPool`/`createSession` with a stub `claude`), and the code outside `lib/`: `scripts` (`scripts/*.ts`), `hooks` (`hooks/`) and `release-gate` (`templates/release-gate/`). | `npm run test:integration` |
| `test/e2e/<flow>/` | **E2E**: a scratch-repo flow across layers, such as `release` or `pipeline`. | `npm run test:e2e` |
| `test/invariants/` | **Invariants**: rules about the repository itself, not behaviour, each on the Allowed source-text tests list. | `npm run test:invariants` |
| `test/support/` | **Support**: the shared helpers, `forgeSync` and `BIN` (`cli.ts`), `forgeInProcess` (`in-process.ts`), `fakeBin` (`fake-bin.ts`), `fakeGh` (`fake-gh.ts`), `memoryGitHub` and `ghPr` (`memory-github.ts`), the in-memory `GitHub` adapter, and `fakeClaude` (`claude-adapter.ts`), the daemon's claude children driven by `ClaudeEvent`s; and the job-state builders `jobAt`, `parkedAt`, `withRound` and `withLease` (`job-state.ts`), with their table test `job-state.test.ts` beside them. | `npm run test:unit` (the builders' test) |

- Tests import support helpers only through `test/helpers.ts`, which re-exports them. Its import side effects pin git config, `SHELL`, `FORGE_MODE` and `NODE_OPTIONS` for every spawn.
- Start the CLI with `forgeAsync` or `forgeSync`, never with a `bin/forge` path of your own. In-process PR code (`lib/engine/pr/`) takes its GitHub as a parameter: pass `memoryGitHub`, which needs no `PATH` change, so its tests can run in `describe(…, { concurrency: 4 })`. A spawned CLI can't take an adapter, so fake `gh` there with `fakeGh` in the child's env (or `test/job-repos-fixture.ts`'s `prProject` for its stateful per-repo fake), and any other tool with `fakeBin`.
- Check each case of a validation, refusal or formatting table in-process, through the domain function or `forgeInProcess` (which runs the CLI's router, `dispatch`, without a process), and keep one spawned-CLI test per command for its routing, exit code and JSON. A `forgeInProcess` call with `env` changes `process.env`, so it never runs inside `describe(…, { concurrency })`.
- Build scratch repos from one `repoTemplate` per distinct init, not with `tempRepo()` plus `forge init write` in every test.
- Build a job in a given state with `jobAt`, `parkedAt`, `withRound` and `withLease`, never a hand-copied `createJob` + `setJob` block or a raw `job.json` write. They write through the store and make no move, so a test that needs a gate request or another move effect moves the job itself (`moveJob` or the CLI).
- No test file is over 800 lines: split a growing one by behaviour.
- Put an assertion at the cheapest layer that proves it: a pure check belongs in the unit file, unless it sits in a test that still needs its server or CLI.
- A unit file beside its module imports `test/helpers.ts` by its relative path (`../../../test/helpers.ts` from `lib/<layer>/<module>/`) and builds `import.meta.dirname` paths for that depth.
- A file under `test/integration/` or `test/e2e/` imports lib layers through their aliases (`#core/…`), `lib/cli/` and `lib/server/` as `../../../lib/…`, and `../../helpers.ts`, and builds `import.meta.dirname` paths for that depth.

## Allowed source-text tests
A test may read source, Svelte, CSS or Markdown text only to hold one of these invariants. Any other source-text test is a `minor` finding for the `tests` lens.

Entries 1-4 and 7 live in one file, `test/invariants/dashboard-invariants.test.ts`. Every entry's test lives in `test/invariants/`.

1. `{@html}` takes only the escape-first helpers, and the markup has no other HTML or URL sink: "{@html} receives only escape-first builders", "the {@html} guard rejects anything but one whole builder call", "no raw HTML sinks in dashboard sources", "mockups render only in the sandboxed /raw iframe", "dynamic URLs go through safeUrl" and "the URL guard rejects shorthand, spreads and unchecked src/action/formaction/xlink:href".
2. Every i18n key the dashboard uses exists in `dashboard/src/messages/en/`, and components carry no hard-coded user-facing text: "the catalog merge rejects a top-level key in two files", "the en catalog is strings and plural objects, and every message is used", "components carry no hard-coded user-facing text" and "the text guard catches what it should".
3. The dashboard loads no remote assets: "dist loads nothing from another origin".
4. Theme-token colours keep text at 4.5:1 contrast: "text tokens meet 4.5:1 except the documented exceptions", "plates, chrome and sheen keep text at 4.5:1" and "chip tones meet 4.5:1 on bg, panel and chrome".
5. The CI and release workflows stay secure: `test/invariants/ci-workflow.test.ts`, `test/invariants/release-workflow.test.ts` and `test/invariants/main-update-workflow.test.ts`, through the shared `test/invariants/workflow-lint.ts` (actions pinned to a SHA, least `permissions`, no persisted checkout credentials, a credential only in the `env` or `with` of the step that uses it, no expression in a `run:` script, no fork trigger, no dependency cache). Each test also holds which refs reach its workflow: release only from a push to `main` after `verify`, the main-update build only from `develop`. `test/invariants/ci-workflow.test.ts` also holds that CI runs the AGENTS.md verify list in order and that the runtime audit blocks.
6. Docs stay in sync with code: `test/invariants/cli-contract.test.ts` › "README CLI table is generated from the help tables" (`npm run docs:commands`), `test/invariants/generated-docs.test.ts` › "generated docs are what npm run docs writes" (README, docs/CONFIG.md and docs/CLI.md against their generators), "every config key is documented beside its default" (`defaults()` against the doc strings in `lib/core/config/keys/docs.ts`) and "field schema is an allowlist over documented keys" (`lib/core/config/fields.ts` against `defaults()` and those doc strings), `test/invariants/version.test.ts` › "deprecated config keys" (docs/CONFIG.md against the deprecated-key registry), `test/invariants/docs-glossary.test.ts` › "config keys exist or are marked planned", `test/invariants/findings.test.ts` › "builder prompt example parses" (the `Findings addressed` format `agents/builder.md` teaches is the one `parseAddressed` reads), `test/invariants/governance.test.ts` (relative links and anchors resolve in README, the governance docs, every `*.md` under `docs/`, `skills/forge/`, `agents/` and `reviewers/`, the root and `dashboard/` AGENTS.md and every `lib/**/AGENTS.md`; the PR template mirrors the verify list, CODEOWNERS names files that exist, issue forms are what GitHub accepts, no AI attribution lines), and `test/invariants/docs-map.test.ts` (each `lib/` folder map is what `npm run docs:map` writes, and every `lib/` source, not `*.test.ts`, opens with the header comment it reads).
7. Segments, nav links and icon-only buttons stay accessible: "segments and nav expose their selected state", "every icon-only button has a tooltip and a label" and "the icon-button sweep finds a planted button without a tooltip". Tests can't render a `.svelte` component, so only its markup can hold this.
8. The engine compiles strict and erasable-only: `test/invariants/engine-ts.test.ts` › "engine tsconfig is strict and erasable-only" reads `tsconfig.json`'s `strict` and `erasableSyntaxOnly`. No public function exposes the compiler flags.
9. Agents that read untrusted text keep their tool limits: `test/invariants/agent-tools.test.ts` › "assistant agent has no Bash" and "triage agent runs on haiku without a config key" read the `disallowedTools` frontmatter of `agents/assistant.md` and `agents/triage.md`, which Claude Code enforces and no Forge function reads.
10. `lib/` keeps its layers: `test/invariants/layers.test.ts` reads the import declarations of `lib/` sources (directions by layer, no runtime cycle, no Node imports in `api`), and that cross-layer imports in `lib/`, `test/` and `dashboard/src/` use the `package.json` aliases (it reads `package.json` `imports` and the tsconfigs' `paths`), that a unit file beside its module keeps its folder's layer and reaches outside `lib/` only for `test/helpers.ts`, and that runtime code (`lib/`, `bin/`) never imports dashboard sources; no public function exposes the module graph.
11. Files stay small: `test/invariants/file-size.test.ts` counts the lines of `lib/` sources (not `*.test.ts`) against the 600-line cap and its shrinking allowlist, and of every `*.test.ts` under `test/`, `lib/` and `dashboard/src/` against an 800-line cap with no allowlist.
12. `lib/` folders follow the layout rules: `test/invariants/layout.test.ts` lists `lib/` folder and file names, counting source files only, not `*.test.ts` (no `index` files, no stutter, 3–12 entries with the registries, `integrations/<system>/` and its shrinking `SMALL` list apart, and an `AGENTS.md` map in `lib/`, each layer folder and each module folder) and reads no file text; no public function exposes the tree's shape.
13. The release notes count every version list: `test/invariants/version-lists.test.ts` › "the release notes count every version list" reads this repo's list files (`lib/core/versions/*.ts`, `lib/api/versions.ts`) through `versionsAt` in `scripts/release.ts` and compares the result with the engine's version constants. A past tag's lists can only be read as text, so the release script counts entry lines, and only the real files can show that the count matches what the engine computes.
14. Header comments stay wrapped: `test/invariants/docs-map.test.ts` › "header comment lines stay within 160 columns" reads the header comment of every `.ts`, `.mjs` and `.svelte` source under `lib/` and `dashboard/src/` (not `*.test.ts`): a run of `//` lines or one `/* … */` or `<!-- … -->` block, after an optional shebang and an opening `<script>` line. Line width is a property of the source text alone, no public function exposes it, and reviewers raised it in three jobs.

A new entry needs a reason a public function or the CLI's JSON can't hold the invariant, and lands in this list in the same change.

## Coverage
`npm run coverage` runs the whole suite under Node's built-in coverage and writes one line per `lib/` and `dashboard/src/lib/` source file (not `*.test.ts`) (path, line %, lines hit/found) and a total to `node_modules/.cache/forge/coverage.txt`. Its exit status is the test run's. A change that deletes or rewrites tests runs it before and after: no file's line coverage may drop more than 1 percentage point. Where one does, add a small test of that file's public function in the nearest existing test file. Code reached only through a spawned `bin/forge` may count low; the rule compares the same tool before and after, so that cancels out.

**Timing.** `npm run test:times` runs the whole suite and prints each file's time (the sum of its top-level tests), slowest first, then the file count and the wall time. Use it to find the files worth speeding up, and record the machine's load average beside any number you compare.

## Measuring
To see whether the rule holds, compare a window of job merges on `develop` with the baseline in the PR that added this file. Run from a checkout of `develop`; set `BASE` to the commit the window starts after.

```bash
# The jobs: first-parent merges whose subject ends in (#<n>), without release commits ("Release 0.18.7 …").
# This takes the next 10 after BASE. For the last 30, drop --reverse and "$BASE".. and use head -30.
git log --first-parent --reverse --format='%H %s' "$BASE"..develop \
  | grep -E '\(#[0-9]+\)$' | grep -vE '^[0-9a-f]+ Release v?[0-9]+\.[0-9]+\.[0-9]+' | head -10 > jobs.txt

while read -r sha _; do
  added=$(git show --format= -U0 "$sha" -- '*.test.ts' | grep -cE '^\+\s*(test|it)\(')
  edited=$(git show --format= --name-status "$sha" -- test/ | grep -c '^M')
  echo "$sha $added $edited"
done < jobs.txt
```

- **Tests added per job**: the second column; report its mean and median.
- **Existing test files edited per job**: the third column; mean and median.
- **Builder minutes per job**: for each job whose dir in `.forge/jobs/` still exists (`job.json` › `pr.number` matches the subject's `#<n>`), sum the time from each `agent-start` to the next `agent-end` with `role: builder` in its `events.jsonl`. Report the median and how many jobs were measured: done jobs are pruned, so coverage is partial.
- **`tests` lens findings per reviewed job**: count the severity-tagged findings in `.forge/jobs/<job>/review/round-*/tests.md`. Report how many jobs had a `tests` lens; a panel without one gives no coverage.

Check `forge stats --json` first and use any field that already reports one of these.
