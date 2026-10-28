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
- `test/fixtures/scenarios/` holds the dashboard scenarios, one JSON file each, which `npm run scenario`, `npm run dev -- --scenario` and the render check seed ([Dashboard scenarios and the render check](#dashboard-scenarios-and-the-render-check)). `test/fixtures/render-broken/` is the broken build the render check's own test runs against.

## Allowed source-text tests
A test may read source, Svelte, CSS or Markdown text only to hold one of these invariants. Any other source-text test is a `minor` finding for the `tests` lens.

Entries 1-4 and 7 live in one file, `test/invariants/dashboard-invariants.test.ts`. Every entry's test lives in `test/invariants/`.

1. `{@html}` takes only the escape-first helpers, and the markup has no other HTML or URL sink: "{@html} receives only escape-first builders", "the {@html} guard rejects anything but one whole builder call", "no raw HTML sinks in dashboard sources", "mockups render only in the sandboxed /raw iframe", "dynamic URLs go through safeUrl" and "the URL guard rejects shorthand, spreads and unchecked src/action/formaction/xlink:href".
2. Every i18n key the dashboard uses exists in `dashboard/src/messages/en/`, and components carry no hard-coded user-facing text: "the catalog merge rejects a top-level key in two files", "the en catalog is strings and plural objects, and every message is used", "components carry no hard-coded user-facing text" and "the text guard catches what it should".
3. The dashboard loads no remote assets: "dist loads nothing from another origin".
4. Theme-token colours keep text at 4.5:1 contrast: "text tokens meet 4.5:1 except the documented exceptions", "plates, chrome and sheen keep text at 4.5:1" and "chip tones meet 4.5:1 on bg, panel and chrome".
5. The CI and release workflows stay secure: `test/invariants/ci-workflow.test.ts`, `test/invariants/release-workflow.test.ts` and `test/invariants/main-update-workflow.test.ts`, through the shared `test/invariants/workflow-lint.ts` (actions pinned to a SHA, least `permissions`, no persisted checkout credentials, a credential only in the `env` or `with` of the step that uses it, no expression in a `run:` script, no `github.event` read by any step, no fork trigger, no dependency cache). Each test also holds which refs reach its workflow: release only from a push to `main` after `verify` and `build`, with a write job that runs only `gh`, and the main-update build only from `release/v*` branches. `test/invariants/ci-workflow.test.ts` also holds that CI runs the AGENTS.md verify list in order and that the runtime audit blocks.
6. Docs stay in sync with code: `test/invariants/cli-contract.test.ts` › "Common commands table is generated from the help tables" (`npm run docs:commands`), `test/invariants/generated-docs.test.ts` › "generated docs are what npm run docs writes" (docs/CONFIG.md and docs/CLI.md against their generators), "every config key is documented beside its default" (`defaults()` against the doc strings in `lib/core/config/keys/docs.ts`) and "field schema is an allowlist over documented keys" (`lib/core/config/fields.ts` against `defaults()` and those doc strings), `test/invariants/version.test.ts` › "deprecated config keys" (docs/CONFIG.md against the deprecated-key registry), `test/invariants/docs-glossary.test.ts` › "config keys exist or are marked planned", `test/invariants/findings.test.ts` › "builder prompt example parses" (the `Findings addressed` format `agents/builder.md` teaches is the one `parseAddressed` reads), `test/invariants/governance.test.ts` (relative links and anchors resolve in README, the governance docs, every `*.md` under `docs/`, `skills/forge/`, `agents/` and `reviewers/`, the root and `dashboard/` AGENTS.md and every `lib/**/AGENTS.md`; the PR template mirrors the verify list, CODEOWNERS names files that exist, issue forms are what GitHub accepts, no AI attribution lines), and `test/invariants/docs-map.test.ts` (each `lib/` folder map is what `npm run docs:map` writes, and every `lib/` source, not `*.test.ts`, opens with the header comment it reads).
7. Segments, nav links and icon-only buttons stay accessible: "segments and nav expose their selected state", "every icon-only button has a tooltip and a label" and "the icon-button sweep finds a planted button without a tooltip". Tests can't render a `.svelte` component, so only its markup can hold this.
8. The engine compiles strict and erasable-only: `test/invariants/engine-ts.test.ts` › "engine tsconfig is strict and erasable-only" reads `tsconfig.json`'s `strict` and `erasableSyntaxOnly`. No public function exposes the compiler flags.
9. Agents that read untrusted text keep their tool limits: `test/invariants/agent-tools.test.ts` › "assistant agent has no Bash", "drafter agent has no Bash or web tools", "reviewer agent has no Edit" and "triage agent runs on haiku without a config key" read the `tools` and `disallowedTools` frontmatter of `agents/assistant.md`, `agents/drafter.md`, `agents/reviewer.md` and `agents/triage.md`, which Claude Code enforces and no Forge function reads (a role run's argv adds no tool flags, so one agent's children share one tool list and a cacheable prompt prefix).
10. `lib/` keeps its layers: `test/invariants/layers.test.ts` reads the import declarations of `lib/` sources (directions by layer, no runtime cycle, no Node imports in `api`), and that cross-layer imports in `lib/`, `test/` and `dashboard/src/` use the `package.json` aliases (it reads `package.json` `imports` and the tsconfigs' `paths`), that a unit file beside its module keeps its folder's layer and reaches outside `lib/` only for `test/helpers.ts`, and that runtime code (`lib/`, `bin/`) never imports dashboard sources; no public function exposes the module graph.
11. Files stay small: `test/invariants/file-size.test.ts` counts the lines of `lib/` sources (not `*.test.ts`) against the 600-line cap and its shrinking allowlist, and of every `*.test.ts` under `test/`, `lib/` and `dashboard/src/` against an 800-line cap with no allowlist.
12. `lib/` folders follow the layout rules: `test/invariants/layout.test.ts` lists `lib/` folder and file names, counting source files only, not `*.test.ts` (no `index` files, no stutter, 3–12 entries with the registries, `integrations/<system>/` and its shrinking `SMALL` list apart, and an `AGENTS.md` map in `lib/`, each layer folder and each module folder) and reads no file text; no public function exposes the tree's shape.
13. The release notes count every version list: `test/invariants/version-lists.test.ts` › "the release notes count every version list" reads this repo's list files (`lib/core/versions/*.ts`, `lib/api/versions.ts`) through `versionsAt` in `scripts/release.ts` and compares the result with the engine's version constants. A past tag's lists can only be read as text, so the release script counts entry lines, and only the real files can show that the count matches what the engine computes.
14. Header comments stay wrapped: `test/invariants/docs-map.test.ts` › "header comment lines stay within 160 columns" reads the header comment of every `.ts`, `.mjs` and `.svelte` source under `lib/` and `dashboard/src/` (not `*.test.ts`): a run of `//` lines or one `/* … */` or `<!-- … -->` block, after an optional shebang and an opening `<script>` line. Line width is a property of the source text alone, no public function exposes it, and reviewers raised it in three jobs.

A new entry needs a reason a public function or the CLI's JSON can't hold the invariant, and lands in this list in the same change.

## Dashboard scenarios and the render check
A **scenario** is a named dashboard state, `test/fixtures/scenarios/<name>.json`, that `scripts/scenario.ts` seeds into a fresh scratch repo in a few seconds. The repo (`repo/`) and its worktrees sibling (`repo.worktrees/`) sit inside one private `forge-scenario-*` directory under the temp dir, so no other local user can plant the sibling first. The **render check**, `scripts/render-check.ts`, loads every view of every scenario, and the machine's own pages, in headless Chrome. Neither is part of `npm test` or its four kind scripts: the render check needs Chrome and a dashboard build, and CI's `render` job runs it ([CI.md](CI.md#the-other-jobs)).

- `npm run scenario -- <name>` seeds one, prints its path as the only stdout line, logs `seeded <name> in <ms> ms` on stderr and waits; SIGINT, SIGTERM or SIGHUP removes that directory and exits 0. `--list` prints `<name>  <description>` per scenario. An unknown name, a malformed file or bad arguments exit 2; a failed seed step removes it and exits 1, naming the step, its argv and both exit codes.
- `npm run dev -- --scenario <name> [--port N]` seeds it before Vite starts and serves it; stopping dev removes it.
- Cleanup also runs on a normal exit and an uncaught error. Only SIGKILL leaves a `forge-scenario-*` directory behind.

**The format.** Keys outside these are refused at every level.

```json
{
  "description": "Every human gate, one job each",
  "config": { "commands": { "test": "echo 'expected 3, got 2' >&2; exit 1" } },
  "jobs": [
    {
      "key": "spec",
      "title": "Approve the widget spec",
      "new": ["--kind", "bug"],
      "files": { "spec.md": "# Widget\n" },
      "steps": [
        ["job", "set", "{id}", "--stage", "spec", "--state", "waiting", "--waiting-on", "spec-approval", "--reason", "spec ready"],
        { "argv": ["verify", "{id}"], "exit": 1 }
      ]
    }
  ],
  "expect": {
    "pipeline": ["Approve the widget spec", "Spec approval"],
    "project": ["@project.empty"], "issues": ["@issues.empty"], "agents": ["@agents.noRunning"],
    "analytics": ["@analytics.noUsage"], "evals": ["@evals.empty"],
    "drawer": { "job": "spec", "text": ["Spec approval"] }
  }
}
```

- **Seeding** writes Forge state only through `bin/forge`: `forge init write`, then `forge job new --title <title> --slug <key>` per job (ids read `<key>-xxxx`), then each job's `files`, then each job's `steps`, in file order. It never writes `job.json`, `events.jsonl`, `.forge/runtime/` or `.forge/locks/`. Every child gets `FORGE_ROOT=<scratch>` and none of the caller's git location or `FORGE_DAEMON*`, `FORGE_PORT*`, `FORGE_ENDPOINT*`, `FORGE_BACKING*`, `FORGE_JOB*`, `FORGE_WORKTREE*`, `FORGE_ACTOR*`, `FORGE_NOTIFY*`, `FORGE_MODE` or `FORGE_HOME` variables. `FORGE_HOME` is pinned to `forge-home` in the seed's private scratch parent, so the machine index is never yours, and `FORGE_ACTOR` is pinned to `scenario`, so a step that logs a human event never asks `gh` who you are.
- **`config`** is the partial config `forge init write --answers` merges, limited to `project`, `commands`, `verify`, `runtime`, `pipeline`, `review`, `components`, `budget` and `usage`. The seeder forces `tracker: none` (or `local`, with a `backlog`), the daemon and Foreman off and worktrees in the `../{repo}.worktrees` sibling with no setup, so no scenario reaches GitHub, a webhook, the daemon or another repo. `project.name` defaults to `Scenario: <name>`.
- **Names**: a scenario name and a job `key` match `^[a-z0-9][a-z0-9-]*$`, and keys are unique.
- **`new`**: extra `forge job new` flags, never `--title`, `--slug`, `--session` or `--body-file`.
- **Steps**: a `string[]` that must exit 0, or `{ "argv": [...], "exit": N }`. `argv[0]` is `job`, `worktree`, `verify` or `requests`, and of `job` only the subcommands that read or write one job's own state (`show`, `get`, `list`, `set`, `effort`, `claim`, `release`, `note`, `human`, `agent`, `round`, `budget`, `verdicts`, `decision`, `score`), so a step never starts a server, a session or a release: `job advance` (which runs `pr`, `run` and `eval` actions) and `job from-ref` / `job link` (which reach a tracker) are refused. A step never passes `--json` (the seeder appends it).
- **`backlog`** (optional): the text of `.forge/backlog.md`, a non-empty string of at most 64 KiB, written after every step (so a step's tracker mirror can't rewrite it) with each `{id:<key>}` filled in. A scenario with one gets `tracker: local`, a file in the scratch repo, so it still reaches no tracker service. Its items' refs are their titles' slugs (`Add the export command` is `add-the-export-command`), which a job's `new` names with `--issue <ref> --tracker local`.
- **Placeholders**: `{id}` is the step's own job and `{id:<key>}` another one; inside `new`, only a job listed earlier; inside `backlog`, any job, and never `{id}`.
- **`files`**: job-dir-relative paths (`spec.md`, `review/round-1/code.md`) of agent artifacts, never `job.json` or `events.jsonl`.
- **`expect`**: each view in `VIEWS` (`dashboard/src/lib/nav.ts`) lists the texts it must show. A text starting with `@` is a key into the English catalog in `dashboard/src/messages/en/` (merged as the app does), which resolves to that message up to its first `{`; a plural message is refused. Use job titles and gate labels as literals and empty-state copy as `@` keys, so copy edits don't break scenarios. `drawer` is optional: the job (the first by default) whose drawer the check opens from the Pipeline, and texts beside its title, which is always expected. It needs a job. `issue` is optional and needs a `backlog`: a non-empty list of `{ "title": "<an Issues row's title>", "text": [...] }`, one issue panel each, whose texts resolve `@` keys as the views' do.

**Adding a scenario** is adding a file: no code changes. Seed it with `npm run scenario -- <name>`, look at each view with `npm run dev -- --scenario <name>`, fill `expect` from what the views show, then run `npm run test:render -- --scenario <name>`.

**The render check.** `npm run test:render [-- --scenario NAME]... [--dist DIR]` checks every scenario, or only the named ones, against the build in DIR (`dashboard/dist` by default; run `npm run build:dashboard` first). It seeds the repo's own `empty` scenario once per run as the **companion**, whatever scenario directory it reads. Per scenario it seeds, registers three projects in the scenario's own `forge-home` (the scenario's repo under its default name `repo`, the companion as `other-project`, and a directory that doesn't exist as `gone-project`), serves them in-process on a free loopback port (daemon off), loads each view as a fresh page at `/#/p/repo/<view>` and opens the drawer from `/#/p/repo/pipeline` when the scenario has jobs. For each `expect.issue` entry, the `issue` check clicks that title in `/#/p/repo/issues`, expects the title and the entry's texts in the drawer, then presses Escape and expects the drawer hidden. Then it runs four machine checks: `overview` (`/`) and `machine` (`/#/machine`) expect all three names in the page's content, `switch` picks `other-project` in the sidebar's project switcher on `/#/p/repo/issues` and expects `/#/p/other-project/issues` with the companion's Issues texts, and `add` chooses **Add project** in that switcher on `/#/p/repo/issues`, expects the Add project dialog with the hash unchanged and the switcher's text not reading "Add project", closes it with Escape (the hash still unchanged), opens it again, expects a relative directory (`src/app`) to be refused under its field, then enters the companion's directory and expects the dialog to close on `/#/p/other-project/project`. A view, the drawer, an issue panel or a machine check fails on a console `error`, an uncaught page error, a same-origin response of 500 or more, an expected text not visible within 10 s, or a failed load.

- **Output**: `ok   <scenario> › <view>  <ms> ms` per passing view or check on stdout, `FAIL <scenario> › <view>: <problem>` per problem on stderr, and a last stdout line `render check: <passed>/<total> views passed in <n> scenarios (<s> s)`.
- **Exit codes**: 0 when every view passed; 1 on any problem, a DIR without `manifest.json` or a Chrome that won't start (neither ever passes or skips); 2 on usage or an unknown scenario.
- **Chrome**: `FORGE_RENDER_CHROME` (a Chrome or Chromium executable) when set, else the installed Google Chrome. Nothing downloads a browser; `playwright-core` is a devDependency only `scripts/` and `test/` import.
- **`FORGE_REQUIRE_BROWSER=1`** makes the render check's own test (`test/integration/scripts/render-check.test.ts`) fail instead of skipping when Chrome can't launch; CI's verify job sets it.
- A console error the check finds is fixed in `dashboard/src`, never ignored.

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
