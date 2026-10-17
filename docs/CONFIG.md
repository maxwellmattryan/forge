# `.forge/config.yml`

`/forge init` writes this file. Every key is optional; anything omitted takes the default shown. The file uses a strict YAML subset (block maps and lists, quoted or plain scalars, `[a, b]` / `{a: 1}` flow collections, `|` blocks, comments; no anchors or tags). `forge config validate` checks it, `forge config show` prints the effective config, `forge config get <key>` prints one effective value, and `forge config set <key> <value>` changes one editable key (see [Changing settings](#changing-settings)).

Command templates are POSIX `sh`: each runs as `$SHELL -lc <cmd>` (`/bin/sh` when `$SHELL` is unset), and on native Windows under Git for Windows' `sh` (Git Bash; the first `sh.exe` on PATH, else `%ProgramFiles%\Git\bin\sh.exe`), or is refused with an error when there is none (see [SUPPORT.md](SUPPORT.md)). Command templates may use `{port}`, `{job}`, `{worktree}`, `{root}`, `{branch}`, `{base}` and `{args}`. `{args}` holds the extra arguments of `forge run <job> <name> -- <args…>`, each already in single quotes, and arguments go only where a template has it: `forge run` refuses arguments for a template without `{args}`, so a command takes none unless you opt in. Write `{args}` unquoted, as a whole word: after the start, a space, a tab, a newline or `(`, and before the end, a space, a tab, a newline, `;`, `&`, `|` or `)`. Arguments for a template where it sits inside `'…'` or `"…"` or touches another word (`x{args}`, `\{args}`) are refused, and so are arguments for any template containing a heredoc (`<<`), `$'` or `\'`, where the quoting would not hold. The arguments become words of whatever command surrounds `{args}`, so `exec {args}`, `env {args}` or `time {args}` runs the first one as a program. An argument containing a quote, backslash or control character is refused too. Every refusal comes before anything runs. Only `forge run` has arguments: `forge verify`, worktree setup, `forge run --background`, `forge integrate`'s rebuild and `forge eval grade` fill `{args}` with nothing. The other placeholders are filled in unquoted, so `{job}`, `{branch}` and `{base}` are checked first: each must start with a letter or digit and use only `A-Z a-z 0-9 . _ / -` (at most 200 characters), and an unsafe value stops the command before it runs, with an error naming the field. `{worktree}` is filled only with the path Forge computes for the job, `<worktrees.root>/<job id>`: a command whose template uses it stops before it runs when the job's stored `worktree` is anything else, for the same reason. Commands that don't use `{worktree}` are not affected. Commands also get `PORT`, `FORGE_PORT`, `FORGE_JOB` and `FORGE_WORKTREE` in their environment, and never the daemon session's `FORGE_DAEMON*` variables, so a command that calls `forge` behaves the same under the daemon as for a human.

```yaml
schemaVersion: 13

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
  generated: []              # committed paths/globs a command regenerates, e.g. ["dashboard/dist/**"]; matched
                             # like verifyE2e.paths. When they conflict, forge integrate takes the base side,
                             # runs generatedBy, stages the output and finishes the merge or rebase itself
  generatedBy: build         # the commands.* entry that regenerates them. It runs mid-merge or mid-rebase, so it
                             # must not fail just because the output differs from git (a `git status` check would)

commands:                    # what `forge run <job> <name>` executes inside the worktree
  setup: null
  build: null
  test: null
  lint: null
  format: null
  typecheck: null
  dev: null                  # e.g. "yarn dev --port {port}"
  e2e: null                  # browser/e2e suite; `forge run <job> e2e`, and verify runs it per verifyE2e below
verify: [build, lint, test]  # the deterministic gate before review, in order; unset commands are skipped. A list
                             # entry such as [lint, test] is a group whose steps run at the same time ("Verify groups")
verifyE2e:                   # after every verify step passes, also run commands.e2e (nothing runs when it is unset,
                             # and nothing extra when e2e is already listed in verify)
  when: ui                   # ui: only when the job's diff touches `paths` · always · never
  paths: ["*.html", "*.css", "*.scss", "*.sass", "*.less", "*.svelte", "*.vue", "*.jsx", "*.tsx", "*.astro"]
                             # `forge job scope` matching: exact path, `dir/` prefix, * ** ? globs; a slash-free
                             # glob also matches the basename. A list here replaces the default.
verifyIntegrity: warn        # warn | block: block fails verify on deleted test files or added skip/focus markers
verifySecrets: block         # block | warn: block fails verify, and refuses commits and pr open, on a likely
                             # credential ("Secret scanning"); warn only reports it. Text Forge sends is always refused
ports: { base: 4100, span: 100 }

runtime:
  provider: anthropic        # informational; the roster is provider-neutral markdown
  host: claude-code
  maxParallelJobs: 3
  diversity: false           # warn when the approver or a lens shares the builder's model family (never blocks)
  effort: null               # low | medium | high | xhigh | max: the default reasoning effort for jobs (null: Claude Code's own setting); see "Effort"
  efforts:                   # per role; null falls through to effortByComplexity, then effort
    planner: null
    spec-writer: null
    designer: null
    builder: null
    reviewer: null           # default for lenses without their own effort
    approver: null
    integrator: null
    retro: null
    judge: null
    assistant: null          # the foreman's gate assistant
  effortByComplexity: { low: null, medium: null, high: null }   # by the spec's Complexity: header, for roles without their own
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
    verifier: haiku          # answers the repo's .forge/verifiers/ yes/no checks (docs/VERIFIERS.md)
    assistant: sonnet        # the foreman's gate assistant (see "Foreman")

tracker:
  kind: local                # local | github | none | <name of .forge/trackers/<name>.mjs or .ts>
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
  plan: auto                 # auto | always | never (auto: a planner when the request is over 600 characters or has 3+ list or heading lines)
  split: ask                 # ask | auto | never (what a SPLIT plan does; see "Split gate" below)
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
  blockOn: [blocker, major]  # severities that force another round; blocker and major are required, minor and nit optional
  panel:                     # lenses: built-in names or .forge/reviewers/<name>.md
    - { name: code, always: true }
    - { name: tests, always: true }
    - { name: security, model: opus, when: "input handling, auth, secrets, network, dependencies, file or process access" }
  #   - { name: security, model: opus, when: "…", paths: [lib/server.ts, "lib/trackers/**", package.json] }
  #                          # paths: globs matched against the branch diff each round (see "How step reads the pipeline keys")
  #   - { name: security, model: opus, effort: high }   # optional per-lens effort (see "Effort")
  #   - { name: design, when: "user-visible UI changes" }
  #   - { name: realtime, checklist: .forge/reviewers/realtime.md, when: "audio thread code" }
  #   needsApp: true|false     # start commands.dev before the round and give this lens the URL;
                             # defaults to true for ui, ux, accessibility and design
  onPrFeedback: changed      # changed | full | none (which lenses re-run after PR feedback; changed = the always: true lenses)

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
  conflicts: ask             # ask | fix | defer (see "Open PRs")
  updateStrategy: merge      # merge | rebase: how forge integrate brings a branch up to date with its base
  integrationReview: code-only  # always | code-only: skip the integration review when only docs or generated files conflicted

merge:
  auto: false                # let Forge merge approved PRs (waits for CI, even without branch protection; see README)
  method: squash             # squash | merge | rebase
  autoWhen: []               # plain-language conditions, e.g. ["docs-only changes", "test-only changes"]

aiAttribution: forbid        # forbid | allow: whether commits, PRs, issues and comments may credit an AI (see README)

release:
  interim: local             # canary | git-ref | local | sequential: what a consumer's PR points at while this (root) repo's change is unmerged (see Interim strategies)

resources: []                # what agents should know exists, e.g.
#  - { name: App designs, kind: figma, url: "https://www.figma.com/design/…", use: "source of truth for UI" }
#  - { name: API docs, kind: docs, path: docs/api.md }

components: []               # the parts of a monorepo (see Components), e.g.
#  - { name: proto, path: crates/proto, kind: library }
#  - { name: api, path: services/api, kind: service, commands: { test: "go test ./...", dev: "go run . -port {port}" },
#      dependsOn: [{ component: proto, type: build }, { backing: postgres, type: runtime }], owners: ["@team-api"] }

repos: []                    # member repos of the project; the root repo is implicit (see Repos), e.g.
#  - { name: ui-kit, remote: "git@github.com:acme/ui-kit.git", defaultBranch: main }

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

evals:                       # a run's variant is an overlay, never an edit here (see "Eval overlays" below)
  testPattern: null          # regex for test files: mining PRs into eval tasks, and verify's integrity report (null: a built-in default)

dashboard:
  port: 7400

daemon:                      # opt-in headless sessions supervised by `forge dash`: an inbox plus one per job (see "Daemon" below)
  enabled: false             # true: `forge dash` starts it, and POST /api/daemon may start it again after a stop
  command: claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir {pluginRoot} {session} --permission-mode default --allowedTools {allowedTools}
  allowedTools:              # refused if it names blanket git/gh (see "Daemon" below)
    [Agent, Skill, Read, Glob, Grep, Edit, Write, "Bash(forge:*)",
     "Bash(git rev-parse:*)", "Bash(git merge --abort:*)", "Bash(git rebase --abort:*)",
     "Bash(gh pr view:*)", "Bash(gh pr list:*)", "Bash(gh pr checks:*)", "Bash(gh run view:*)"]
  maxConcurrent: 3           # job sessions at once (1-16), besides the inbox
  idleStopMinutes: 30        # stop an idle session after this long (null: never); new work resumes it
  auth: subscription         # what sessions run on: your Claude login, or api-key for an ANTHROPIC_API_KEY in forge dash's shell

foreman:                     # opt-in: an office daemon session decides gates through assistant sub-agents (see "Foreman" below)
  enabled: false             # true (with daemon.enabled): parked gates become `gate` requests for the `_office` session
  decides: [spec-approval, split-approval, escalation, rounds-exhausted, conflicts, pr-feedback]
                             # the gate classes it may decide; a class left out stays a plain human gate
  reserved: [credential, credentials, secret, secrets, token, tokens, password, auth, authentication, authorization,
             oauth, permission, permissions, security, CI, CI/CD, workflow, workflows, GitHub Actions,
             payment, payments, PII, crypto, cryptography, encryption]
                             # whole-phrase, case-insensitive: a match keeps the gate with a human
  ship: propose              # propose | merge: merge counts as merge.auto for PRs the approver marks eligible

policy:                      # enforced by the CLI, not a prompt (see "Protected paths" below)
  protectedPaths:            # [] turns it off; a config without `policy` gets these
    - { paths: [.github/workflows/**, .gitlab-ci.yml, Jenkinsfile, .circleci/**], action: escalate, reason: CI/CD configuration }
    - { paths: [Dockerfile*, "**/*.tf"], action: escalate, reason: infrastructure }
    - { paths: ["**/migrations/**"], action: escalate, reason: database migrations }
    - { paths: [package-lock.json, yarn.lock, pnpm-lock.yaml, Cargo.lock], action: escalate, reason: dependency lockfile }
    - { paths: ["**/.env*"], action: escalate, reason: environment files can hold credentials }
    - { paths: ["**/*.pem"], action: refuse, reason: private keys and certificates are never committed by Forge }
    - { paths: [.forge/config.yml, .forge/secrets-allow.txt, .forge/trackers/**, .forge/ci/**], action: refuse, reason: "Forge's own policy changes only by a human on the base branch" }

retention:                   # what Forge deletes and when; null keeps forever (see "Retention" below)
  jobsDays: null             # 1-3650: forge sync and forge dash archive finished jobs this many days old
  logsDays: null             # 1-3650: ...and delete daemon session logs this old whose session isn't running
  logMaxBytes: null          # 1048576-1073741824: rotate a session log to <scope>.log.1 as soon as it reaches this size

notify:                      # push notifications on gates, PRs, failures and budget stops (see "Notifications" below)
  webhooks: []               # each: { url: https://…, events: [gate, pr-opened, …] (omitted = all), format: json | slack }
  command: null              # e.g. ./scripts/page.sh {event} {job} {title} {url}; placeholders read env vars, never values

budget:                      # repo-wide spend caps per UTC day and month; null = unlimited (see "Repo budget" below)
  usdPerDay: null            # estimated USD across every job per UTC day
  usdPerMonth: null          # estimated USD across every job per UTC month
  tokensPerMonth: null       # total tokens across every job per UTC month
  onExceeded: hold           # hold: park and refuse new work at the cap · warn: report it only
```

## Changing settings

`forge config get <dotted.key>` prints the effective value (defaults merged with the file): strings raw, everything else as JSON, and `null` for a path that doesn't exist. `forge config set <dotted.key> <value>` changes exactly that key in the main checkout's `.forge/config.yml` and prints `{"ok":true,"key":…,"value":…,"previous":…,"changed":true}`. Only that value's line changes (or, for a missing key, one line is inserted as the last child of its section), so comments, blank lines and key order survive. Setting a key to its current value writes nothing and replies `"changed":false`. The dashboard's Settings modal saves through the same code (`POST /api/config`).

**Values** follow the key's type: `true`/`false`; a decimal number; `null` for keys that allow it; text as written; and lists as `[a, b]` or a JSON array (`'["a","b"]'`, `[]`). Values are checked against the key's range or options, text may not contain control or invisible formatting characters (bidi overrides, zero-width characters) or exceed 200 characters, `review.blockOn` must keep both `blocker` and `major` (adding `minor` or `nit` is allowed), `daemon.idleStopMinutes` must be greater than 0 (or `null`), and `tracker.github.labels.prefix` must be at least 2 characters ending in `:`, `/` or `-`, because Forge removes every issue label that starts with it. The result must also pass `forge config validate`, though problems the file already had never block an unrelated change.

**Editable keys**: `pipeline.plan`, `split`, `specApproval`, `design`, `maxRounds` and every `pipeline.budget.*`; `review.blockOn` and `review.onPrFeedback`; `pr.integrationReview`; `runtime.models.<role>`, `runtime.maxParallelJobs`, `runtime.diversity`, `runtime.effort`, `runtime.efforts.<role>` and `runtime.effortByComplexity.*` (the assistant's model and effort included); `tracker.github.ready.*`, `tracker.github.claim.assign`, `tracker.github.statusSync` and `tracker.github.labels.prefix`; `dashboard.port` (used by the next `forge dash`); `daemon.idleStopMinutes` and `daemon.auth`; `retention.logMaxBytes`; and `budget.usdPerDay`, `budget.usdPerMonth`, `budget.tokensPerMonth` and `budget.onExceeded`. The rule: a key is editable only when it can't name a command, file, module, tool or repository Forge runs, loads or writes to, and can't loosen a security or attribution policy. Everything else (`commands.*`, `worktrees.*`, `verify*`, `git.*`, `merge.*`, `approver.*`, `aiAttribution`, `infra.*`, `review.panel`, `tracker.kind`, `tracker.github.repo`/`comments`/`project.*`, `daemon.enabled`/`command`/`allowedTools`/`maxConcurrent`, `foreman.*`, `retention.jobsDays`/`logsDays` (they delete files), `notify.webhooks` (names a URL Forge posts to), `notify.command` (runs a program), …) is refused with `<key> is not editable with forge config set (<why>); edit .forge/config.yml by hand`, and the dashboard shows it read-only. `lib/config-fields.ts` is the allowlist.

**Errors** exit 1 and leave the file byte-identical: an unknown key, a read-only key, an invalid value, or a layout the edit can't change without dropping a comment (a block map or `|` block, a list of maps, a list with comments between or on its items, a key inside a flow map). A repo without `.forge/config.yml` exits 2; `/forge init` creates it.

**The daemon.** A daemon session may not run `forge config set` (like `forge init write` and `forge migrate`). All three take the same `.forge/locks/config` lock, so they never interleave. If you run it while the dashboard's daemon is running, the change stops the daemon, exactly as a hand edit does (see [Daemon](#daemon)); the dashboard refuses to save settings until you stop the daemon, and only you may start it again.

## Split gate

`pipeline.split` decides what happens when the planner proposes several jobs for one request. `ask` (the default) parks the job on `split-approval` and creates nothing until you `/forge approve` it (create the jobs) or `/forge revise` it (keep it as one job). `auto` creates the tracker sub-issues and child jobs right away, and `never` makes the planner always plan one job, noting any split it would recommend under `## External`. A job started with `/forge issue <ref>` (or a dashboard Start) always plans as `never`: you chose that boundary. `forge job from-ref` records that as the job's `splitMode: "never"`, and so does `/forge revise` on a split proposal; every other job follows `pipeline.split`.

## How step reads the pipeline keys

`forge job step` decides each move from these keys and the job's recorded state:

- **`pipeline.plan: auto`** runs the planner when the request body (`request.md` without its title) is longer than 600 characters, or has 3 or more lines that start with a list marker (`-`, `*`, `1.`) or a `#` heading. `always` always plans and `never` never does.
- **`review.panel`** is picked twice. Once the spec is written (SP3), the panel is every `always: true` lens, plus the spec's `Suggested reviewers:` that are in the panel, plus each lens whose `when` names a path (a token with a `/` or a file extension, such as `lib/server.ts` or `dashboard/src/**`) or whose `paths` cover one of the spec's Approach paths. A `when` written only in prose is left to the spec-writer's suggestion. Then, after each build round's verify and before any reviewer starts, step runs `forge job panel <id>` (RV9), which recomputes the round's lenses from the branch's committed diff since the merge-base, in panel order: (1) `always` lenses, reason `always`; (2) the spec's suggestions in the panel, `suggested`; (3) lenses whose `when` paths or `paths` cover an Approach path, `approach <path>`; (4) lenses whose `paths` match a changed file, one reason per matching glob, `paths <glob>: <first file>` plus ` (+N more)`; (5) every lens already on the job, `carried`, keeping its panel position or appended when it isn't in the panel. Carrying only adds, so a lens never drops within a job's build loop: the spec-time panel, a lens a human added with `forge job set --field reviewers=…` and a lens an earlier round's diff matched all stay, and emptying `job.reviewers` can't remove what rules 1–4 select. A retro job always gets `code` and `docs`. `job.reviewers` is rewritten only when the set changed, and every run logs a `panel` event with the lenses and their reasons. `paths` globs use the matcher of `forge job scope` and `verifyE2e.paths`: an exact path, a `dir` or `dir/` prefix, and `*`, `**` and `?`, where a glob without a `/` also matches the file name at any depth (`*.svelte` matches `a/b/c.svelte`). No negation (`!`) or braces. `forge config validate` and `forge doctor` refuse a `paths` that isn't a list, or an entry that is empty, absolute, starts with `-`, `!` or `:`, or has a `..` segment. Uncommitted changes don't count. Names that aren't plain lowercase lens names are dropped. In a job with member repos, each reviewed member adds the lenses its own clone's panel defines, as `<repo>:<name>` after the root's ("Member review panels" under Repos).
- **`review.panel[].needsApp`** says whether a lens reviews the running app. When a lens in the round needs it and `commands.dev` is set, Forge starts the dev server before the reviewers spawn and puts `Dev server: http://localhost:<port>` in that lens's brief. Absent, it defaults to `true` for `ui`, `ux`, `accessibility` and `design` and `false` for every other name; an explicit value wins for any name (`needsApp: false` keeps a `ui` lens off the app, `needsApp: true` puts a custom lens such as `visual-qa` on it). Anything but `true` or `false` is a config problem. A lens recorded on a job but no longer in the panel gets the name default.
- **`review.onPrFeedback`** picks the lenses for a rework round on an open PR: `full` re-runs the job's whole recorded panel, `none` skips review and goes straight to `forge pr open`, and `changed` (the default) re-runs the `always: true` lenses. `changed` can't look at which files the round touched, because step decides from recorded state, not the diff. Under `full`, RV9 re-runs `forge job panel` for the rework round, so the recorded panel gains any lens the diff now matches; `changed` stays always-only and `none` skips review, and both leave the panel alone.

## Open PRs

`forge sync` (and `forge pr sync <id>`) re-reads every open PR. A job parked on `pr-review` or `conflicts` whose PR has moved under it is handled by these keys:

- **`pr.conflicts`** decides a PR that conflicts with its base. `ask` (the default) waits on `conflicts` until you `/forge approve` it. `fix` has `forge sync` move the job to `integrate` itself, where the integrator resolves the conflicts, re-verifies and runs the integration review. `defer` leaves the job on `pr-review` with a note.
- **`pr.updateStrategy`** is how `forge integrate` brings a branch up to date with its base, before a PR and after one is open (`merge` by default, so nothing is force-pushed). A PR that is only behind its base needs no conflict decision, so `forge sync` moves it to `integrate` under every `pr.conflicts` policy, including the default `ask`, and `forge integrate` updates it with this strategy. `merge` resolves conflicts once per integration, never rewrites pushed commits and never force-pushes. `rebase` gives a linear history, but it replays each job commit, can raise conflicts at each one, and rewrites the branch. `--strategy` on `forge integrate` overrides it for one run.
- **`pr.integrationReview`** decides whether a conflict resolution gets the one-lens `code` integration review. `code-only` (the default) skips it, with a note on the job, when every conflicted path in the episode, and every path the resolution changed beyond git's own merge of the two sides (commits after it included, up to the verified sha), is docs (`*.md`, `docs/**`) or generated (rebuilt by `forge integrate`, or matching `worktrees.generated`); any other path, an unsafe or malformed name, or a resolution diff Forge can't compute, or a review that already ran in the episode keeps it. `always` reviews every resolution, and so does any other value. The resolution is verified either way.

Both routes have the same guards. The job is not claimed by a live session (the test `forge next` uses, judged inside the job lock), the PR head is the commit Forge pushed (a human push is left alone), and each head is routed once, so a failed integration doesn't loop. Sync never claims the job: with `daemon.enabled` it queues a `resume` for the job's session, and otherwise `forge sync` lists the job under `integrating` for `/forge continue <id>`. `forge pr merge` syncs without routing.

## Model profiles

`/forge init` offers three presets for `runtime.models`. The defaults above are not a preset; they predate them.

| Profile | Models |
|---|---|
| Balanced (recommended) | planner, spec-writer, builder, retro, judge `opus`; approver `sonnet`; designer, reviewer, integrator `sonnet`; security lens `opus` |
| Economy | builder and approver `sonnet`; everything else `haiku`, except the security lens `sonnet` |
| Max quality | everything `opus`; spec-writer and builder `fable` if available |

Any profile can add `runtime.diversity: true`. Expect warnings by design where a profile shares families: the Balanced security lens is `opus` like the builder, and Economy and Max quality put the builder and approver on one family. `forge roster` always reports `diversity.overlap`: the approver and every panel lens whose model shares the builder's family (`opus`, `sonnet`, `haiku` or `fable` when the model names one, else the whole model string; `inherit` resolves through `runtime.models.orchestrator`). With `diversity: true`, `forge roster` and `forge init write` also return one warning per overlap. Diversity warns; it never blocks a job.

## Effort

Reasoning effort is how much the model thinks before it answers: `low`, `medium`, `high`, `xhigh` or `max`. Higher levels cost more tokens and time. Forge sets it per job, per role and per spec complexity:

- **Precedence.** For an agent of role R in job J, the level is the first valid value of:

  | # | Layer | Source |
  |---|---|---|
  | 1 | J's own effort (`forge job new … --effort <level>`, `forge job effort <id> <level>`, or the drawer's **Effort** select) | `job` |
  | 2 | reviewers only: the lens's `review.panel` entry `effort` | `panel` |
  | 3 | `runtime.efforts.<role>` (`reviewer` for every lens) | `role` |
  | 4 | `runtime.effortByComplexity[<J's complexity>]` | `complexity` |
  | 5 | `runtime.effort` | `config` |
  | 6 | nothing: Forge passes no effort | `none` |

  With nothing set, `daemon.command`'s own `--effort` applies if it has one, and otherwise Claude Code's own setting does. `forge job effort <id> --inherit` clears a job's level. A value outside the five levels counts as unset at every layer and resolution falls through to the next, and `forge config validate`, `forge doctor` and every daemon start refuse an invalid `runtime.effort`. `forge config validate` and `forge doctor` also report a `runtime.efforts` or `runtime.effortByComplexity` that isn't a map, an unknown key in either, a level outside the five, and an invalid panel `effort`; those never stop a daemon start, because they never reach a session's command line.
- **Rework bump.** A builder on a rework round (`round` 2 or later) runs one level above what it resolved to (`low` → `medium` → `high` → `xhigh` → `max`; `max` stays `max`), unless the level is the job's own effort or nothing. Round 1, including a verify-fail retry inside it, is never bumped, and no other role is.
- **Complexity.** The spec writer adds a `Complexity: low | medium | high` header under `Size:`, judged as difficulty, not volume. When the spec is recorded, a valid value (any case) becomes the job's `complexity`; a spec without a valid one clears a complexity an earlier spec set. `forge job set <id> --field complexity=<low|medium|high|null>` sets it by hand and refuses anything else. It only picks among levels a human configured in `runtime.effortByComplexity`.
- **Daemon sessions** start with `--effort <level>` on their `claude -p` command line, replacing any `--effort` in `daemon.command`. A session runs the orchestrator, not a role, so only layers 1, 5 and 6 apply: per-role, panel and complexity levels never reach a session. The inbox session uses `runtime.effort`. Each session's log records the level it started with and where it came from (`job`, `config` or `none`).
- **Agents.** `forge job step` puts each spawn's own level (resolved for its role) on every `spawn` action, and every brief has an `Effort:` line, so the orchestrator, yours or a daemon's, passes it to each agent it starts. The `forge:*` agents set no effort of their own, so without one they inherit their session's.
- **Changing it.** A job's new effort applies to the agents started after the change at once, and to a running daemon session the next time it starts (after an idle stop, a restart, or a slot handover). Forge never stops a session to apply it. Changing `runtime.effort` while the daemon runs is a config change, so the trust check stops the daemon, as for any edit of this file; a job's effort lives in its `job.json` and stops nothing.
- **In the dashboard**, a job's Log tab has an **Effort** select beside Permissions (Inherit shows what it resolves to), a job whose own level differs from `runtime.effort` shows a chip such as "Extra high effort" on its card, in its drawer and on the Agents page, Settings → Agents edits `runtime.effort`, each `runtime.efforts.<role>` and each `runtime.effortByComplexity.*`, and the Agents page's roster and review panel tables show each role's and lens's level with where it comes from (panel entry, role setting or default), before any job's own effort or complexity. While a job's session runs at another level than the one now set, a note says it applies to new agents now and to the session when it restarts.
- **A daemon session may not change effort**: `forge job effort` and `forge job new --effort` refuse under `FORGE_DAEMON=1`, and `forge job set --field effort=…` is always refused. Set it from the dashboard or your own session.
- Needs a Claude Code with `--effort` (checked on 2.1.299).
- **Migration** (config `schemaVersion` 3 → 4): nothing changes. v4 adds `runtime.efforts`, `runtime.effortByComplexity` and a panel entry's `effort`, all unset by default; the bump lets older Forges refuse a config whose effort levels they would ignore. Job `schemaVersion` 9 adds `complexity` (null for older jobs).

## Verify groups

An entry in `verify` is a step name or a list of step names; the built-in `secrets` step always runs before the first entry ("Secret scanning"). A list is a group: its steps start together and run at the same time, and the next entry starts only after all of them have finished. Group steps that don't depend on each other's output, typically the checks that follow a build, in one list:

```yaml
verify:
  - build
  - [lint, typecheck, test]
```

A failing step never stops its siblings: each runs to completion and keeps its own log and `command` event, and then no later entry runs. `failure` (and `verifyRuns[].failure`) is the first failing step in config order, not the first to finish, and `verify/round-N.md` and the JSON `steps` keep one entry per step in config order. A step with no command is reported `skipped (no command configured)` in its place, and `e2e` listed anywhere, inside a group too, is not run a second time by `verifyE2e`. Steps in a group share the worktree, the job's `{port}` and the environment, so don't group steps that write the same files (a formatter or `--fix` beside a test) or bind `{port}`. A `verify` of plain step names runs one step after another, as the default `[build, lint, test]` does. `forge verify` refuses to start (exit 1, nothing recorded) when `verify` is not a list, when an entry is neither a step name nor a non-empty list of names (a nested list included), or when a step is listed twice; `forge config validate` and `forge doctor` report the same problems.

**Migration** (config `schemaVersion` 2 → 3): nothing changes, because every v2 `verify` is a valid v3 one, and `forge migrate` only rewrites the version. The bump lets Forge refuse a config it can't read: `forge verify` exits 1 on a `schemaVersion` newer than its own. A Forge older than this change can't tell, so it reads a group as one unknown step (`lint,typecheck,test`), reports it skipped and passes verify without it: update Forge everywhere verify runs before you commit a group.

## Verify integrity

Every `forge verify` on a clean worktree also reports what the committed diff since the merge-base with the base branch did to the tests, in an `## integrity` section of `verify/round-N.md` and a compact `integrity` key in its JSON. Test files are paths matching `evals.testPattern`; when that is null, the built-in default (`DEFAULT_TEST_PATTERN` in `lib/integrity.ts`) matches files under `test/`, `tests/`, `__tests__/`, `spec/` or `specs/`, `*.test.*`/`*.spec.*` (also `-test`, `_spec`, …), `*_test.go|py|rs` and `test_*.py`. The base is `refs/remotes/<git.remote>/<base>`, else `refs/heads/<base>`; a full commit sha or a `refs/…` name in the job's base is used as given, and other revisions (tags, `HEAD~3`) are not accepted. Replace objects and grafts are ignored, and every diff setting the parser depends on is pinned, so repo config written from the worktree cannot change what is read.
- **Deleted test files**: test files that were deleted, renamed out of the pattern, moved where a runner glob may no longer find them (another directory, a different test suffix or extension, or a dropped `test_` prefix: `test/a.test.mjs` → `test/old/a.test.mjs`, `a.test.mjs.off`, `a.test.ts`), or replaced by a symlink or submodule.
- **Renamed test files**: same directory and suffix, new name; informational.
- **Skip/focus markers added**, matched line by line, so the list is what is covered and nothing more:
  - in any file: Rust `#[ignore]`; `pytest.mark.skip`/`skipif`/`xfail` (decorator or `pytestmark = …`), `pytest.skip(`; `@unittest.skip`/`skipIf`/`skipUnless`/`expectedFailure`, `unittest.SkipTest`.
  - in test files only: `describe`/`it`/`test`/`context`/`suite`/`t` with `.skip`/`.only`/`.todo` (also `['skip']`, and a chained `.skip(` starting a line), `.skipIf(`/`.runIf(`, `xit`/`xdescribe`/`xtest`/`xcontext`/`fit`/`fdescribe`, node:test options (`{ skip: true }`, `{ todo: 'why' }`, the `{ skip }` shorthand in a test call, alone on a line, or assigned as `= { skip }`/`= { only }`), mocha `this.skip()`, `self.skipTest(`, Go `t.Skip`/`SkipNow`/`Skipf` and `//go:build ignore` (or `// +build … ignore`) in `_test.go`, JUnit `@Disabled`/`@Ignore`.

  Binary-looking files are scanned for markers too, but not counted. A removed marker line cancels an added one only when their text matches apart from whitespace, so moving or reindenting a skip is not a finding but retitling one is.
- **Test-count delta**: declared tests in the changed test files, before and after.
- **Test, build or CI config edits**: `package.json` `scripts`/`jest`/`mocha`/`ava`, Make and just files, CI config, `Cargo.toml` dev-dependencies, test-runner config, `.gitattributes`, `.forge/config.yml`, and script files the configured `commands` run.
- **Local link overrides committed** (rules R1–R4, see [Local links](#local-links)): an added line holding an absolute path of the root's or a member's worktrees root or of `.forge/jobs` (R1), `FETCHCONTENT_SOURCE_DIR_` (R2), a `[patch` table in a `.cargo/config` or `.cargo/config.toml` at any depth, or such a file committed as a symlink (R3), and a `package.json` dependency, override or resolution added or changed to `file:`/`link:` with an absolute path or one leaving the repo (R4). In-repo forms (`path = "crates/x"`, `file:./packages/x`) are fine. The JSON lists them as `linkOverrides` (`<path>:<line> (<rule>)`).

Under `warn` the report never changes the result; reviewers and the approver read it. Under `block`, a deleted test file, an added skip/focus marker or a committed local link override fails verify (`failure.name: integrity`), and so does a report that cannot be computed (base not found, invalid pattern, or a base that already contains commits the job branch's reflog records as made on it). A deletion is sanctioned, listed as *named in spec* and never blocks, when a line of the spec's `## Approach` makes its exact path the object of delete, remove or drop (``- Delete `test/old.test.mjs` ``, ``- Remove the test files `a` and `b` ``); a move the runner may miss is sanctioned the same way by ``- Move `test/a.test.js` to `test/a.test.ts` `` (or rename … to/into …; a `to` ending in `/` keeps the file name). The path must end the clause: ``Remove `x` from the lint glob``, ``Drop `x` coverage of …`` or ``Remove the `x` case`` sanction nothing. A mere mention, any line with a negation (not, n't, never, keep, avoid, without, leave, cannot), a rename out of the pattern or a type change is never sanctioned. For any other legitimate skip or deletion, the human escape is `verifyIntegrity: warn`. The mode is always read from the main checkout's config, so a job that edits `.forge/config.yml` cannot switch it off.

Verify's clean check also fails, in either mode, when the files on disk can differ from HEAD without `git status` showing it: assume-unchanged flags, a skip-worktree file that is still on disk, or one missing from disk that no sparse checkout leaves out (paths outside a cone-mode sparse checkout are fine; with non-cone or malformed patterns only files that are not tests or test config may be missing), or a clean/smudge filter that changes a test or test-config file on checkout (the standard git-lfs filter is trusted; Forge's eval checkouts sparse-exclude only `.forge/evals/`). If that check itself cannot run, the report becomes an integrity error (fails `block`, printed under `warn`). In the verify JSON, `integrity` is `null` when the worktree is unclean (no report is computed) and `{ "mode", "ok", "error" }` when the report cannot be computed.

## Eval overlays

`forge eval start --set <key>=<value>` (repeatable) runs one eval run under a variant of this file without writing it, so an A/B comparison needs no config edit and never trips the daemon's trust check. The keys allowed are `runtime.models.<role>` (every role but `orchestrator`, whose model no job session reads), `runtime.effort`, `runtime.efforts.<role>`, `runtime.effortByComplexity.<level>`, the `pipeline.*` settings (`plan`, `split`, `specApproval`, `design`, `maxRounds`, `budget.*`), `review.panel` (built-in or repo lens names; no `checklist` path) and `verify` (at least one step, each a key in `commands`). Every other key, `commands.*` included, is refused. Values are checked as `forge config set` checks them, and the overlaid config may add no `forge config validate` problem. The overlay is recorded on the run and on each eval job (`eval.overlay`, which `forge job set --field` can't write), checked again whenever a command loads that job, and applied only to that job's `job step`, `job advance`, `verify` and budgets. The run's `configHash` covers it; an empty overlay hashes as before. A daemon session may not pass `--set`.

## Secret scanning

Forge refuses to publish a likely credential, and the check lives in its own code (`lib/secrets.ts`), not in a prompt. The scanner has no dependencies and runs wherever Forge sends something off the machine:

| Gate | What it scans | On a finding |
|---|---|---|
| `forge verify` | a `secrets` step before the first configured group, clean worktree or not: every non-merge commit in `merge-base..HEAD` on its own (a key added and deleted later is still found), each merge commit's own changes (`git show --remerge-diff`: a conflict resolution, which no ordinary commit holds), the net diff (what a merge brought in), every commit message, and the staged changes | `block`: the step fails, no configured group runs, the integrity report is still computed. `warn`: the step passes with a reason |
| `forge git commit` | the message, before anything is staged; then the staged diff against HEAD | the message: always refused. Staged content: refused under `block` (the index stays staged), committed under `warn` with `secrets: <n>` in the result |
| `forge pr open` | the PR title and body exactly as Forge would send them, before any `gh` call or push, even when the PR exists; then the commit range (commits, messages, net diff) of the HEAD it pushes, verified or not (`--force` skips verify, and a HEAD verified by a Forge without the scanner was never scanned), after fetching the base from the remote's push URL into its remote-tracking ref | the text: always refused. The range: refused under `block`, and so is a base fetch that fails |
| tracker writes | `comment` bodies and `create` titles and bodies, in every adapter (`forge tracker comment\|create`, `forge job link --create`, `job human … --link new`, the split procedure); a custom adapter's `update`/`claim` also have the job's title and reason scanned | always refused |
| `forge job agent end` | the role's output, its extras (builder: `build.md`, `tasks.md`; integrator: `build.md`; approver: `pr.md`, `runbook.md`; designer: `mockup.html`; retro: `spec.md`) and `questions.md`, when written since the agent started and a regular file inside the job dir | never blocks: a `secret-found` event, and `secrets: <n>` in the result |

A refusal exits 1 with error code `secret_found` and a one-line message such as `possible secret in the PR body: aws-access-key at (pr body) line 3 (AKIA…XY, sha256:<64 hex>)`, plus how many more, and never calls the adapter, `gh` or `git commit`. `forge secrets scan <id>` shows what a job would publish, and `forge secrets scan --paths <globs>` scans the main checkout's tracked files (untracked files and symlinks are left out, files over 2 MiB are counted as skipped); both exit 1 on a finding.

**What counts.** Provider patterns, each a kind: `private-key` (a PEM `PRIVATE KEY` block with at least 64 base64 characters, split over lines or written with literal `\n`, reported once at its first line), `aws-access-key`, `github-token`, `github-pat`, `gitlab-token`, `slack-token`, `stripe-live-key` (test keys are not), `anthropic-key`, `openai-key` (its body has a digit), `google-api-key`, `bearer-token` (an `Authorization: Bearer` header with a token of 20+ characters) and `url-credential` (`password=`/`token=`-style query values and `scheme://user:pass@host`). An `sk-ant-` key is only ever `anthropic-key`. Then `high-entropy`: a value of 33 to 256 characters of `[A-Za-z0-9+/_=-]` inside quotes or backticks, or after `name =`. A hex value (all lower- or all upper-case) needs at least 3.0 bits of entropy per character and a secret word on its line (`secret`, `token`, `passw`, `pwd`, `api_key`, `private_key`, `credential`, `auth_token`, `access_key`, `signing_key`, …); any other value needs at least 4.3 bits and an upper-case letter, a lower-case letter and a digit. SRI hashes (`sha512-…`), UUIDs, slugs, paths, values over 256 characters and anything of 32 characters or fewer are never flagged.

**Where only provider patterns run.** Lockfiles (`package-lock.json`, `yarn.lock`, `Cargo.lock`, `go.sum`, …), `*.min.js`, `*.min.css`, `*.map`, `*.svg`, paths matching `worktrees.generated`, files whose added content holds a NUL byte, and the text Forge sends (commit messages, PR title and body, tracker text), where prose often quotes hashes and the gates refuse outright.

**Placeholders are not findings:** an env reference (`${X}`, `$X`), a `<…>` or `{{…}}` value, a value with fewer than 5 distinct characters, one containing `example`, `placeholder`, `dummy`, `redacted`, `changeme`, `xxxx`, `****`, `your_` or `your-`, and one that is exactly a stock word such as `password` or `token`.

**Masking and fingerprints.** A finding shows the first 4 and last 2 characters of a value of 16 or more (`AKIA…XY`), the first 2 of one of 8 to 15 (`hu…`), and nothing of a shorter one (`…`); a backtick, `|`, whitespace or control character in what is shown becomes `?`. The full value is never printed, logged, written to a file or put in an event. Each finding carries `fingerprint`: `sha256:` and the hex sha256 of the full value (of a PEM key, its body without whitespace). The fingerprint is not secret material and appears in output, errors, verify files and events.

**Allowlist.** `.forge/secrets-allow.txt`, read from the main checkout only: a copy in the job's worktree, or committed on its branch, is ignored, and a daemon session can't edit it (it is in the trust digest and denied to `Edit`; see ARCHITECTURE.md "Daemon security"). A branch that edits it shows up as a config edit in the integrity report. One entry per line:

```text
# Comments and blank lines are ignored; a comment takes its own line.
# A path glob (forge job scope matching) allows repository content only:
test/fixtures/**
# A fingerprint allows that value anywhere:
sha256:<64 lower-case hex>
```

A path glob never allows text: commit messages, the PR title and body, tracker text and job-dir files need the fingerprint. A malformed `sha256:` line or a `!` line is listed as a problem and ignored; a symlinked allowlist allows nothing. An allowed finding is listed with the line that allowed it (`allowedBy: .forge/secrets-allow.txt:<line>`).

**Modes.** `verifySecrets` covers content: verify's branch scan, the staged scan in `forge git commit` and the range scan in `forge pr open`. Text Forge composes and sends is refused in either mode. The mode always comes from the main checkout's config, and any value other than `warn` counts as `block`. A scan that cannot finish (base not found, a git failure, more than 1,000 commits) fails under `block` and passes with `error` under `warn`; it never reads as clean.

**The human gate.** When verify fails on `secrets` (in the verify, integrate or pr stage) and no builder or integrator has run since, or `forge pr open` was refused, `forge job step` parks the job on `waitingOn: human` with the reason `secret scan blocked verify round <n>` or `secret scan blocked pr open` (an eval job fails instead). No agent retry gets past it. A human removes the value (and rewrites the branch if it was committed; Forge never amends, rebases or force-pushes for it) or allowlists it, then `/forge approve <id>`: step runs the scan again and parks the job again if the value is still there. `/forge rework <id> <note>` sends it back to build.

**Residual risks.** A secret split across strings or lines, or encoded (base64 of a token, compressed or binary formats), is found only if the entropy check happens to catch it. An evil merge whose content a later commit deletes is not seen. The sha256 of a short `password=` value can be guessed offline from its fingerprint. A key in a UTF-16 file (NUL-interleaved text) gets only the provider patterns, which can't match it. A file the branch routes through `filter=lfs` is scanned as its pointer, while a push outside Forge uploads the real content. Verify compares against the base's remote-tracking ref as the checkout has it, which the job's worktree can move with `git update-ref`. `forge pr open` first fetches the base into that ref from the remote's push URL, the repository it then pushes to; under `block` it refuses to open the PR when that fetch fails, and under `warn` it scans against the ref as it is. So under `block` the range it pushes is scanned against the base the push target reports at that moment; a push target that lies about its own base branch is out of reach. Regex false positives happen; the allowlist handles them. Forge does not revoke or rotate a leaked credential.

## Protected paths

Paths are code, judgement calls are prose. `approver.alwaysEscalate` is prose a model reads after the build; `policy.protectedPaths` is the part that can be said as paths, and the CLI enforces it when a change is staged or committed, re-checks it over the whole branch before anything is pushed, and records each decision as a `protected-path` event. `approver.alwaysEscalate` stays as the backstop for what paths can't express.

**Rules.** Each rule is `{ paths: [glob, …], action: escalate | refuse, reason: "<text>" }`, numbered from 1 in list order. Messages name a rule as `rule <n> (<glob that matched>): <reason>`. When a path matches both actions, `refuse` wins; within one action, the first matching rule is named. The defaults are the list above. `policy.protectedPaths: []` turns the policy off. The policy is read from the main checkout's `.forge/config.yml` only, never from the job's worktree, and `.forge/config.yml` itself is a refuse default. It is read-only in the dashboard and `forge config set` (`names what Forge refuses to write`).

**Matching** is `forge job scope`'s: an exact path, a directory prefix, `**` crossing directories, `*` and `?` within one segment, and a slash-free glob or bare name matched against the basename too (`package-lock.json` matches `web/package-lock.json`). Paths and globs are lowercased first, so `.GitHub/Workflows/ci.yml` matches `.github/workflows/**`. A path counts when its content, mode or existence differs between the comparison point (the merge-base of the base with HEAD, or with `MERGE_HEAD` while a merge is in progress, so the base's own changes never count) and the result being checked. A rename counts as a delete of the old path and an add of the new one, and both are matched. A symlink or submodule also matches when its target does, or when its path is a leading directory of a rule's glob (a symlink named `.github`). A symlink whose target can't be read, or is longer than 4 KiB, is refused (`link target could not be checked`).

**Where it is enforced.**

| Gate | refuse | escalate |
|---|---|---|
| `forge git add\|commit` | previews the index the call would produce (a temp copy, removed after) and exits 1 with `protected_path`, writing nothing, when a path the call changes differs from the comparison point. Putting a path back to its comparison-point content is allowed, so a refusal verify reports stays fixable | goes ahead, records the job's flag and prints `protected: <n>` |
| `forge verify` | a `protected` step right after `secrets` fails (`failure: protected`), and no configured command runs | the step passes with `<n> protected paths need a human` and records the flag |
| `forge pr open` | exits 1 with `protected_path` before any `gh` call or push, `--force` included | recomputes the set (it never trusts the stored flag) and exits 1 with `protected_path` until a human approved it |
| `forge pr merge` | exits 1 with `protected_path` when the PR's head is not the commit `forge pr open` last checked and pushed (someone pushed since), unless a human passes `--now` | the same |

**Member repos.** A job's [member repos](ARCHITECTURE.md#job-repos) get the same rules at the same gates, each over its own branch from its own base: `forge git add|commit --repo <name>` previews the member's index, and verify's `protected` step and `forge pr open` check every non-verify-only member's branch. A member's paths are named `<repo>:<path>` in messages, events and the one job flag, and its patch sits under a `# repo <name>` line in `protected.diff`, so one human approval at PP1 covers every repo, and a refusal or a missing approval in any repo stops `pr open` before anything is pushed.

**Approval.** The flag (`job.protectedPaths`, written by the CLI only; `forge job set` refuses it) holds the escalate paths with their blob ids (up to 200, the rest counted, with a digest over all of them) and `at`, which moves only when a path or its content is new; past 200 paths, any change to the set moves it. `forge job step` parks the job on `waitingOn: human` with the reason `protected paths: <paths>` (rule PP1) in `decide`, even after an `APPROVE`, and in `pr`, and never auto-merges it (PR4). While the policy has rules, `forge pr merge` merges only the PR head `forge pr open` checked and pushed, and defers instead of queueing GitHub auto-merge. Only a human `approve` given at that park after `at` counts: a foreman decision, an approve at another gate, or one older than the last content change doesn't. The approver's brief names the paths, and `protected.diff` in the job dir holds the patch of every one of them (capped at 1 MiB). A refusal at verify or pr open sends the job back to build (PP2).

**An invalid policy fails closed:** `forge git add|commit` and `forge pr open` exit 2 with `config_invalid`, and verify's `protected` step fails. Valid means `policy` is a map, `protectedPaths` a list, each entry a map whose `paths` is a non-empty list of relative globs (no `..` segment, not starting with `-`, `!` or `:`), `action` is `escalate` or `refuse`, and `reason` is 1 to 200 characters with no newline. `forge config validate` lists each problem.

**Migration** (config `schemaVersion` 5 → 6, job `schemaVersion` 9 → 10): nothing changes on disk. A config without `policy` gets the defaults, so after upgrading, a branch that changes a lockfile parks on a human and one that changes `.forge/config.yml` is refused; write an explicit `policy:` block on the base branch to change that.

## Daemon

With `daemon.enabled: true`, `forge dash` supervises headless orchestrator sessions, so requests queued from the dashboard get handled without a Claude Code window open: one **inbox** session for requests without a job (`next`, `run`, `sync`, `retro`, `eval-run`), which only does intake and hands each new job off, and one session **per job**, started when that job has work. Whenever a session's pending requests change and it is idle, it gets one fixed turn, `/forge requests`, on stdin; the session claims and handles them exactly as yours would, seeing only its own scope's requests. Each session fails, idles and logs on its own. They spend tokens unattended, under the permissions `allowedTools` grants, so the daemon is off by default.

- **`command`** is split into argv like a shell would split words (whitespace; `'…'` literal; `"…"` with `\"` and `\\`), then run directly, with no shell: no pipes, globbing, `$VARS` or `~`. Its first word must be a bare `claude` (found on PATH) or an absolute path to `claude` outside the repo; relative paths are refused because the session runs with the repo as its working directory. This catches mistakes; it isn't a security boundary: whoever can edit this file can run code through the daemon (docs/ARCHITECTURE.md "Daemon security"), so give the `daemon` keys code-owner review. The session's PATH starts with this plugin's `bin/`, so its `forge` is the same version as `forge dash`'s. Placeholders expand after splitting, so each stays one argument even with spaces in it:
  - `{pluginRoot}`: this plugin's directory. Pass it with `--plugin-dir` so the session has the `/forge` skill and the `forge:*` agents; `--resume` doesn't restore it, so it is passed on every spawn.
  - `{session}` (required, as its own word): `--session-id <uuid>` for a new session, or `--resume <uuid>` to continue the stored one after a restart or an idle stop.
  - `{allowedTools}`: the `allowedTools` list joined with commas, as one argument.
  - Anything else in braces is left as is.
  - `--effort` in `command` is allowed, but Forge replaces it whenever a job or `runtime.effort` sets a level (see [Effort](#effort)).
- **`allowedTools`** must include `Agent` (every role runs as a subagent), and entries can't contain commas. Subagents inherit the list. A tool call it doesn't cover is sent to you: see **Permission prompts** below. The default allows Bash only for `forge` and the git/gh forms the skill and agents name: `rev-parse`, aborting a merge or rebase, and reading PRs and CI runs. Everything else goes through `forge`: staging and committing (`forge git add <job> -- <paths>` and `forge git commit <job> --message …`, which run git in the job's worktree, because the session's cwd is the main checkout, where a bare `git add`/`git commit` would land on the base branch; they take no git options and refuse paths outside the worktree), checks (`forge run`, `forge verify`, so build tools need no entry), pushes, PRs and tracker writes, history reads (`forge git diff|log|show|range-diff`, which refuses `--output`, `--ext-diff`, `--textconv` and `--open-files-in-pager` and forces external diff and textconv off, because `git log --output=.git/config` could rewrite git config), and starting and finishing a merge or rebase (`forge integrate --keep-conflicts` / `--continue`; `--continue` refuses a rebase todo with anything but picks). Validation refuses entries that reach arbitrary execution, file writes or GitHub writes on their own: unscoped `Bash`/`Bash(*)`, `git` or `gh` with no subcommand, `git -…` (`-c`), `git config|grep|submodule|bisect|difftool|mergetool|filter-branch`, `git diff|log|show|range-diff|whatchanged|format-patch` (`--output`), `git mv` (a `x/../.git/…` destination is renamed even though git reports it invalid), `git rebase` other than `--continue|--abort|--skip` (`--exec`), and `gh api|extension|alias|auth|secret|codespace`. That list catches the known forms; it is not exhaustive, so add any other `Bash(<cmd> <sub>:*)` entry deliberately. The list replaces the default as a whole, so write every entry you want. Older defaults also listed `Bash(git status|add|rm|commit:*)`; they still validate, but in a daemon session they act on the main checkout, so drop them.
- **Flags `daemon.command` may not pass**, because they widen the session past `allowedTools`: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode` other than `default` (or `manual`, the name current Claude Code lists for it), `dontAsk` or `plan` (so no `bypassPermissions`, `acceptEdits` or `auto`; a human can still put one session in `auto` from the dashboard, see **Permission mode per session** below), `--settings`, `--mcp-config`, `--add-dir`, `--permission-prompt-tool` (Forge passes its own), `--agents`, a `--plugin-dir` other than `{pluginRoot}`, and `--allowedTools`/`--allowed-tools` with anything but `{allowedTools}`. Both `--flag value` and `--flag=value` are checked. claude reads `--allowedTools` and `--plugin-dir` values variadically, so a bare word right after their value (other than `{session}`) is refused too: it would become one more tool or plugin dir.
- **Permission prompts.** Forge appends `--permission-prompt-tool stdio` to every daemon command, so a tool call outside `allowedTools` (a `cp` in a worktree, a folder outside the checkout, a compound command) reaches the supervisor instead of failing. Under the default `--permission-mode default`, the session waits while the dashboard shows the call in the status bar's Needs-you popover and in the job drawer's dock: the tool, its exact input, the agent's own description of it (untrusted text), and any path outside the session's folders. **Allow once** runs it. **Allow for this session** also adds the rules and folders Claude Code suggested, for that session only: they are never written to a settings file, and they end when the session restarts. A suggestion that would allow a tool's every call (a bare `Bash`, or a wildcard-only pattern) is dropped, so a session grant is only ever a pattern you read, such as `Bash(cp:*)`. The input shown is exactly what an allow runs, never cut short: a call whose input is over 4,000 characters is denied unasked. **Deny** returns a fixed message telling the agent not to retry or work around it. Nothing you type reaches the session; only your choice does. A prompt nobody answers waits as long as the session runs, and goes away when it stops. With `--permission-mode dontAsk`, nothing is ever asked: anything `allowedTools` doesn't list is refused, as the old default did. A session holds at most 20 prompts; more are denied unasked. Allowing a call is a real grant: read the command, and expect protected paths (`.git/`, `.claude/`) and commands prefixed with variables to show up here too, because `dontAsk` refused them outright.
- **Permission mode per session.** Each session's log (a job's Log tab, or the Inbox session log in the status bar's Daemon popover) has a **Permissions** selector: **Ask** (`default`: prompts as above), **Auto** (Claude Code's `auto` mode: its classifier approves routine calls on its own and still sends risky ones to you as prompts) and **Refuse** (`dontAsk`). It starts at `daemon.command`'s mode. A change applies at once to a running session, through Claude Code's `set_permission_mode` control request, and the log records claude's confirmation; a session that isn't running starts in it. The choice is held by `forge dash` in memory only, never in a file (a session can write files in the repo, so it could otherwise pick its own mode), so it lasts until `forge dash` stops, and the Daemon popover names the mode on the rows of the job sessions you switched. If claude refuses a switch or doesn't confirm it within 15 seconds, the log says why. A switch to a wider mode (`auto` isn't available on every account or model) falls back: the selector shows the mode the session still runs in. A switch to a narrower mode stops the session instead, and it starts in the mode you chose with its next request, so a session never keeps more reach than you picked. `bypassPermissions` and `acceptEdits` are never offered. `daemon.allowedTools`, the `.forge/config.yml` deny rules and the trust check apply in every mode. Auto approves most calls with nobody reading them, so use it on a session you are watching, and switch back to Ask when you leave. It isn't contained to that session either: a call that runs unread can reach the dashboard's own API and switch or answer for the others (docs/ARCHITECTURE.md "Daemon security").
- **Git inside the session** runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` pinned through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (appended after any you already export), plus `GIT_EDITOR=true`. That covers subagents, `forge` and your verify commands too: **no git hooks run in daemon mode**, including your pre-commit and pre-push hooks and Git LFS's pre-push upload, so repos that depend on hooks should keep those checks in `commands.*`/`verify`, and LFS repos should not push from the daemon.
- **What the session may not change.** Forge always appends `--disallowedTools Edit(.forge/config.yml),Edit(.forge/trackers/**),Edit(.forge/secrets-allow.txt),Edit(.forge/verifiers/**),Edit(.forge/runtime/spend.json),Edit(.forge/runtime/audit.jsonl)` to `command`. Every `forge` call in the session also checks that those files are the ones a human started the daemon with, and refuses if they changed (`forge init write`, `forge migrate` and `forge config set` always refuse there). If they change while the daemon runs, by the session or by you, the supervisor stops it with an error in the dashboard and never restarts it on its own: review `git diff .forge/`, then press Start, which takes a fresh snapshot. docs/ARCHITECTURE.md "Daemon security" explains the layers.
- **`enabled`** means the daemon may run and starts with `forge dash`, except `forge dash --dev` (what `npm run dev` runs), which leaves it off until you press Start. `POST /api/daemon {"action":"stop"}` stops it until the next `start` or the next `forge dash`; to keep it off across restarts, set `enabled: false`.
- **`maxConcurrent`** (an integer from 1 to 16, default 3) caps how many job sessions run at once; the inbox session is not counted. A job with work beyond the cap waits for a slot, and an idle job session gives its slot up to a waiting job (it resumes its conversation the next time it has work). A session whose job has agents running (reviewers it started in the background, say) is kept: it is never stopped for a slot, though it still counts toward the cap, so the waiting job gets the next slot that frees. So is a session for 30 s after its last turn or agent ended. Each job session drives one job, so `runtime.maxParallelJobs` (how many jobs your own interactive session runs at once) does not apply to the pool. Spend scales with the number of live sessions: set `maxConcurrent: 1` for one job session at a time. The dashboard shows this key read-only.
- **`auth`** (`subscription`, the default, or `api-key`): which credential the sessions run on. claude prefers an `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in its environment over the Claude login, and a headless session never asks, so a key exported in the shell that ran `forge dash` (often for some other tool) would quietly bill that API account, and its spend cap then fails every turn with `last turn failed: API Error: 400 … usage limits`. With `subscription`, both variables are dropped from the sessions' environment and they run on the login, like your own sessions. The first time `forge dash` starts a daemon-enabled repo from a terminal with a key set and no `auth` in this file, it asks once and writes the answer; started anywhere else (from `/forge dash`, a script), it assumes `subscription` and says so in its output. A session's log records an `auth` event whenever a key was present, with whether it was passed on; `forge doctor` reports the same.
- **`idleStopMinutes`**: a session with no turn in flight for this long is stopped. The time counts from its last turn or the last agent of its job ending, whichever is later, and a session is never idle-stopped while its job's agents run. It stays wanted, and its next request resumes the same conversation. `null` never stops it. A job session also stops once its job is done, cancelled or failed and nothing is left for it.
- **Budget hold.** `pipeline.budget` limits are per job, so a budget stop is pending per request: a `resume`, `rework`, `answer` or `revise-spec` request whose job is at `waiting: budget` and still over a limit sends no turn. Once you raise or acknowledge the budget (`forge job budget <id> --set … | --ack`), the next tick sends it. `approve` is never held (approving a budget-parked job is the acknowledgement), nor are `cancel` and requests without a job. The repo budget (`budget:`, "Repo budget" below) holds more: while it is exceeded under `hold`, every pending `resume`, `rework`, `answer`, `revise-spec` and `approve` of a job that isn't exempt waits, and the session reports `held: "repo-budget"`.
- **Migration from `dashboard.launcher`** (config `schemaVersion` 1 → 2): a non-empty launcher moves to `daemon.command` (an existing `daemon.command` wins) and `dashboard.launcher` is removed; `enabled` is never set, so upgrading never turns the daemon on. A launcher was a shell template with `{prompt}`, run once per request; `forge config validate` and `forge doctor` reject a `{prompt}` command until you rewrite it in the form above (usually: take the default `command` and add your flags), because the daemon sends its turn on stdin and never through a shell. A launcher that ran some other agent CLI cannot be migrated: the daemon supervises only Claude Code's stream-json mode. The migration happens in memory on every read; `forge migrate` writes it to disk.

Files (gitignored, under `.forge/runtime/daemons/`): `<scope>.json` (session id, the last 20 ids it replaced in `pastSessionIds`, pids, the log's base offset; `forge job claim` reads these to let a daemon owner that provably let go yield without `--force`) and `<scope>.log` (every stdout event plus `forge-daemon`/`forge-stderr` lines; rotated to `<scope>.log.1` past 20 MiB at spawn, or at `retention.logMaxBytes` as soon as it is reached; one older generation is kept, and the dashboard pages back into it), where the scope is `_inbox` or a job id. The session learns its scope only from `FORGE_DAEMON_SCOPE` in its environment. A `daemon.json` / `daemon.log` left by an older Forge is reaped and then ignored; you may delete it. `forge daemon status` lists the sessions and `forge daemon log <job>|--inbox [--lines N] [--follow]` prints one's log. docs/ARCHITECTURE.md "Daemon" covers the lifecycle and "Daemon security" the threat model.

## Retention

`.forge/jobs/` and `.forge/runtime/` only grow until something removes them. Retention is off by default: every key is `null`, which keeps everything forever. docs/ARCHITECTURE.md "Retention" covers the archive format and the threat model.

- **`retention.jobsDays`** (null, or an integer from 1 to 3650): `forge sync` and `forge dash` startup archive every eligible finished job whose `finishedAt` (else `updatedAt`) is at least this many days old. Archiving writes `.forge/archive/<id>.json` (the job.json as stored, every event, ending with an `archived` event that names the actor, and a summary) and deletes the job's folder: its agents' markdown, reviews, verify reports, logs and screenshots. A job is skipped while it is active, an eval job, owned by a live session, has a running daemon session, has an open PR, still has a worktree (`forge worktree remove <id>` first), or is named in an unfinished job's `dependsOn` or `children`. Read-only in Settings (`deletes job files`).
- **`retention.logsDays`** (null, or an integer from 1 to 3650): the same runs delete `<scope>.log` and `<scope>.log.1` under `.forge/runtime/daemons/` when the newer of the two is at least this old, the session record names no live process, and the scope is not an active job; a job scope with no job folder left loses its `<scope>.json` too. Read-only in Settings (`deletes session logs`).
- **`retention.logMaxBytes`** (null, or an integer from 1048576 (1 MiB) to 1073741824 (1 GiB)): the supervisor rotates a session log to `<scope>.log.1` as soon as it reaches this size, mid-session, replacing the older `.log.1`. Null keeps today's rule: rotate only at spawn, past 20 MiB. Editable in Settings; it takes effect at the session's next spawn.

Archived jobs leave the board, the Done filter, `forge status`, `forge job list --all` and `/api/state`, but `forge stats`, `/api/stats` (which counts them in `counts.archived`), `forge audit`, `forge job audit <id>`, `forge retro due` and the dependency check still read them. Every archived job and deleted log adds one JSON line to `.forge/runtime/retention.log`. `forge job archive <id>|--done --older-than D` and `forge job prune --older-than D [--dry-run]` do the same by hand (and are refused in daemon sessions); `forge doctor` warns when `.forge/jobs`, `.forge/archive` or `.forge/runtime` passes 500 MiB.

**Migration** (config `schemaVersion` 6 → 7): nothing changes. v7 adds `retention`, whose defaults keep everything; the bump lets older Forges refuse a config whose retention policy they would ignore. A repo upgraded from an older Forge gets `.forge/archive/.gitignore` (`*`) on its first archive, so records are never committed.

## Repo budget

`pipeline.budget` stops one job. `budget:` caps what the whole repo spends per calendar UTC day (`YYYY-MM-DD`) and month (`YYYY-MM`), so the daemon and `/forge next 3` can't start jobs without limit. Every key defaults to `null` (unlimited), and per-job budgets work exactly as before.

**Spend** is the sum of the estimated cost of every `agent-end` event with usage, across live jobs and the records in `.forge/archive/` (every kind: evals and retros included), each counted on the UTC day and month of its `ts` and re-priced with today's `lib/pricing.json`. `.forge/runtime/spend.json` caches the totals per job and is rebuilt whenever it is missing, unreadable, a symlink, or written for another cache version or pricing table.

**Exceeded.** The effective cap is `cap × (1 + acknowledgements for the period)`. A key is exceeded when spend reaches its cap (`>=`, so `0` holds everything). The reason reads `repo budget: $103.20 of $100.00 this month` (also `<n> of <cap> tokens this month` and `$… of $… today`).

**Hold** (`onExceeded: hold`, the default) is enforced by the CLI wherever a job starts:
- `forge job new` still creates the job but parks it `waiting` on `budget`, unclaimed. `--kind retro` is never parked. `--force` creates and claims it anyway and logs a `budget-override` event (refused in a daemon session).
- `forge next` starts nothing and prints `{held: true, repoBudget}`; `forge job from-ref` exits 4.
- `forge job claim` parks a job that isn't running an agent and exits 4. A job with a running agent, a live foreign owner or an existing wait is claimed (or refused) exactly as before.
- The daemon pool holds a job session's `resume`, `rework`, `answer`, `revise-spec` and `approve` requests (`held: "repo-budget"`); `cancel`, gate requests and inbox requests still run.

Retro jobs, and a job forced past the cap this month, are exempt. Under `warn` nothing is parked or refused: commands add a `repoBudget` block to their output and log a `repo-budget-warn` event.

**Release.** `forge budget ack --period <YYYY-MM|YYYY-MM-DD>` (a human only: refused in a daemon session) grants one more period's cap for the current, exceeded month or day and logs a `repo-budget-ack` line in `.forge/runtime/audit.jsonl`. The dashboard's Acknowledge button in Needs you does the same. Whenever a check finds the repo no longer held (`forge budget`, `forge next`, `forge job new|claim|from-ref`, `forge sync`, an ack, or simply a new month), every job parked by the repo budget whose own per-job budget is fine goes back to `queued` (with a `resume` request when the daemon is on). `forge job budget <id> --ack` never lifts the repo cap.

`forge budget` prints spend, caps, remaining, the projected month-end and the held jobs. `forge stats --csv [--since DATE] [--by job|role|model|day]` exports the same spend for finance.

## Notifications

Forge pushes a small, fixed-shape message to your webhooks and command when a job needs a human, a PR opens or merges, a job fails, the daemon stops on its own, a budget is exceeded or a secret is found. With `webhooks: []` and `command: null` (the defaults) it does nothing: no child process, no network, no events.

```yaml
notify:
  webhooks:
    - url: https://hooks.slack.com/services/T000/B000/XXXX
      events: [gate, pr-opened, job-failed]   # omitted = every event
      format: slack                           # json (default) | slack
  command: null                               # e.g. ./scripts/page.sh {event} {job} {title} {url}
```

- **`webhooks`**: a list of maps with `url` (required), `events` (a non-empty list; omitted subscribes to every event) and `format` (`json` or `slack`). `url` must be `https:`, without a username or password; plain `http:` is accepted only for `127.0.0.1`, `localhost` and `[::1]`, for local testing. An invalid entry is skipped by delivery and reported by `forge config validate` and `forge doctor`, named by its index and host, never its path or query. Teams, pagers and other services take the `json` format through their own webhook adapters.
- **`command`**: null, or a shell command run once per notification (with the first event) through the POSIX shell (`sh -c`) in the repo root, stdio ignored, killed after 30 s. Its `{placeholders}` (`{event}`, `{job}`, `{title}`, `{url}`, `{stage}`, `{reason}`, `{dashboardUrl}`; any other is a validation problem) are replaced by quoted references to environment variables, never by the values: `{title}` becomes `"$FORGE_NOTIFY_TITLE"`, likewise `FORGE_NOTIFY_EVENT`, `FORGE_NOTIFY_JOB`, `FORGE_NOTIFY_URL`, `FORGE_NOTIFY_STAGE`, `FORGE_NOTIFY_REASON` and `FORGE_NOTIFY_DASHBOARD_URL` (empty for null). So a title like `$(touch pwned)` reaches the script as text. Write placeholders unquoted; Forge adds the double quotes.
- Both keys are read-only in Settings and refused by `forge config set`, and `.forge/config.yml` is a protected path, so an agent cannot add a target.

**Events** (each fires once per state change; eval jobs never notify):

| Event | Fires when | Reason |
|---|---|---|
| `gate` | a job enters `waiting` on `spec-approval`, `split-approval`, `issue-link`, `input`, `escalation`, `infra`, `conflicts`, `rounds-exhausted`, `budget` or `human`, from another state or another `waitingOn` (`pr-review` and `external` are not gates) | the `waitingOn` value |
| `budget-exceeded` | the same transition with `waitingOn: budget` | `budget` |
| `job-failed` | a job enters `failed` | `failed` |
| `pr-opened` | `forge pr open` creates a new PR (not an update or adoption) | `pr-opened` |
| `pr-merged` | a job with a PR number enters `done` | `pr-merged` |
| `secret-found` | the secret scan logs a finding on a job | `secret-found` |
| `daemon-stopped` | the supervisor stops on its own: a trust change (`trust`, no job), or a session's failed turns or starts (`failed-turns`, `failed-starts`) | that code |

A budget transition carries `[budget-exceeded, gate]`: each webhook gets at most one message, the first of those it subscribes to, and the command runs once with `budget-exceeded`.

**Payload** (`format: json`), exactly these keys:

```json
{ "event": "gate", "job": "42-add-login", "title": "Add login", "stage": "spec", "reason": "Spec is waiting for approval", "url": null, "dashboardUrl": "http://127.0.0.1:7400/#/pipeline", "at": "2026-10-16T09:00:00.000Z" }
```

`reason` is a fixed English string chosen by the reason code, never the job's reason, notes, request, reviews, PR text or agent output. `title` is the job title with control characters replaced by spaces and bidi controls (U+202A–U+202E, U+2066–U+2069) removed, trimmed and cut to 200 characters (ending in `…`); it is the only free text. `url` is the job's PR URL when it has the shape of a pull or merge request, `https://<host>/<owner>/<repo>/pull/<n>` or `https://<host>/<group>/…/<project>/-/merge_requests/<n>` with no credentials, query or fragment, else null (job.json is agent-writable, so no other link reaches the channel). `job`, `title` and `stage` are null for a daemon stop with no job. `dashboardUrl` is the running dashboard's loopback URL (else `http://127.0.0.1:<dashboard.port>`) plus `/#/pipeline`.

**Payload** (`format: slack`): Block Kit with every variable string in `plain_text`, so a title cannot mention `@channel` or add links: a `header` (`<label>: <title>`, cut to 150 characters), a `section` with the reason, a `context` with `<job> · <stage> · <dashboardUrl>`, and an "Open PR" button when `url` is set. The fallback `text` is `Forge <label>: <title>` with `&`, `<` and `>` escaped. Labels: Needs you, PR opened, PR merged, Job failed, Daemon stopped, Budget exceeded, Secret found.

**Delivery** never runs in the command that changed state: it spawns a detached `forge notify send`, so a slow endpoint never stalls `forge job set`, `forge pr open` or the daemon, and a delivery failure never changes job state. A webhook gets a `POST` (`content-type: application/json`, redirects refused, 5 s timeout); a network error, timeout, 429 or 5xx is retried once after 1 s. A command's exit 0 is success and it is not retried. Each target's outcome is one event on the job (`.forge/runtime/notify.jsonl` for a daemon stop with no job): `notified { event, target, host, format, status, attempts }` or `notify-failed { event, target, host, error, status, code, attempts }`, with `error` one of `timeout`, `network`, `http`, `redirect`, `invalid`, `exit`, `spawn`. Only the webhook's host is ever recorded; no event, log line or doctor detail contains its path, query or the command text, and `/api/config` shows webhook URLs as `<scheme>//<host>/…` and a set command as `<set>`. `.forge/runtime/notify.jsonl` is appended through a descriptor that refuses a symlink or other non-regular file.

`forge notify test [--event <name>]` sends a sample (job null, title "Forge test notification") to every valid webhook regardless of its `events`, runs the command if set, prints each target's result and exits 1 when one fails or nothing is configured. `forge doctor` adds a `notify webhook <n> (<host>)` check per webhook (a best-effort `HEAD`; unreachable and plain-http entries are warnings) and a `notify command` check that never runs the command.

**Migration** (config `schemaVersion` 7 → 8): nothing changes. v8 adds `notify`, empty by default; the bump lets older Forges refuse a config whose notifications they would ignore.

## Foreman

With `foreman.enabled: true` and `daemon.enabled: true`, `forge dash` runs one more supervised session, the **office** (scope `_office`), beside the inbox. It never counts against `daemon.maxConcurrent`, and it shares the pool's trust check, deny rules, budget holds and failure handling. When `forge job set` parks a job on a gate whose class is in `decides`, the CLI queues a `gate` request; `forge pr sync` does the same for a job waiting on `pr-review` with failing checks, or with changes requested or unresolved threads from someone with write access to the repo (`pr-feedback`, once per PR head; feedback only from others stays with a human). The office session hands each one to a `forge:assistant` sub-agent (model `runtime.models.assistant`, effort `runtime.efforts.assistant`) that reads the job's files, then records the verdict with `forge job human … --actor foreman` and queues a `resume` for the job's session. It never reads a job file itself.

- **`enabled`** (default `false`): nothing changes while it is off. No `gate` request is written and no office session runs. The status bar's Foreman indicator still shows, dashed, as **Foreman off**, and its popover says how to turn it on here (the key is locked in Settings and `forge config set`).
- **`decides`**: the classes it may decide, from `spec-approval`, `split-approval`, `escalation`, `rounds-exhausted`, `conflicts` and `pr-feedback`. `input`, `issue-link`, `infra`, `budget`, `human` and `external` are never foreman gates. An unknown entry is reported by `forge config validate` / `forge doctor` and ignored at run time.
- **`reserved`**: patterns matched as whole phrases, case-insensitively, against the job's reason, the `## Why` and `## For the human` sections of `decision.md` (escalation and rounds-exhausted) and the foreman's own note. A match leaves the gate with a human, and the CLI refuses the foreman's decision even if the request said otherwise. So does a security review whose latest recorded verdict is anything but `PASS` (`CHANGES`, or `MALFORMED`), whatever the texts say. A value that isn't a list of non-empty strings fails closed: every gate stays with a human until it is fixed.
- **`ship`** (`propose` or `merge`): `merge` (with `enabled`) counts as `merge.auto: true` in the approver's brief and in step rule PR4, so a PR the approver marks `Auto-merge eligible: yes` under `merge.autoWhen` is merged, and `forge pr merge` still enforces CI. The office session itself can never run `forge pr merge`.

All four keys are read-only in the settings: edit them by hand.

- **Migration** (config `schemaVersion` 4 → 5): nothing changes. v5 adds `foreman.*` (off by default), `runtime.models.assistant` and `runtime.efforts.assistant`; the bump lets older Forges refuse a config whose foreman policy they would ignore. docs/ARCHITECTURE.md "Foreman" covers routing and the authority checks.

## Components

`components` lists the parts of a repo: libraries, services and apps, with their own commands and what they depend on. It is edited by hand (Settings shows it read-only), and `/forge init` proposes it from `forge init detect`'s `suggestions.components`. Each entry:

```yaml
components:
  - name: core                  # required, unique; letters, digits and . _ / -, starting with a letter or digit
    repo: null                  # optional; a repos name, or null / absent for this repo
    path: crates/core           # required, relative, inside the repo; "." is the repo root
    kind: library               # required: library | service | app
    commands: { test: "cargo test" }   # optional, like the top-level commands
    dependsOn:                  # optional, default []
      - { component: proto, type: build }
      - { backing: postgres, type: runtime }
      - { component: engine-core, type: build, link: { ecosystem: cargo, name: engine-core } }   # see Local links
    owners: ["@team-core"]      # optional list of strings
    notes: null                 # optional string
```

- **Selection.** A job's `services` field names the components it touches (the spec's `Services:` header fills it; step records only names that are configured components). When it names exactly one component of this repo, `forge run` and `forge verify` use that component's command, falling back to the top-level one, and run it from `<worktree>/<path>`. With none, several, an unknown name or a component whose `repo` is set, the top-level commands run from the worktree root. The verify integrity scan counts a component's script files under its path, and skips components whose `repo` is set.
- **Dependencies.** Each `dependsOn` entry names exactly one of `component` (another entry's name) or `backing` (a backing service such as a database; only its shape is checked for now), and a `type`: `build` (needed to build or test this one) or `runtime` (needed only while it runs). The dashboard's **Project** view draws them as the project graph (build edges solid, runtime edges dashed) and highlights a job's components and their downstream consumers; downstream verification will act on them later.
- **Validation** (`forge config validate`, `forge doctor`, `forge init write`, Settings): `components` must be a list of maps; a `name` that is missing, unsafe or repeated, a `path` that is missing, empty, absolute (`/…`, `\…`, a drive letter) or has a `..` segment, and a `kind` outside the three are problems, as are a non-string `repo` or `notes`, a `repo` that names no `repos` entry (`components "<c>".repo names unknown repo "<x>"`), `owners` that isn't a list of strings, and `commands` that isn't a map of strings or nulls. A `dependsOn` entry with neither or both targets, an empty target, a `type` other than `build | runtime`, or a `component` that names no component is a problem. A cycle of `build` edges is reported once with its path, e.g. `components: build dependency cycle a -> b -> c -> a` (a component naming itself as a build dependency is the cycle `a -> a`). Cycles that include a `runtime` edge are allowed.
- **`repo`** names a member repo from [`repos`](#repos); null or absent is the root repo. Today it only keeps the component out of command selection and the integrity scan.

### Local links

While a job changes a dependency in one repo and its consumer in another, the consumer must build against the dependency's job worktree, not its released version, and that override must never reach a commit. A `dependsOn` edge that names a `component` in another repo declares it once with `link`:

```yaml
components:
  - name: app                   # the consumer (this repo)
    path: .
    kind: app
    dependsOn:
      - component: engine-core
        type: build
        link:
          ecosystem: cargo      # cargo | cmake | npm
          name: engine-core     # the crate, FetchContent or package name
          source: crates-io     # cargo only, default crates-io: the [patch.<source>] table (a registry name or a git url)
          path: crates/core     # optional: the directory in the dependency's repo; default the dependency component's path
          manifest: Cargo.toml  # optional: the consumer's manifest an interim pin goes in, relative to its repo (see Interim strategies)
  - { name: engine-core, repo: engine, path: crates/core, kind: library }
```

- **Active rule.** A link is active for a job only when the consumer's repo and the dependency's repo are both [job repos](ARCHITECTURE.md#job-repos) with a worktree Forge trusts (the root's is `<worktrees.root>/<id>`, a member's the path Forge computes for it, never a value read from job.json alone) and `<dependency worktree>/<path>` is a directory there. Otherwise it is inactive, with a reason. `forge job links <id>` lists every declared link and its state (docs/CLI.md "Local links"). Links are recomputed before every command and never stored, so removing a job repo removes its links.
- **What a command gets.** Before `forge run` (with or without `--repo`), each verify step and verify's e2e, Forge renders the links of the repo the command runs in into `<jobDir>/links/<repo or _root>/`, never into a worktree, rewriting a file only when it changed and deleting what is no longer needed. Then it runs `PATH=<that dir>/bin:"$PATH"` after the login profile, so a profile that puts `~/.cargo/bin` first cannot shadow the shims, and calls through PATH from make, scripts or `cargo xtask` go through them too:
  - **cargo** (an active cargo link): `cargo-links.toml` holds a `[patch."<source>"]` table per source with `"<name>" = { path = "<dir>" }`, and the `cargo` shim runs the real cargo with `--config <that file>` (a leading `+toolchain` stays first). `FORGE_CARGO_CONFIG` holds its path.
  - **cmake** (any declared cmake link): a configure (no `--build`, `--install`, `--open`, `-E`, `-P`, `--workflow`, `--find-package`, `--help`, `-h`, `--version` or `--system-information`) gets `-DFETCHCONTENT_SOURCE_DIR_<NAME>=<dir>` per active link and `-UFETCHCONTENT_SOURCE_DIR_<NAME>` per inactive one, `NAME` upper-cased; the `-U` clears what an earlier configure cached once a link goes away, so declaring a link hands that cache variable to Forge. `FORGE_CMAKE_ARGS` holds the same arguments as quoted shell words.
  - **npm** (an active npm link): after an `install`, `i`, `in`, `add`, `ci`, `clean-install`, `ic`, `install-clean`, `update`, `up` or `upgrade` that passes, the shim runs `npm install --no-save --no-audit --no-fund --install-links=false <dirs>` in the same directory, so `node_modules/<name>` is a symlink into the dependency's worktree and neither `package.json` nor the lockfile is written.
- **Lockfiles.** A cargo `[patch]` makes cargo rewrite `Cargo.lock`, so with active cargo (or npm) links Forge snapshots every tracked `Cargo.lock` (or `package-lock.json` and `npm-shrinkwrap.json`) in the consumer's worktree first and writes back any that changed or went missing after the command, pass or fail; verify does it once per repo around its groups. The result's `restored` lists them and a `link-lockfiles-restored` event is logged. Your own uncommitted lockfile edit, made before the run, is what the snapshot holds, so it survives.
- **Not linked.** A command that calls a tool by absolute path bypasses the shims (use the env vars), and background commands (`forge run --background`, the dashboard's Run) and `worktrees.setup` get no links. On native Windows Forge writes no shims; the env vars and `forge job links` still work.
- **Validation.** `link` must be a map with `ecosystem` `cargo | cmake | npm`; it is a problem on a `backing` edge, between two components of the same repo, with a `name` that fails its ecosystem's pattern (a crate name, a FetchContent name, an npm package name), with a `source` on a non-cargo link or one that is not `crates-io`, a registry name or an `https://`, `ssh://` or `git://` url without whitespace, quotes, backslashes or control characters, with a `path` that is absolute or has a `..` segment, with a `manifest` that is absolute, has a `..` segment or is not the ecosystem's file (`Cargo.toml` for cargo, `CMakeLists.txt` or a `*.cmake` file for cmake, `package.json` for npm), and when two links give one consumer repo the same ecosystem and name (and cargo source) with different dependency directories.
- **Never committed.** Verify's integrity report flags added lines that carry a local override (an absolute path of a worktrees root or of `.forge/jobs`, `FETCHCONTENT_SOURCE_DIR_`, a `[patch` table in a `.cargo/config(.toml)`, or a `file:`/`link:` dependency in `package.json` that is absolute or leaves the repo) as blocking under `verifyIntegrity: block` (see [Verify integrity](#verify-integrity)).

### Interim strategies

A multi-repo job's consumer PR has to point at *something* while its dependency's change is unmerged or unreleased, and projects release differently, so each dependency repo has an **interim strategy**. An **edge** is a consumer job repo and a dependency job repo, from `components[].dependsOn` (the merge order [Job repos](ARCHITECTURE.md#job-repos) uses, transitive through repos outside the job); its **links** are the `link`s joining the two repos. A verify-only member is unchanged, so it is never a dependency. The strategy is per dependency and every edge into it shares it, resolved as: the job's override (`forge job repo interim <id> <name>|--root <strategy>`, human-only), then config (`repos[].release.interim` for a member, the top-level `release.interim` for the root repo), then `local`.

```yaml
release:
  interim: local               # the root repo as a dependency
repos:
  - name: engine
    remote: git@github.com:acme/engine.git
    defaultBranch: main
    release: { interim: git-ref }   # optional; absent or null is local
```

| Strategy | What the consumer's PR points at | What Forge does |
|---|---|---|
| `local` (default) | nothing CI can resolve: local links only | Publishes and pins nothing. `forge pr open` creates the consumer's PR as a draft, whatever `pr.draft` or `--draft` says (an existing PR is left as it is), and step never auto-merges the job (PR4 falls through to PR5). The draft stays one until a human records the dependency's release (`forge job interim release`, below): until then `forge pr ready` and `forge pr merge` refuse the consumer. |
| `sequential` | the dependency after it merges | `forge pr open` opens the dependency's PR and defers the consumer's (not pushed, no PR) until GitHub reports the dependency's PR `MERGED`; then `forge pr sync` resumes the job (`reopen: true`) and the next `forge pr open` opens it, as a draft until a human records the dependency's release (`forge job interim release`); after that a new consumer PR follows `pr.draft` and `--draft` again. Merge opens the consumer's PR; the recorded release lets it leave draft (`forge pr ready`) and merge. |
| `git-ref` | the dependency's commit | `forge verify` writes the pin into the consumer's manifest and commits it in the consumer's worktree: cargo, a `[patch."<source>"]` entry `"<name>" = { git = "<remote>", rev = "<sha>" }` in one block between `# forge:interim begin` and `# forge:interim end`; cmake, the one `GIT_TAG` of the one `FetchContent_Declare(<name> …)`; npm, `git+<url>#<sha>` in every dependency section that has the package. |
| `canary` (npm only) | a published pre-release, `<major>.<minor>.<patch>-canary.<sha12>` | `forge verify` pins that exact version (not the moving `canary` dist-tag, so the consumer's CI is reproducible); `forge pr open` opens the dependency's PR and defers the consumer's until a human publishes the canary with `forge job interim publish <id> <name>|--root --confirm`, the only command in Forge that publishes anything. |

- **The manifest** is the link's `manifest`, or the ecosystem's file (`Cargo.toml`, `CMakeLists.txt`, `package.json`) in the consumer component's `path`. The remote is the member's `remote`, or the root's `git.remote` URL; an absolute path becomes `file://<path>` (one in your home directory leaves the edge `blocked`, since a pushed manifest must not name it), `user@host:path` becomes `ssh://user@host/path`, and a URL loses its password under every scheme, and its whole `user:password@` under http(s).
- **Verify** refreshes the pins first, dependencies first, before it reads any HEAD: when `aiAttribution` is `forbid` it scrubs the dependency's branch as `pr open` will (so the pinned sha is the one pushed), then commits the changed manifests as `forge: interim pins for job <id>`. Nothing is committed when nothing changed, or when a worktree involved is dirty (`worktree-clean` then fails the run). A pin that can't be written (no link, a `[patch."<source>"]` table outside the Forge block, zero or several matching `FetchContent_Declare` or `GIT_TAG`, an npm package below its repo's root, a dependsOn cycle) fails the `interim` step, which runs after `protected` and, like it, stops every configured step. With only `local` and `sequential` edges verify has no `interim` step.
- **`forge pr open`** refuses before pushing anything when an edge is blocked, and with `interim_stale` (hint `forge verify <id>`) when a pin in the checked commits is not the dependency's checked HEAD. It opens member PRs dependencies first, pushes the root's branch before any member's when the root is a git-ref or canary dependency, and lists what it held back as `deferred: [{ repo, why, waitingOn, version? }]` (a `pr-deferred` event). A repo that depends on a deferred one through a sequential, git-ref or canary edge is deferred too.
- **Publishing a canary** (`forge job interim publish`) is refused in a daemon session, with `--confirm` when stdin is not a terminal, for a repo that is not the dependency of a canary edge whose links are all npm, unless the repo's HEAD is the one the latest passing verify checked and git shows it on the job's branch, and for a package that tracks a symlink or npm, yarn or pnpm config anywhere (`.npmrc`, `.yarnrc*`, `.pnpmrc`, matched in any case and Unicode form); the secret scan runs over its commits (`verifySecrets: block` refuses a finding or an incomplete scan). Without `--confirm` it only lists what it would publish. With it, each npm link's package is exported from the verified commit's git objects into a fresh temporary directory outside the repo (nothing untracked or ignored, no checkout filter; removed afterwards), every exported file is scanned for secrets (base content ships too), its `package.json` `name` must equal the link's, its `version` is set to the canary version and its `publishConfig` is dropped, and `npm publish <dir> --ignore-scripts --workspaces=false --tag canary --prefix <empty dir>` runs from that empty dir with no shell and the global config pointed at an empty file, so none of the package's lifecycle scripts runs and npm reads only your user config (`~/.npmrc` or `npm_config_userconfig`), never project or global config. Each publish logs `canary-published`; a version already published is skipped, and a job parked for it resumes.
- **Limits.** crates.io refuses to publish a crate with git dependencies, so `git-ref` suits consumers that are not published themselves. Lockfiles (`Cargo.lock`, `package-lock.json`) are not rewritten for a pin, so `cargo --locked` or `npm ci` in the consumer's CI needs a lockfile update by hand. npm installs a git dependency only from its repo's root, so an npm `git-ref` needs the package there. `canary` is npm-only, and is refused for a dependency a cargo or cmake link depends on. Submodule bumps are not a `git-ref` form. Reverting a pin to a released version is not done yet; the seeded [release gate](#release-gate) check fails while a pin remains.
- **Inspect.** `forge job interim <id>` lists every edge with its strategy, `source` (`job` or `config`), links, `state` and a one-line `detail`, with no network call: `held` (local), `waiting` (an unmerged sequential dependency, an unpublished canary), `ready`, `blocked` (can't be pinned) or `stale` (verify has not pinned the dependency's HEAD yet). Its `gates` list each edge's release gate: `ci` (git-ref, canary: the seeded check guards it), `held` (local, sequential, no release recorded) or `released` with the `version`.
- **Recording a release.** `forge job interim release <id> <name>|--root <version>` is how a human says the dependency of a `local` or `sequential` edge shipped. It is refused in a daemon session (before anything is read), for a done or cancelled job, an unknown repo, a repo that no local or sequential edge depends on, a version that is not semver (`1.2.0`, `v1.2.0`, `1.2.0-rc.1`, at most 120 characters) or names a canary, and a dependency whose recorded PR is not `MERGED` (run `forge pr sync <id>` first). It logs `interim-released` `{ repo, version }` (`repo` null for the root) and returns `{ id, repo, version, recorded, clear }`, where `clear` lists the consumers whose gates are now all clear; the same version again records nothing (`recorded: false`), and a later different version wins. Then `forge pr ready <id>` marks the consumer's draft PR ready for review, and `forge pr merge` may merge it; until then both refuse it (`pr ready` exits 1 with code `release_gate` and calls nothing; `pr merge` returns `action: refused`, `reason: release`, and `--now` never bypasses it), and step never auto-merges a job while one of its gates is held or one of its PRs is a draft. events.jsonl is writable outside the CLI, so only a record whose `repo` and `version` pass these checks counts; a well-formed record written by hand still opens the gate (docs/ARCHITECTURE.md "Untrusted input").

#### Release gate

`canary` and `git-ref` leave a pin in the consumer's manifest, and nothing in Forge stops a human from merging the consumer with that pin still in it. So when `forge init write` writes a config where `release.interim`, or any `repos[].release.interim`, is `git-ref` or `canary`, it seeds a check into the repo (each file only when it doesn't exist yet) and warns you to commit both and make the check required:

- `.forge/ci/release-gate.mjs`: plain Node (18 or later), no dependencies. It reads the tracked files (`git ls-files`, so nothing untracked or ignored) and fails on an interim reference. The `RULES` table at its top holds one rule per ecosystem (edit it to match your project): `cargo`, a `# forge:interim begin` line, or a `rev = "<full commit id>"` in any `[patch…]` section, in a `Cargo.toml`; `cmake`, a `GIT_TAG` set to a full commit id in a `CMakeLists.txt` or `*.cmake`; `npm`, a `git+…#<sha>` spec or a `-canary.` version in any dependency section of a `package.json`. `IGNORE` lists path regexes it skips (`node_modules/` by default). It exits 0 with `release gate: no interim references in <n> manifests`, 1 with one `<path>:<line>: <ecosystem>: <why>: <text>` line per finding, and 2 (`release gate: cannot check: <reason>` on stderr) when it can't check, such as a `package.json` that isn't a JSON object or a tracked manifest that is a symlink (it never follows one): it fails closed.
- `.github/workflows/forge-release-gate.yml`: the `release gate` job, on `pull_request` and `merge_group`, with read-only `contents` permission, a pinned `actions/checkout` without persisted credentials, and `node .forge/ci/release-gate.mjs`; no setup or install.

Forge never changes repository settings: mark the `release gate` check required in branch protection yourself. Only the root repo is seeded; copy both files into a member repo that consumes a git-ref or canary dependency, at the same paths. `.forge/ci/**` is a refuse default of [`policy.protectedPaths`](#protected-paths), so no job can edit the script, and the workflow is already covered by `.github/workflows/**`. A config written before the gate existed keeps its own `protectedPaths` list, so when `init write` seeds the gate and no refuse rule already matches `.forge/ci/release-gate.mjs`, it appends `{ paths: [.forge/ci/**], action: refuse }` to that list. The root's rules apply to every member a job commits to, so a hand-copied script at `.forge/ci/release-gate.mjs` in a member is refused too; if you copy it anywhere else, or edit the root's list by hand, keep a refuse rule that matches the script's path. A job's own override (`forge job repo interim`) never seeds anything.

**Migration** (config `schemaVersion` 12 → 13): nothing changes. v13 adds `release.interim` (default `local`) and a link's `manifest`, absent by default; the bump lets older Forges refuse a config whose interim strategy they would ignore. `forge migrate` writes the new version.

**Migration** (config `schemaVersion` 11 → 12): nothing changes. v12 adds `link` on `dependsOn` edges, absent by default; the bump lets older Forges refuse a config whose links they would ignore. `forge migrate` writes the new version.

**Migration** (config `schemaVersion` 9 → 10): `services` becomes `components`. Each service keeps its `name`, `path` (`.` when it had none), `commands`, `owners`, `notes` and any other keys, and gains `kind: service` and `dependsOn: []`, so every job runs the same commands from the same path as before. The migration happens in memory on every read; `forge migrate` writes it to disk. A config with no `schemaVersion` that still has `services` and no `components` is folded the same way. A v10 config that sets both is refused: `services was renamed to components in config schemaVersion 10; move its entries under components and delete services`.

## Repos

A project can span several repos: the **root repo**, which holds `.forge/`, and **member repos** such as the libraries an app builds on. `repos` lists the members; the root repo is implicit and never listed. It is edited by hand (it is not a `forge config set` key and Settings doesn't show it), and support bundles hide it like `resources`, since remotes can name private hosts. Each entry:

```yaml
repos:
  - name: ui-kit                               # required, unique; A-Z a-z 0-9 . _ -, starting with a letter or digit, at most 100
    remote: git@github.com:acme/ui-kit.git     # required: the clone url
    defaultBranch: main                        # required
    tracker: { kind: github, repo: acme/ui-kit }   # optional: kind github | none; repo is owner/name
    release: { interim: local }                    # optional: canary | git-ref | local | sequential (see Interim strategies)
```

Where each member is cloned differs per machine, so the paths live in **`.forge/local.yml`**, which `/forge init` gitignores and Forge never writes:

```yaml
repos:
  ui-kit: { path: ../ui-kit }
```

A relative path resolves against the root repo, a leading `~/` is the home directory, and an absolute path is used as is. `forge init write` adds a `local.yml` line to `.forge/.gitignore` when it lacks one (and lists the file in `written`); other lines are never touched.

**Validation** (`forge config validate`, `forge doctor`, `forge init write`, Settings diagnostics), one message per problem:

- `repos must be a list (got …)`; `repos[<i>] must be a map`
- a `name` that is missing or unsafe, a name listed twice (`repos "<name>" is listed more than once`), or the root repo's directory name (`repos "<name>" is the root repo; the root repo is implicit`)
- a `remote` that isn't a non-empty string of at most 2000 characters, starts with `-`, or contains whitespace or control characters
- a `defaultBranch` that isn't a safe branch name (`A-Z a-z 0-9 . _ / -`, starting with a letter or digit, at most 200 characters), or contains `..` or `//`, or ends in `/` or `.lock`
- a `tracker` that is set but isn't a map with `kind` `github | none`, or a `github` `repo` that isn't `owner/name`
- a `release` that is set but isn't a map, or an `interim` outside `canary | git-ref | local | sequential` (the top-level `release` is checked the same way)
- `components "<c>".repo names unknown repo "<x>"` for a component whose `repo` names no entry

**Doctor.** When `repos` validates, `forge doctor` (and Settings › Diagnostics) adds one `repo <name>` check per member, after `config valid`, and always prints the fix:

| Situation | Result | Detail |
|---|---|---|
| no `local.yml`, or no entry for the name | fails | `no path in .forge/local.yml; clone it: git clone <remote> ../<name>, then add to .forge/local.yml: repos: { <name>: { path: ../<name> } }` |
| the path does not exist | fails | `missing clone at <path>; run: git clone <remote> <path>` |
| the path isn't the top level of a git clone | fails | `<path> is not a git clone; point .forge/local.yml at the clone's top-level directory` |
| the clone's `git.remote` remote is missing or points elsewhere | fails | `remote "<git.remote>" is <actual or missing>, expected <remote>; run: git -C <path> remote set-url <git.remote> <remote>` (`remote add` when missing; `<git.remote>` is `origin` by default, and `<actual>` is shown without any `user:password@`) |
| no local `defaultBranch` | warns | `no local branch <defaultBranch>; run: git -C <path> fetch <git.remote> <defaultBranch>:<defaultBranch>` |
| checked out on `defaultBranch` with uncommitted changes | warns | `<defaultBranch> has uncommitted changes (<n> paths) at <path>` |
| otherwise | passes | `<path> on <branch or detached>` |

Remotes match when they are equal after dropping any `user:password@`, a trailing `/` and `.git`, or name the same GitHub `owner/name` (`git@github.com:acme/x.git` and `https://github.com/acme/x` match). Paths are single-quoted when they contain anything outside `A-Za-z0-9._/~-`. A `local.yml` check appears only when that file has a problem: unparsable YAML, a `repos` that isn't a map, or an entry without a non-empty string `path` fails it (and every member then reads as having no entry), and names that aren't in `repos` give a warning. With no `repos` and no `local.yml` there are no new checks. Doctor only reads: it never clones, fetches or checks out, runs git with `core.fsmonitor=false` and `GIT_OPTIONAL_LOCKS=0` so `status` never rewrites a member's index, and never passes `remote` to git.

**Using a member in a job.** A human adds a member to one job with `forge job repo add <id> <name> [--verify-only]` (refused unless the member passes the doctor check above, and refused in a daemon session); the job then changes that repo too ([Job repos](ARCHITECTURE.md#job-repos)). `forge worktree create` makes the member's worktree at `worktrees.root` with `{repo}` set to the clone's directory name, resolved from the clone (by default `../<clone>.worktrees/<id>`), on the job's branch, or detached at `defaultBranch` for a verify-only member. A member's commands are its components' `commands` (`forge run <id> <cmd> --repo <name>`; `forge verify` runs each `verify` step as the member component's command, and skips a step none defines). `forge pr open` opens the member's PR in `tracker.repo` when `tracker.kind` is `github`, else in the `owner/name` its `remote` names on github.com (or `GH_HOST`). Members get no `worktrees.copy`, `worktrees.setup`, port or shared Cargo target. `policy.protectedPaths` applies to every member the job commits to exactly as to the root ("Protected paths" above).

**Member review panels.** A member that a job reviews (one not added `--verify-only`) brings its own lenses: `forge job panel` reads `review.panel` from the member clone's `.forge/config.yml`, with checklists from the clone's `.forge/reviewers/<name>.md`, never from the job's worktree of it. Each entry becomes the lens `<repo>:<name>` (review file `review/round-<n>/<repo>.<name>.md`), selected by its `always`, a `Suggested reviewers:` entry naming `<repo>:<name>`, its `when`/`paths` covering an Approach path under `<repo>/`, or its `paths` matching the member's changed files (repo-relative; reasons cite `<repo>/<file>`). **Subsumption:** an entry named like a root panel lens, with no `checklist:` and no `.forge/reviewers/<name>.md` in the clone, is not a lens of its own; its matches add reasons to the root lens, which reviews the combined diff. So a member that lists `code` with `paths: [src/**]` brings the root `code` lens in for its changes, and one with its own `realtime.md` gets `<repo>:realtime`. A member entry's `model`, `effort` and `needsApp` are ignored (`runtime.models.reviewer`, the reviewer effort layers, no app). A member config that is not a regular file, is over 256 KiB, isn't valid YAML or has a `review.panel` that isn't a list fails `forge job panel` with `repo <name>: …`; an entry with a bad name or `paths`, no checklist, or a `checklist` outside the clone is dropped and listed in the result's `problems`. A member without `.forge/config.yml` or `review.panel` adds no lenses.

**Migration** (config `schemaVersion` 10 → 11): v11 adds `repos`, empty by default; an older config gains `repos: []` (an existing `repos` value is kept for validation to judge), and a leftover `services` is still folded into `components`. The bump lets older Forges refuse a config whose member repos they would ignore. The migration happens in memory on every read; `forge migrate` writes it to disk.

## Deprecated keys

A key on its way out is listed in `DEPRECATED_CONFIG_KEYS` in `lib/deprecations.ts` with the release that deprecated it, the release that removes it (at least one minor later) and what to use instead. While it is set in `.forge/config.yml`, `forge doctor` and Settings › Diagnostics show a warning row, `deprecated config key <key>`, that never fails the report. The policy is in [RELEASES.md](RELEASES.md#deprecation). Each deprecated key is listed below as `` `<key>` ``, and `test/version.test.ts` checks the list against the registry.

None today.

## Repo-layer files

| Path | Purpose |
|---|---|
| `.forge/notes/learnings.md` | lessons every agent reads; keep short; each carries an experiment and a review-by |
| `.forge/notes/<role>.md` | addendum for one role (`builder.md`, `spec-writer.md`, …) |
| `.forge/notes/experiments.md` | the retro's ledger of changes and their metrics |
| `.forge/reviewers/<lens>.md` | a repo checklist; overrides the built-in lens of the same name |
| `.forge/trackers/<name>.mjs` or `.ts` | a custom tracker adapter (see TRACKERS.md) |
| `.forge/secrets-allow.txt` | path globs and `sha256:` fingerprints the secret scanner allows; read from the main checkout only ("Secret scanning") |
| `.forge/local.yml` | this machine's member repo clone paths ("Repos"); gitignored, never written by Forge |
| `.forge/evals/<task>/` | eval tasks (see IMPROVEMENT.md); `evals/runs/` holds results |
