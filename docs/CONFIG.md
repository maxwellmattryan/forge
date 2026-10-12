# `.forge/config.yml`

`/forge init` writes this file. Every key is optional; anything omitted takes the default shown. The file uses a strict YAML subset (block maps and lists, quoted or plain scalars, `[a, b]` / `{a: 1}` flow collections, `|` blocks, comments; no anchors or tags). `forge config validate` checks it, and `forge config show` prints the effective config.

Command templates may use `{port}`, `{job}`, `{worktree}`, `{root}`, `{branch}` and `{base}`. Commands also get `PORT`, `FORGE_PORT`, `FORGE_JOB` and `FORGE_WORKTREE` in their environment.

```yaml
schemaVersion: 1

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
  launcher: null             # opt-in shell template to start a headless orchestrator for dashboard requests, e.g. 'claude -p "{prompt}"'
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

Every `forge verify` on a clean worktree also reports what the committed diff since the merge-base with the base branch did to the tests, in an `## integrity` section of `verify/round-N.md` and a compact `integrity` key in its JSON. Test files are paths matching `evals.testPattern`; when that is null, the built-in default (`DEFAULT_TEST_PATTERN` in `lib/integrity.mjs`) matches files under `test/`, `tests/`, `__tests__/`, `spec/` or `specs/`, `*.test.*`/`*.spec.*` (also `-test`, `_spec`, …), `*_test.go|py|rs` and `test_*.py`. The base is `refs/remotes/<git.remote>/<base>`, else `refs/heads/<base>`; tags and `git replace` objects are ignored.
- **Deleted test files**: test files that were deleted, renamed out of the pattern, renamed to a different test suffix (`a.test.mjs` → `a.test.mjs.off`), or replaced by a symlink or submodule.
- **Renamed test files**: still inside the pattern; informational.
- **Skip/focus markers added**: `.skip`/`.only`/`.todo`, `xit`/`fit`, node:test `{ skip: true }`, `t.Skip`, `@Disabled`, `#[ignore]`, pytest and unittest skips. Moving an existing marker is not a finding.
- **Test-count delta**: declared tests in the changed test files, before and after.
- **Test, build or CI config edits**: `package.json` `scripts`/`jest`/`mocha`/`ava`, Make and just files, CI config, `Cargo.toml` dev-dependencies, test-runner config, `.gitattributes`, `.forge/config.yml`, and script files the configured `commands` run.

Under `warn` the report never changes the result; reviewers and the approver read it. Under `block`, a deleted test file or an added skip/focus marker fails verify (`failure.name: integrity`), and so does a report that cannot be computed (base not found, invalid pattern, or a base that already contains commits made on the job branch). A plain deletion is sanctioned, listed as *named in spec* and never blocks, when a line of the spec's `## Approach` names its exact path and says delete, remove or drop (for example ``- Delete `test/old.test.mjs`: superseded``); a mere mention, a negated line, a rename or a type change is never sanctioned. For any other legitimate skip or deletion, the human escape is `verifyIntegrity: warn`. The mode is always read from the main checkout's config, so a job that edits `.forge/config.yml` cannot switch it off.

In the verify JSON, `integrity` is `null` when the worktree is dirty (no report is computed) and `{ "mode", "ok", "error" }` when the report cannot be computed.

## Repo-layer files

| Path | Purpose |
|---|---|
| `.forge/notes/learnings.md` | lessons every agent reads; keep short |
| `.forge/notes/<role>.md` | addendum for one role (`builder.md`, `spec-writer.md`, …) |
| `.forge/notes/experiments.md` | the retro's ledger of changes and their metrics |
| `.forge/reviewers/<lens>.md` | a repo checklist; overrides the built-in lens of the same name |
| `.forge/trackers/<name>.mjs` | a custom tracker adapter (see TRACKERS.md) |
| `.forge/evals/<task>/` | eval tasks (see IMPROVEMENT.md); `evals/runs/` holds results |
