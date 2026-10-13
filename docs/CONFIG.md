# `.forge/config.yml`

`/forge init` writes this file. Every key is optional; anything omitted takes the default shown. The file uses a strict YAML subset (block maps and lists, quoted or plain scalars, `[a, b]` / `{a: 1}` flow collections, `|` blocks, comments; no anchors or tags). `forge config validate` checks it, and `forge config show` prints the effective config.

Command templates may use `{port}`, `{job}`, `{worktree}`, `{root}`, `{branch}` and `{base}`. Commands also get `PORT`, `FORGE_PORT`, `FORGE_JOB` and `FORGE_WORKTREE` in their environment.

```yaml
schemaVersion: 2

project:
  name: null                 # display name
  description: null
  kinds: []                  # free-form tags (web-ui, rust, embedded, …); help pick lenses
  instructions: [AGENTS.md, CLAUDE.md]   # files every agent reads first, if present
  notes: null                # one-paragraph context every agent should know

git:
  base: main                 # PR target / integration branch
  remote: origin
  branchPrefix: forge/     # job branches are <prefix><job-id>

worktrees:
  root: ../{repo}.worktrees  # outside the repo on purpose (bundlers, watchers, cargo workspaces)
  copy: []                   # untracked files/dirs copied from the main checkout, e.g. [CLAUDE.md, .env, "packages/*/CLAUDE.md"]
  setup: []                  # commands run once in a new worktree, e.g. ["yarn install --frozen-lockfile"]
  cleanup: on-merge          # on-merge | manual
  cargo:
    sharedTarget: false      # one Cargo target dir for every job worktree
    targetDir: null          # null → <worktrees.root>/.cargo-target · "main" → <repo>/target · or a path

commands:                    # what `forge run <job> <name>` executes inside the worktree
  setup: null
  build: null
  test: null
  lint: null
  format: null
  typecheck: null
  dev: null                  # e.g. "yarn dev --port {port}"
  e2e: null                  # browser/e2e suite; `forge run <job> e2e`, and verify runs it per verifyE2e below
verify: [build, lint, test]  # the deterministic gate before review, in order; unset commands are skipped
verifyE2e:                   # after every verify step passes, also run commands.e2e (nothing runs when it is unset,
                             # and nothing extra when e2e is already listed in verify)
  when: ui                   # ui: only when the job's diff touches `paths` · always · never
  paths: ["*.html", "*.css", "*.scss", "*.sass", "*.less", "*.svelte", "*.vue", "*.jsx", "*.tsx", "*.astro"]
                             # `forge job scope` matching: exact path, `dir/` prefix, * ** ? globs; a slash-free
                             # glob also matches the basename. A list here replaces the default.
verifyIntegrity: warn        # warn | block: block fails verify on deleted test files or added skip/focus markers
ports: { base: 4100, span: 100 }

runtime:
  provider: anthropic        # informational; the roster is provider-neutral markdown
  host: claude-code
  maxParallelJobs: 3
  diversity: false           # warn when the approver or a lens shares the builder's model family (never blocks)
  models:                    # per role; aliases (opus, sonnet, haiku, fable) or full model ids
    orchestrator: inherit
    planner: opus
    spec-writer: opus
    designer: sonnet
    builder: opus
    reviewer: sonnet         # default for lenses without their own model
    approver: opus
    integrator: sonnet
    retro: opus
    judge: opus

tracker:
  kind: local                # local | github | none | <name of .forge/trackers/<name>.mjs>
  local:
    path: .forge/backlog.md
  github:
    repo: null               # owner/name; default: the gh-resolved repo of the checkout
    ready:                   # what counts as "ready" for /forge next
      labels: []             # all must match
      excludeLabels: []
      assignee: null         # e.g. "@me"
      milestone: null
      projectStatus: null    # e.g. "🔖 Todo" (needs a project; see below)
    claim:
      assign: true           # assign the issue to you when a job claims it
    comments: collaborators  # collaborators | all: whose issue comments reach agents (anyone can comment on public repos)
    statusSync: none         # none | labels | project | both
    labels:
      prefix: "forge:"     # labels mode: forge:in-progress, forge:review, …
    project:
      config: .github/project-config.yml   # read owner/number/status field from here when present
      owner: null            # or set explicitly
      number: null
      statusField: Status
      statusMap: {}          # Forge status → option name; unset keys are matched by meaning
                             # keys: queued, in-progress, review, blocked, done, cancelled

pipeline:
  plan: auto                 # auto | always | never
  specApproval: always       # always | large | never
  design: none               # none | reference | mockup
  maxRounds: 3               # build→review rounds before asking a human
  budget:                    # per-job limits; null = unlimited. Over budget → waiting on "budget"
    tokens: null             # job.usage.totalTokens
    usd: null                # estimated cost (job.usage.estCostUsd)
    minutes: null            # agent minutes: summed agent run time, never human waits
    changedLines: null       # committed lines added + deleted vs the base branch
    verifyRetries: 2         # failed `forge verify` runs allowed per round beyond the first
                             # `forge job budget <id> --ack` grants one more full budget past the
                             # current use; `--set key=value` overrides a limit for one job

review:
  blockOn: [blocker, major]  # severities that force another round
  panel:                     # lenses: built-in names or .forge/reviewers/<name>.md
    - { name: code, always: true }
    - { name: tests, always: true }
    - { name: security, model: opus, when: "input handling, auth, secrets, network, dependencies, file or process access" }
  #   - { name: realtime, checklist: .forge/reviewers/realtime.md, when: "audio thread code" }
  onPrFeedback: changed      # changed | full | none (which lenses re-run after PR feedback)

approver:
  alwaysEscalate:            # plain-language classes the approver must escalate
    - changes to CI/CD, deploy, release or infrastructure config
    - database or data migrations
    - new or upgraded dependencies
    - public API or protocol breaking changes
    - anything touching credentials, auth or permissions

pr:
  enabled: true
  draft: false
  closeIssue: true           # add "Closes #n" for GitHub-tracked jobs
  labels: []
  reviewers: []              # GitHub handles/teams to request
  conflicts: ask             # ask | fix | defer
  updateStrategy: merge      # merge | rebase (for branches with an open PR; before a PR: rebase)

merge:
  auto: false                # let Forge merge approved PRs (waits for CI, even without branch protection; see README)
  method: squash             # squash | merge | rebase
  autoWhen: []               # plain-language conditions, e.g. ["docs-only changes", "test-only changes"]

aiAttribution: forbid        # forbid | allow: whether commits, PRs, issues and comments may credit an AI (see README)

resources: []                # what agents should know exists, e.g.
#  - { name: App designs, kind: figma, url: "https://www.figma.com/design/…", use: "source of truth for UI" }
#  - { name: API docs, kind: docs, path: docs/api.md }

services: []                 # monorepos / multi-service repos
#  - { name: api, path: services/api, commands: { test: "go test ./...", dev: "go run . -port {port}" }, owners: ["@team-api"] }

infra:
  mode: human                # human | plan-only | agent
  allowed: []                # commands agents may run under plan-only/agent, e.g. ["terraform plan", "kubectl get"]
  notes: null

usage:
  track: true
  pricing: {}                # overrides for lib/pricing.json: { models: { <id>: {input, output, cacheRead, cacheWrite} }, aliases: {…} }

improve:
  retroEvery: 10             # suggest a retro after this many finished jobs
  maxLearnings: 30           # cap on .forge/notes/learnings.md entries

evals:
  testPattern: null          # regex for test files: mining PRs into eval tasks, and verify's integrity report (null: a built-in default)

dashboard:
  port: 7400

daemon:                      # opt-in headless orchestrator supervised by `forge dash` (see "Daemon" below)
  enabled: false             # true: `forge dash` starts it, and POST /api/daemon may start it again after a stop
  command: claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir {pluginRoot} {session} --permission-mode dontAsk --allowedTools {allowedTools}
  allowedTools: [Agent, Skill, Read, Glob, Grep, Edit, Write, "Bash(forge:*)", "Bash(git:*)", "Bash(gh:*)"]
  maxConcurrent: 1           # supervised sessions; only 1 is accepted for now
  idleStopMinutes: 30        # stop an idle session after this long (null: never); new work resumes it
```

## Model profiles

`/forge init` offers three presets for `runtime.models`. The defaults above are not a preset; they predate them.

| Profile | Models |
|---|---|
| Balanced (recommended) | planner, spec-writer, builder, retro, judge `opus`; approver `sonnet`; designer, reviewer, integrator `sonnet`; security lens `opus` |
| Economy | builder and approver `sonnet`; everything else `haiku`, except the security lens `sonnet` |
| Max quality | everything `opus`; spec-writer and builder `fable` if available |

Any profile can add `runtime.diversity: true`. Expect warnings by design where a profile shares families: the Balanced security lens is `opus` like the builder, and Economy and Max quality put the builder and approver on one family. `forge roster` always reports `diversity.overlap`: the approver and every panel lens whose model shares the builder's family (`opus`, `sonnet`, `haiku` or `fable` when the model names one, else the whole model string; `inherit` resolves through `runtime.models.orchestrator`). With `diversity: true`, `forge roster` and `forge init write` also return one warning per overlap. Diversity warns; it never blocks a job.

## Verify integrity

Every `forge verify` on a clean worktree also reports what the committed diff since the merge-base with the base branch did to the tests, in an `## integrity` section of `verify/round-N.md` and a compact `integrity` key in its JSON. Test files are paths matching `evals.testPattern`; when that is null, the built-in default (`DEFAULT_TEST_PATTERN` in `lib/integrity.mjs`) matches files under `test/`, `tests/`, `__tests__/`, `spec/` or `specs/`, `*.test.*`/`*.spec.*` (also `-test`, `_spec`, …), `*_test.go|py|rs` and `test_*.py`. The base is `refs/remotes/<git.remote>/<base>`, else `refs/heads/<base>`; a full commit sha or a `refs/…` name in the job's base is used as given, and other revisions (tags, `HEAD~3`) are not accepted. Replace objects and grafts are ignored, and every diff setting the parser depends on is pinned, so repo config written from the worktree cannot change what is read.
- **Deleted test files**: test files that were deleted, renamed out of the pattern, moved where a runner glob may no longer find them (another directory, a different test suffix or extension, or a dropped `test_` prefix: `test/a.test.mjs` → `test/old/a.test.mjs`, `a.test.mjs.off`, `a.test.ts`), or replaced by a symlink or submodule.
- **Renamed test files**: same directory and suffix, new name; informational.
- **Skip/focus markers added**, matched line by line, so the list is what is covered and nothing more:
  - in any file: Rust `#[ignore]`; `pytest.mark.skip`/`skipif`/`xfail` (decorator or `pytestmark = …`), `pytest.skip(`; `@unittest.skip`/`skipIf`/`skipUnless`/`expectedFailure`, `unittest.SkipTest`.
  - in test files only: `describe`/`it`/`test`/`context`/`suite`/`t` with `.skip`/`.only`/`.todo` (also `['skip']`, and a chained `.skip(` starting a line), `.skipIf(`/`.runIf(`, `xit`/`xdescribe`/`xtest`/`xcontext`/`fit`/`fdescribe`, node:test options (`{ skip: true }`, `{ todo: 'why' }`, the `{ skip }` shorthand in a test call, alone on a line, or assigned as `= { skip }`/`= { only }`), mocha `this.skip()`, `self.skipTest(`, Go `t.Skip`/`SkipNow`/`Skipf` and `//go:build ignore` (or `// +build … ignore`) in `_test.go`, JUnit `@Disabled`/`@Ignore`.

  Binary-looking files are scanned for markers too, but not counted. A removed marker line cancels an added one only when their text matches apart from whitespace, so moving or reindenting a skip is not a finding but retitling one is.
- **Test-count delta**: declared tests in the changed test files, before and after.
- **Test, build or CI config edits**: `package.json` `scripts`/`jest`/`mocha`/`ava`, Make and just files, CI config, `Cargo.toml` dev-dependencies, test-runner config, `.gitattributes`, `.forge/config.yml`, and script files the configured `commands` run.

Under `warn` the report never changes the result; reviewers and the approver read it. Under `block`, a deleted test file or an added skip/focus marker fails verify (`failure.name: integrity`), and so does a report that cannot be computed (base not found, invalid pattern, or a base that already contains commits the job branch's reflog records as made on it). A deletion is sanctioned, listed as *named in spec* and never blocks, when a line of the spec's `## Approach` makes its exact path the object of delete, remove or drop (``- Delete `test/old.test.mjs` ``, ``- Remove the test files `a` and `b` ``); a move the runner may miss is sanctioned the same way by ``- Move `test/a.test.js` to `test/a.test.ts` `` (or rename … to/into …; a `to` ending in `/` keeps the file name). The path must end the clause: ``Remove `x` from the lint glob``, ``Drop `x` coverage of …`` or ``Remove the `x` case`` sanction nothing. A mere mention, any line with a negation (not, n't, never, keep, avoid, without, leave, cannot), a rename out of the pattern or a type change is never sanctioned. For any other legitimate skip or deletion, the human escape is `verifyIntegrity: warn`. The mode is always read from the main checkout's config, so a job that edits `.forge/config.yml` cannot switch it off.

Verify's clean check also fails, in either mode, when the files on disk can differ from HEAD without `git status` showing it: assume-unchanged flags, a skip-worktree file that is still on disk, or one missing from disk that no sparse checkout leaves out (paths outside a cone-mode sparse checkout are fine; with non-cone or malformed patterns only files that are not tests or test config may be missing), or a clean/smudge filter that changes a test or test-config file on checkout (the standard git-lfs filter is trusted; Forge's eval checkouts sparse-exclude only `.forge/evals/`). If that check itself cannot run, the report becomes an integrity error (fails `block`, printed under `warn`). In the verify JSON, `integrity` is `null` when the worktree is unclean (no report is computed) and `{ "mode", "ok", "error" }` when the report cannot be computed.

## Daemon

With `daemon.enabled: true`, `forge dash` supervises one long-lived headless orchestrator session, so requests queued from the dashboard get handled without a Claude Code window open. Whenever new pending requests appear and the session is idle, it writes the session one fixed turn, `/forge requests`, on stdin; the session claims and handles them exactly as yours would. It spends tokens unattended, under the permissions `allowedTools` grants, so it is off by default.

- **`command`** is split into argv like a shell would split words (whitespace; `'…'` literal; `"…"` with `\"` and `\\`), then run directly, with no shell: no pipes, globbing, `$VARS` or `~`. Its first word must be a bare `claude` (found on PATH) or an absolute path to `claude` outside the repo; relative paths are refused because the session runs with the repo as its working directory. This catches mistakes; it isn't a security boundary: whoever can edit this file can run code through the daemon (docs/ARCHITECTURE.md "Daemon security"), so give the `daemon` keys code-owner review. The session's PATH starts with this plugin's `bin/`, so its `forge` is the same version as `forge dash`'s. Placeholders expand after splitting, so each stays one argument even with spaces in it:
  - `{pluginRoot}`: this plugin's directory. Pass it with `--plugin-dir` so the session has the `/forge` skill and the `forge:*` agents; `--resume` doesn't restore it, so it is passed on every spawn.
  - `{session}` (required, as its own word): `--session-id <uuid>` for a new session, or `--resume <uuid>` to continue the stored one after a restart or an idle stop.
  - `{allowedTools}`: the `allowedTools` list joined with commas, as one argument.
  - Anything else in braces is left as is.
- **`allowedTools`** must include `Agent` (every role runs as a subagent), and entries can't contain commas. With `--permission-mode dontAsk`, anything not listed is refused rather than asked about, because nobody is there to answer. Bash is limited to `forge`, `git` and `gh` by default, which keeps out other programs but is not a sandbox (`git -c …` and `gh api` can still execute code or reach the network, and `Edit`/`Write` can add hooks); enable the daemon only where tracker input is trusted. Add `Bash(<cmd>:*)` for your build, test and lint commands deliberately (`/forge init` offers this). The list replaces the default as a whole, so write every entry you want.
- **`enabled`** means the daemon may run and starts with `forge dash`. `POST /api/daemon {"action":"stop"}` stops it until the next `start` or the next `forge dash`; to keep it off across restarts, set `enabled: false`.
- **`maxConcurrent`** is the number of supervised sessions, and only `1` is accepted. Jobs still run in parallel inside that session, up to `runtime.maxParallelJobs`.
- **`idleStopMinutes`**: a session with no turn in flight for this long is stopped. The daemon stays wanted, and the next request resumes the same session. `null` never stops it.
- **Budget hold.** `pipeline.budget` limits are per job, so a budget stop is pending per request: a `resume`, `rework`, `answer` or `revise-spec` request whose job is at `waiting: budget` and still over a limit sends no turn. Once you raise or acknowledge the budget (`forge job budget <id> --set … | --ack`), the next tick sends it. `approve` is never held (approving a budget-parked job is the acknowledgement), nor are `cancel` and requests without a job.
- **Migration from `dashboard.launcher`** (config `schemaVersion` 1 → 2): a non-empty launcher moves to `daemon.command` (an existing `daemon.command` wins) and `dashboard.launcher` is removed; `enabled` is never set, so upgrading never turns the daemon on. A launcher was a shell template with `{prompt}`, run once per request; `forge config validate` and `forge doctor` reject a `{prompt}` command until you rewrite it in the form above (usually: take the default `command` and add your flags), because the daemon sends its turn on stdin and never through a shell. A launcher that ran some other agent CLI cannot be migrated: the daemon supervises only Claude Code's stream-json mode. The migration happens in memory on every read; `forge migrate` writes it to disk.

Files (gitignored, under `.forge/runtime/`): `daemon.json` (session id, pids), `daemon.log` (every stdout event plus `forge-daemon`/`forge-stderr` lines; rotated to `daemon.log.1` past 20 MiB). docs/ARCHITECTURE.md "Daemon" covers the lifecycle and "Daemon security" the threat model.

## Repo-layer files

| Path | Purpose |
|---|---|
| `.forge/notes/learnings.md` | lessons every agent reads; keep short |
| `.forge/notes/<role>.md` | addendum for one role (`builder.md`, `spec-writer.md`, …) |
| `.forge/notes/experiments.md` | the retro's ledger of changes and their metrics |
| `.forge/reviewers/<lens>.md` | a repo checklist; overrides the built-in lens of the same name |
| `.forge/trackers/<name>.mjs` | a custom tracker adapter (see TRACKERS.md) |
| `.forge/evals/<task>/` | eval tasks (see IMPROVEMENT.md); `evals/runs/` holds results |
