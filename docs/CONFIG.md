# `.forge/config.yml`

`/forge init` writes this file. Every key is optional; anything omitted takes the default shown. The file uses a strict YAML subset (block maps and lists, quoted or plain scalars, `[a, b]` / `{a: 1}` flow collections, `|` blocks, comments; no anchors or tags). `forge config validate` checks it, `forge config show` prints the effective config, `forge config get <key>` prints one effective value, and `forge config set <key> <value>` changes one editable key (see [Changing settings](#changing-settings)).

Command templates are POSIX `sh`: each runs as `$SHELL -lc <cmd>` (`/bin/sh` when `$SHELL` is unset), and on native Windows under Git for Windows' `sh` (Git Bash; the first `sh.exe` on PATH, else `%ProgramFiles%\Git\bin\sh.exe`), or is refused with an error when there is none (see [SUPPORT.md](SUPPORT.md)). Command templates may use `{port}`, `{job}`, `{worktree}`, `{root}`, `{branch}`, `{base}` and `{args}`. `{args}` holds the extra arguments of `forge run <job> <name> -- <args…>`, each already in single quotes, and arguments go only where a template has it: `forge run` refuses arguments for a template without `{args}`, so a command takes none unless you opt in. Write `{args}` unquoted, as a whole word: after the start, a space, a tab, a newline or `(`, and before the end, a space, a tab, a newline, `;`, `&`, `|` or `)`. Arguments for a template where it sits inside `'…'` or `"…"` or touches another word (`x{args}`, `\{args}`) are refused, and so are arguments for any template containing a heredoc (`<<`), `$'` or `\'`, where the quoting would not hold. The arguments become words of whatever command surrounds `{args}`, so `exec {args}`, `env {args}` or `time {args}` runs the first one as a program. An argument containing a quote, backslash or control character is refused too. Every refusal comes before anything runs. Only `forge run` has arguments: `forge verify`, worktree setup, `forge run --background`, `forge integrate`'s rebuild and `forge eval grade` fill `{args}` with nothing. The other placeholders are filled in unquoted, so `{job}`, `{branch}` and `{base}` are checked first: each must start with a letter or digit and use only `A-Z a-z 0-9 . _ / -` (at most 200 characters), and an unsafe value stops the command before it runs, with an error naming the field. Commands also get `PORT`, `FORGE_PORT`, `FORGE_JOB` and `FORGE_WORKTREE` in their environment, and never the daemon session's `FORGE_DAEMON*` variables, so a command that calls `forge` behaves the same under the daemon as for a human.

```yaml
schemaVersion: 5

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
    - { paths: [.forge/config.yml, .forge/secrets-allow.txt, .forge/trackers/**], action: refuse, reason: "Forge's own policy changes only by a human on the base branch" }
```

## Changing settings

`forge config get <dotted.key>` prints the effective value (defaults merged with the file): strings raw, everything else as JSON, and `null` for a path that doesn't exist. `forge config set <dotted.key> <value>` changes exactly that key in the main checkout's `.forge/config.yml` and prints `{"ok":true,"key":…,"value":…,"previous":…,"changed":true}`. Only that value's line changes (or, for a missing key, one line is inserted as the last child of its section), so comments, blank lines and key order survive. Setting a key to its current value writes nothing and replies `"changed":false`. The dashboard's Settings modal saves through the same code (`POST /api/config`).

**Values** follow the key's type: `true`/`false`; a decimal number; `null` for keys that allow it; text as written; and lists as `[a, b]` or a JSON array (`'["a","b"]'`, `[]`). Values are checked against the key's range or options, text may not contain control or invisible formatting characters (bidi overrides, zero-width characters) or exceed 200 characters, `review.blockOn` must keep both `blocker` and `major` (adding `minor` or `nit` is allowed), `daemon.idleStopMinutes` must be greater than 0 (or `null`), and `tracker.github.labels.prefix` must be at least 2 characters ending in `:`, `/` or `-`, because Forge removes every issue label that starts with it. The result must also pass `forge config validate`, though problems the file already had never block an unrelated change.

**Editable keys**: `pipeline.plan`, `split`, `specApproval`, `design`, `maxRounds` and every `pipeline.budget.*`; `review.blockOn` and `review.onPrFeedback`; `pr.integrationReview`; `runtime.models.<role>`, `runtime.maxParallelJobs`, `runtime.diversity`, `runtime.effort`, `runtime.efforts.<role>` and `runtime.effortByComplexity.*` (the assistant's model and effort included); `tracker.github.ready.*`, `tracker.github.claim.assign`, `tracker.github.statusSync` and `tracker.github.labels.prefix`; `dashboard.port` (used by the next `forge dash`); and `daemon.idleStopMinutes` and `daemon.auth`. The rule: a key is editable only when it can't name a command, file, module, tool or repository Forge runs, loads or writes to, and can't loosen a security or attribution policy. Everything else (`commands.*`, `worktrees.*`, `verify*`, `git.*`, `merge.*`, `approver.*`, `aiAttribution`, `infra.*`, `review.panel`, `tracker.kind`, `tracker.github.repo`/`comments`/`project.*`, `daemon.enabled`/`command`/`allowedTools`/`maxConcurrent`, `foreman.*`, …) is refused with `<key> is not editable with forge config set (<why>); edit .forge/config.yml by hand`, and the dashboard shows it read-only. `lib/config-fields.ts` is the allowlist.

**Errors** exit 1 and leave the file byte-identical: an unknown key, a read-only key, an invalid value, or a layout the edit can't change without dropping a comment (a block map or `|` block, a list of maps, a list with comments between or on its items, a key inside a flow map). A repo without `.forge/config.yml` exits 2; `/forge init` creates it.

**The daemon.** A daemon session may not run `forge config set` (like `forge init write` and `forge migrate`). All three take the same `.forge/locks/config` lock, so they never interleave. If you run it while the dashboard's daemon is running, the change stops the daemon, exactly as a hand edit does (see [Daemon](#daemon)); the dashboard refuses to save settings until you stop the daemon, and only you may start it again.

## Split gate

`pipeline.split` decides what happens when the planner proposes several jobs for one request. `ask` (the default) parks the job on `split-approval` and creates nothing until you `/forge approve` it (create the jobs) or `/forge revise` it (keep it as one job). `auto` creates the tracker sub-issues and child jobs right away, and `never` makes the planner always plan one job, noting any split it would recommend under `## External`. A job started with `/forge issue <ref>` (or a dashboard Start) always plans as `never`: you chose that boundary. `forge job from-ref` records that as the job's `splitMode: "never"`, and so does `/forge revise` on a split proposal; every other job follows `pipeline.split`.

## How step reads the pipeline keys

`forge job step` decides each move from these keys and the job's recorded state:

- **`pipeline.plan: auto`** runs the planner when the request body (`request.md` without its title) is longer than 600 characters, or has 3 or more lines that start with a list marker (`-`, `*`, `1.`) or a `#` heading. `always` always plans and `never` never does.
- **`review.panel`** is picked once the spec is written: every `always: true` lens, plus the spec's `Suggested reviewers:` that are in the panel, plus each lens whose `when` names a path (a token with a `/` or a file extension, such as `lib/server.ts` or `dashboard/src/**`) that one of the spec's Approach paths falls under. A `when` written only in prose is left to the spec-writer's suggestion. Names that aren't plain lowercase lens names are dropped.
- **`review.panel[].needsApp`** says whether a lens reviews the running app. When a lens in the round needs it and `commands.dev` is set, Forge starts the dev server before the reviewers spawn and puts `Dev server: http://localhost:<port>` in that lens's brief. Absent, it defaults to `true` for `ui`, `ux`, `accessibility` and `design` and `false` for every other name; an explicit value wins for any name (`needsApp: false` keeps a `ui` lens off the app, `needsApp: true` puts a custom lens such as `visual-qa` on it). Anything but `true` or `false` is a config problem. A lens recorded on a job but no longer in the panel gets the name default.
- **`review.onPrFeedback`** picks the lenses for a rework round on an open PR: `full` re-runs the job's whole recorded panel, `none` skips review and goes straight to `forge pr open`, and `changed` (the default) re-runs the `always: true` lenses. `changed` can't look at which files the round touched, because step decides from recorded state, not the diff.

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

Under `warn` the report never changes the result; reviewers and the approver read it. Under `block`, a deleted test file or an added skip/focus marker fails verify (`failure.name: integrity`), and so does a report that cannot be computed (base not found, invalid pattern, or a base that already contains commits the job branch's reflog records as made on it). A deletion is sanctioned, listed as *named in spec* and never blocks, when a line of the spec's `## Approach` makes its exact path the object of delete, remove or drop (``- Delete `test/old.test.mjs` ``, ``- Remove the test files `a` and `b` ``); a move the runner may miss is sanctioned the same way by ``- Move `test/a.test.js` to `test/a.test.ts` `` (or rename … to/into …; a `to` ending in `/` keeps the file name). The path must end the clause: ``Remove `x` from the lint glob``, ``Drop `x` coverage of …`` or ``Remove the `x` case`` sanction nothing. A mere mention, any line with a negation (not, n't, never, keep, avoid, without, leave, cannot), a rename out of the pattern or a type change is never sanctioned. For any other legitimate skip or deletion, the human escape is `verifyIntegrity: warn`. The mode is always read from the main checkout's config, so a job that edits `.forge/config.yml` cannot switch it off.

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
- **Permission prompts.** Forge appends `--permission-prompt-tool stdio` to every daemon command, so a tool call outside `allowedTools` (a `cp` in a worktree, a folder outside the checkout, a compound command) reaches the supervisor instead of failing. Under the default `--permission-mode default`, the session waits while the dashboard shows the call in the status bar's Inbox popover and in the job drawer's dock: the tool, its exact input, the agent's own description of it (untrusted text), and any path outside the session's folders. **Allow once** runs it. **Allow for this session** also adds the rules and folders Claude Code suggested, for that session only: they are never written to a settings file, and they end when the session restarts. A suggestion that would allow a tool's every call (a bare `Bash`, or a wildcard-only pattern) is dropped, so a session grant is only ever a pattern you read, such as `Bash(cp:*)`. The input shown is exactly what an allow runs, never cut short: a call whose input is over 4,000 characters is denied unasked. **Deny** returns a fixed message telling the agent not to retry or work around it. Nothing you type reaches the session; only your choice does. A prompt nobody answers waits as long as the session runs, and goes away when it stops. With `--permission-mode dontAsk`, nothing is ever asked: anything `allowedTools` doesn't list is refused, as the old default did. A session holds at most 20 prompts; more are denied unasked. Allowing a call is a real grant: read the command, and expect protected paths (`.git/`, `.claude/`) and commands prefixed with variables to show up here too, because `dontAsk` refused them outright.
- **Permission mode per session.** Each session's log (a job's Log tab, or the Inbox log in the status bar's Inbox popover) has a **Permissions** selector: **Ask** (`default`: prompts as above), **Auto** (Claude Code's `auto` mode: its classifier approves routine calls on its own and still sends risky ones to you as prompts) and **Refuse** (`dontAsk`). It starts at `daemon.command`'s mode. A change applies at once to a running session, through Claude Code's `set_permission_mode` control request, and the log records claude's confirmation; a session that isn't running starts in it. The choice is held by `forge dash` in memory only, never in a file (a session can write files in the repo, so it could otherwise pick its own mode), so it lasts until `forge dash` stops, and the Daemon popover names the mode on the rows of the job sessions you switched. If claude refuses a switch or doesn't confirm it within 15 seconds, the log says why. A switch to a wider mode (`auto` isn't available on every account or model) falls back: the selector shows the mode the session still runs in. A switch to a narrower mode stops the session instead, and it starts in the mode you chose with its next request, so a session never keeps more reach than you picked. `bypassPermissions` and `acceptEdits` are never offered. `daemon.allowedTools`, the `.forge/config.yml` deny rules and the trust check apply in every mode. Auto approves most calls with nobody reading them, so use it on a session you are watching, and switch back to Ask when you leave. It isn't contained to that session either: a call that runs unread can reach the dashboard's own API and switch or answer for the others (docs/ARCHITECTURE.md "Daemon security").
- **Git inside the session** runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` pinned through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (appended after any you already export), plus `GIT_EDITOR=true`. That covers subagents, `forge` and your verify commands too: **no git hooks run in daemon mode**, including your pre-commit and pre-push hooks and Git LFS's pre-push upload, so repos that depend on hooks should keep those checks in `commands.*`/`verify`, and LFS repos should not push from the daemon.
- **What the session may not change.** Forge always appends `--disallowedTools Edit(.forge/config.yml),Edit(.forge/trackers/**),Edit(.forge/secrets-allow.txt)` to `command`. Every `forge` call in the session also checks that those files are the ones a human started the daemon with, and refuses if they changed (`forge init write`, `forge migrate` and `forge config set` always refuse there). If they change while the daemon runs, by the session or by you, the supervisor stops it with an error in the dashboard and never restarts it on its own: review `git diff .forge/`, then press Start, which takes a fresh snapshot. docs/ARCHITECTURE.md "Daemon security" explains the layers.
- **`enabled`** means the daemon may run and starts with `forge dash`, except `forge dash --dev` (what `npm run dev` runs), which leaves it off until you press Start. `POST /api/daemon {"action":"stop"}` stops it until the next `start` or the next `forge dash`; to keep it off across restarts, set `enabled: false`.
- **`maxConcurrent`** (an integer from 1 to 16, default 3) caps how many job sessions run at once; the inbox session is not counted. A job with work beyond the cap waits for a slot, and an idle job session gives its slot up to a waiting job (it resumes its conversation the next time it has work). A session whose job has agents running (reviewers it started in the background, say) is kept: it is never stopped for a slot, though it still counts toward the cap, so the waiting job gets the next slot that frees. So is a session for 30 s after its last turn or agent ended. Each job session drives one job, so `runtime.maxParallelJobs` (how many jobs your own interactive session runs at once) does not apply to the pool. Spend scales with the number of live sessions: set `maxConcurrent: 1` for one job session at a time. The dashboard shows this key read-only.
- **`auth`** (`subscription`, the default, or `api-key`): which credential the sessions run on. claude prefers an `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in its environment over the Claude login, and a headless session never asks, so a key exported in the shell that ran `forge dash` (often for some other tool) would quietly bill that API account, and its spend cap then fails every turn with `last turn failed: API Error: 400 … usage limits`. With `subscription`, both variables are dropped from the sessions' environment and they run on the login, like your own sessions. The first time `forge dash` starts a daemon-enabled repo from a terminal with a key set and no `auth` in this file, it asks once and writes the answer; started anywhere else (from `/forge dash`, a script), it assumes `subscription` and says so in its output. A session's log records an `auth` event whenever a key was present, with whether it was passed on; `forge doctor` reports the same.
- **`idleStopMinutes`**: a session with no turn in flight for this long is stopped. The time counts from its last turn or the last agent of its job ending, whichever is later, and a session is never idle-stopped while its job's agents run. It stays wanted, and its next request resumes the same conversation. `null` never stops it. A job session also stops once its job is done, cancelled or failed and nothing is left for it.
- **Budget hold.** `pipeline.budget` limits are per job, so a budget stop is pending per request: a `resume`, `rework`, `answer` or `revise-spec` request whose job is at `waiting: budget` and still over a limit sends no turn. Once you raise or acknowledge the budget (`forge job budget <id> --set … | --ack`), the next tick sends it. `approve` is never held (approving a budget-parked job is the acknowledgement), nor are `cancel` and requests without a job.
- **Migration from `dashboard.launcher`** (config `schemaVersion` 1 → 2): a non-empty launcher moves to `daemon.command` (an existing `daemon.command` wins) and `dashboard.launcher` is removed; `enabled` is never set, so upgrading never turns the daemon on. A launcher was a shell template with `{prompt}`, run once per request; `forge config validate` and `forge doctor` reject a `{prompt}` command until you rewrite it in the form above (usually: take the default `command` and add your flags), because the daemon sends its turn on stdin and never through a shell. A launcher that ran some other agent CLI cannot be migrated: the daemon supervises only Claude Code's stream-json mode. The migration happens in memory on every read; `forge migrate` writes it to disk.

Files (gitignored, under `.forge/runtime/daemons/`): `<scope>.json` (session id, the last 20 ids it replaced in `pastSessionIds`, pids, the log's base offset; `forge job claim` reads these to let a daemon owner that provably let go yield without `--force`) and `<scope>.log` (every stdout event plus `forge-daemon`/`forge-stderr` lines; rotated to `<scope>.log.1` past 20 MiB), where the scope is `_inbox` or a job id. The session learns its scope only from `FORGE_DAEMON_SCOPE` in its environment. A `daemon.json` / `daemon.log` left by an older Forge is reaped and then ignored; you may delete it. `forge daemon status` lists the sessions and `forge daemon log <job>|--inbox [--lines N] [--follow]` prints one's log. docs/ARCHITECTURE.md "Daemon" covers the lifecycle and "Daemon security" the threat model.

## Foreman

With `foreman.enabled: true` and `daemon.enabled: true`, `forge dash` runs one more supervised session, the **office** (scope `_office`), beside the inbox. It never counts against `daemon.maxConcurrent`, and it shares the pool's trust check, deny rules, budget holds and failure handling. When `forge job set` parks a job on a gate whose class is in `decides`, the CLI queues a `gate` request; `forge pr sync` does the same for a job waiting on `pr-review` with failing checks, or with changes requested or unresolved threads from someone with write access to the repo (`pr-feedback`, once per PR head; feedback only from others stays with a human). The office session hands each one to a `forge:assistant` sub-agent (model `runtime.models.assistant`, effort `runtime.efforts.assistant`) that reads the job's files, then records the verdict with `forge job human … --actor foreman` and queues a `resume` for the job's session. It never reads a job file itself.

- **`enabled`** (default `false`): nothing changes while it is off. No `gate` request is written and no office session runs. The status bar's Foreman indicator still shows, dashed, as **Foreman off**, and its popover says how to turn it on here (the key is locked in Settings and `forge config set`).
- **`decides`**: the classes it may decide, from `spec-approval`, `split-approval`, `escalation`, `rounds-exhausted`, `conflicts` and `pr-feedback`. `input`, `issue-link`, `infra`, `budget`, `human` and `external` are never foreman gates. An unknown entry is reported by `forge config validate` / `forge doctor` and ignored at run time.
- **`reserved`**: patterns matched as whole phrases, case-insensitively, against the job's reason, the `## Why` and `## For the human` sections of `decision.md` (escalation and rounds-exhausted) and the foreman's own note. A match leaves the gate with a human, and the CLI refuses the foreman's decision even if the request said otherwise. So does a security review whose latest recorded verdict is anything but `PASS` (`CHANGES`, or `MALFORMED`), whatever the texts say. A value that isn't a list of non-empty strings fails closed: every gate stays with a human until it is fixed.
- **`ship`** (`propose` or `merge`): `merge` (with `enabled`) counts as `merge.auto: true` in the approver's brief and in step rule PR4, so a PR the approver marks `Auto-merge eligible: yes` under `merge.autoWhen` is merged, and `forge pr merge` still enforces CI. The office session itself can never run `forge pr merge`.

All four keys are read-only in the settings: edit them by hand.

- **Migration** (config `schemaVersion` 4 → 5): nothing changes. v5 adds `foreman.*` (off by default), `runtime.models.assistant` and `runtime.efforts.assistant`; the bump lets older Forges refuse a config whose foreman policy they would ignore. docs/ARCHITECTURE.md "Foreman" covers routing and the authority checks.

## Repo-layer files

| Path | Purpose |
|---|---|
| `.forge/notes/learnings.md` | lessons every agent reads; keep short; each carries an experiment and a review-by |
| `.forge/notes/<role>.md` | addendum for one role (`builder.md`, `spec-writer.md`, …) |
| `.forge/notes/experiments.md` | the retro's ledger of changes and their metrics |
| `.forge/reviewers/<lens>.md` | a repo checklist; overrides the built-in lens of the same name |
| `.forge/trackers/<name>.mjs` or `.ts` | a custom tracker adapter (see TRACKERS.md) |
| `.forge/secrets-allow.txt` | path globs and `sha256:` fingerprints the secret scanner allows; read from the main checkout only ("Secret scanning") |
| `.forge/evals/<task>/` | eval tasks (see IMPROVEMENT.md); `evals/runs/` holds results |
