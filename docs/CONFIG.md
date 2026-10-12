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
  e2e: null
verify: [build, lint, test]  # the deterministic gate before review, in order; unset commands are skipped
ports: { base: 4100, span: 100 }

runtime:
  provider: anthropic        # informational; the roster is provider-neutral markdown
  host: claude-code
  maxParallelJobs: 3
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
  auto: false                # let Forge merge approved PRs
  method: squash             # squash | merge | rebase
  autoWhen: []               # plain-language conditions, e.g. ["docs-only changes", "test-only changes"]

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
  testPattern: null          # regex for test files when mining PRs into eval tasks

dashboard:
  port: 7400
  launcher: null             # opt-in shell template to start a headless orchestrator for dashboard requests, e.g. 'claude -p "{prompt}"'
```

## Repo-layer files

| Path | Purpose |
|---|---|
| `.forge/notes/learnings.md` | lessons every agent reads; keep short |
| `.forge/notes/<role>.md` | addendum for one role (`builder.md`, `spec-writer.md`, …) |
| `.forge/notes/experiments.md` | the retro's ledger of changes and their metrics |
| `.forge/reviewers/<lens>.md` | a repo checklist; overrides the built-in lens of the same name |
| `.forge/trackers/<name>.mjs` | a custom tracker adapter (see TRACKERS.md) |
| `.forge/evals/<task>/` | eval tasks (see IMPROVEMENT.md); `evals/runs/` holds results |
