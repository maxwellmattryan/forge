# `.forge/config.yml`

`/forge init` writes this file. Every key is optional; anything omitted takes the default shown. The file uses a strict YAML subset (block maps and lists, quoted or plain scalars, `[a, b]` / `{a: 1}` flow collections, `|` blocks, comments; no anchors or tags). `forge config validate` checks it, `forge config show` prints the effective config, `forge config get <key>` prints one effective value, and `forge config set <key> <value>` changes one editable key (see [Changing settings](#changing-settings)).

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
  #   - { name: realtime, checklist: .forge/reviewers/realtime.md, when: "audio thread code" }
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
```

## Changing settings

`forge config get <dotted.key>` prints the effective value (defaults merged with the file): strings raw, everything else as JSON, and `null` for a path that doesn't exist. `forge config set <dotted.key> <value>` changes exactly that key in the main checkout's `.forge/config.yml` and prints `{"ok":true,"key":…,"value":…,"previous":…,"changed":true}`. Only that value's line changes (or, for a missing key, one line is inserted as the last child of its section), so comments, blank lines and key order survive. Setting a key to its current value writes nothing and replies `"changed":false`. The dashboard's Settings modal saves through the same code (`POST /api/config`).

**Values** follow the key's type: `true`/`false`; a decimal number; `null` for keys that allow it; text as written; and lists as `[a, b]` or a JSON array (`'["a","b"]'`, `[]`). Values are checked against the key's range or options, text may not contain control or invisible formatting characters (bidi overrides, zero-width characters) or exceed 200 characters, `review.blockOn` must keep both `blocker` and `major` (adding `minor` or `nit` is allowed), `daemon.idleStopMinutes` must be greater than 0 (or `null`), and `tracker.github.labels.prefix` must be at least 2 characters ending in `:`, `/` or `-`, because Forge removes every issue label that starts with it. The result must also pass `forge config validate`, though problems the file already had never block an unrelated change.

**Editable keys**: `pipeline.plan`, `split`, `specApproval`, `design`, `maxRounds` and every `pipeline.budget.*`; `review.blockOn` and `review.onPrFeedback`; `runtime.models.<role>`, `runtime.maxParallelJobs` and `runtime.diversity`; `tracker.github.ready.*`, `tracker.github.claim.assign`, `tracker.github.statusSync` and `tracker.github.labels.prefix`; `dashboard.port` (used by the next `forge dash`); and `daemon.idleStopMinutes` and `daemon.auth`. The rule: a key is editable only when it can't name a command, file, module, tool or repository Forge runs, loads or writes to, and can't loosen a security or attribution policy. Everything else (`commands.*`, `worktrees.*`, `verify*`, `git.*`, `merge.*`, `approver.*`, `aiAttribution`, `infra.*`, `review.panel`, `tracker.kind`, `tracker.github.repo`/`comments`/`project.*`, `daemon.enabled`/`command`/`allowedTools`/`maxConcurrent`, …) is refused with `<key> is not editable with forge config set (<why>); edit .forge/config.yml by hand`, and the dashboard shows it read-only. `lib/config-fields.ts` is the allowlist.

**Errors** exit 1 and leave the file byte-identical: an unknown key, a read-only key, an invalid value, or a layout the edit can't change without dropping a comment (a block map or `|` block, a list of maps, a list with comments between or on its items, a key inside a flow map). A repo without `.forge/config.yml` exits 2; `/forge init` creates it.

**The daemon.** A daemon session may not run `forge config set` (like `forge init write` and `forge migrate`). All three take the same `.forge/locks/config` lock, so they never interleave. If you run it while the dashboard's daemon is running, the change stops the daemon, exactly as a hand edit does (see [Daemon](#daemon)); the dashboard refuses to save settings until you stop the daemon, and only you may start it again.

## Split gate

`pipeline.split` decides what happens when the planner proposes several jobs for one request. `ask` (the default) parks the job on `split-approval` and creates nothing until you `/forge approve` it (create the jobs) or `/forge revise` it (keep it as one job). `auto` creates the tracker sub-issues and child jobs right away, and `never` makes the planner always plan one job, noting any split it would recommend under `## External`. A job started with `/forge issue <ref>` (or a dashboard Start) always plans as `never`: you chose that boundary. `forge job from-ref` records that as the job's `splitMode: "never"`, and so does `/forge revise` on a split proposal; every other job follows `pipeline.split`.

## How step reads the pipeline keys

`forge job step` decides each move from these keys and the job's recorded state:

- **`pipeline.plan: auto`** runs the planner when the request body (`request.md` without its title) is longer than 600 characters, or has 3 or more lines that start with a list marker (`-`, `*`, `1.`) or a `#` heading. `always` always plans and `never` never does.
- **`review.panel`** is picked once the spec is written: every `always: true` lens, plus the spec's `Suggested reviewers:` that are in the panel, plus each lens whose `when` names a path (a token with a `/` or a file extension, such as `lib/server.ts` or `dashboard/src/**`) that one of the spec's Approach paths falls under. A `when` written only in prose is left to the spec-writer's suggestion. Names that aren't plain lowercase lens names are dropped.
- **`review.onPrFeedback`** picks the lenses for a rework round on an open PR: `full` re-runs the job's whole recorded panel, `none` skips review and goes straight to `forge pr open`, and `changed` (the default) re-runs the `always: true` lenses. `changed` can't look at which files the round touched, because step decides from recorded state, not the diff.

## Model profiles

`/forge init` offers three presets for `runtime.models`. The defaults above are not a preset; they predate them.

| Profile | Models |
|---|---|
| Balanced (recommended) | planner, spec-writer, builder, retro, judge `opus`; approver `sonnet`; designer, reviewer, integrator `sonnet`; security lens `opus` |
| Economy | builder and approver `sonnet`; everything else `haiku`, except the security lens `sonnet` |
| Max quality | everything `opus`; spec-writer and builder `fable` if available |

Any profile can add `runtime.diversity: true`. Expect warnings by design where a profile shares families: the Balanced security lens is `opus` like the builder, and Economy and Max quality put the builder and approver on one family. `forge roster` always reports `diversity.overlap`: the approver and every panel lens whose model shares the builder's family (`opus`, `sonnet`, `haiku` or `fable` when the model names one, else the whole model string; `inherit` resolves through `runtime.models.orchestrator`). With `diversity: true`, `forge roster` and `forge init write` also return one warning per overlap. Diversity warns; it never blocks a job.

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

## Daemon

With `daemon.enabled: true`, `forge dash` supervises headless orchestrator sessions, so requests queued from the dashboard get handled without a Claude Code window open: one **inbox** session for requests without a job (`next`, `run`, `sync`, `retro`, `eval-run`), which only does intake and hands each new job off, and one session **per job**, started when that job has work. Whenever a session's pending requests change and it is idle, it gets one fixed turn, `/forge requests`, on stdin; the session claims and handles them exactly as yours would, seeing only its own scope's requests. Each session fails, idles and logs on its own. They spend tokens unattended, under the permissions `allowedTools` grants, so the daemon is off by default.

- **`command`** is split into argv like a shell would split words (whitespace; `'…'` literal; `"…"` with `\"` and `\\`), then run directly, with no shell: no pipes, globbing, `$VARS` or `~`. Its first word must be a bare `claude` (found on PATH) or an absolute path to `claude` outside the repo; relative paths are refused because the session runs with the repo as its working directory. This catches mistakes; it isn't a security boundary: whoever can edit this file can run code through the daemon (docs/ARCHITECTURE.md "Daemon security"), so give the `daemon` keys code-owner review. The session's PATH starts with this plugin's `bin/`, so its `forge` is the same version as `forge dash`'s. Placeholders expand after splitting, so each stays one argument even with spaces in it:
  - `{pluginRoot}`: this plugin's directory. Pass it with `--plugin-dir` so the session has the `/forge` skill and the `forge:*` agents; `--resume` doesn't restore it, so it is passed on every spawn.
  - `{session}` (required, as its own word): `--session-id <uuid>` for a new session, or `--resume <uuid>` to continue the stored one after a restart or an idle stop.
  - `{allowedTools}`: the `allowedTools` list joined with commas, as one argument.
  - Anything else in braces is left as is.
- **`allowedTools`** must include `Agent` (every role runs as a subagent), and entries can't contain commas. Subagents inherit the list. A tool call it doesn't cover is sent to you: see **Permission prompts** below. The default allows Bash only for `forge` and the git/gh forms the skill and agents name: `rev-parse`, aborting a merge or rebase, and reading PRs and CI runs. Everything else goes through `forge`: staging and committing (`forge git add <job> -- <paths>` and `forge git commit <job> --message …`, which run git in the job's worktree, because the session's cwd is the main checkout, where a bare `git add`/`git commit` would land on the base branch; they take no git options and refuse paths outside the worktree), checks (`forge run`, `forge verify`, so build tools need no entry), pushes, PRs and tracker writes, history reads (`forge git diff|log|show|range-diff`, which refuses `--output`, `--ext-diff`, `--textconv` and `--open-files-in-pager` and forces external diff and textconv off, because `git log --output=.git/config` could rewrite git config), and starting and finishing a merge or rebase (`forge integrate --keep-conflicts` / `--continue`; `--continue` refuses a rebase todo with anything but picks). Validation refuses entries that reach arbitrary execution, file writes or GitHub writes on their own: unscoped `Bash`/`Bash(*)`, `git` or `gh` with no subcommand, `git -…` (`-c`), `git config|grep|submodule|bisect|difftool|mergetool|filter-branch`, `git diff|log|show|range-diff|whatchanged|format-patch` (`--output`), `git mv` (a `x/../.git/…` destination is renamed even though git reports it invalid), `git rebase` other than `--continue|--abort|--skip` (`--exec`), and `gh api|extension|alias|auth|secret|codespace`. That list catches the known forms; it is not exhaustive, so add any other `Bash(<cmd> <sub>:*)` entry deliberately. The list replaces the default as a whole, so write every entry you want. Older defaults also listed `Bash(git status|add|rm|commit:*)`; they still validate, but in a daemon session they act on the main checkout, so drop them.
- **Flags `daemon.command` may not pass**, because they widen the session past `allowedTools`: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode` other than `default`, `dontAsk` or `plan` (so no `bypassPermissions`, `acceptEdits` or `auto`), `--settings`, `--mcp-config`, `--add-dir`, `--permission-prompt-tool` (Forge passes its own), `--agents`, a `--plugin-dir` other than `{pluginRoot}`, and `--allowedTools`/`--allowed-tools` with anything but `{allowedTools}`. Both `--flag value` and `--flag=value` are checked. claude reads `--allowedTools` and `--plugin-dir` values variadically, so a bare word right after their value (other than `{session}`) is refused too: it would become one more tool or plugin dir.
- **Permission prompts.** Forge appends `--permission-prompt-tool stdio` to every daemon command, so a tool call outside `allowedTools` (a `cp` in a worktree, a folder outside the checkout, a compound command) reaches the supervisor instead of failing. Under the default `--permission-mode default`, the session waits while the dashboard shows the call in the daemon bar and in the job's Thread: the tool, its exact input, the agent's own description of it (untrusted text), and any path outside the session's folders. **Allow once** runs it. **Allow for this session** also adds the rules and folders Claude Code suggested, for that session only: they are never written to a settings file, and they end when the session restarts. **Deny** returns a fixed message telling the agent not to retry or work around it. Nothing you type reaches the session; only your choice does. A prompt nobody answers waits as long as the session runs, and goes away when it stops. With `--permission-mode dontAsk`, nothing is ever asked: anything `allowedTools` doesn't list is refused, as the old default did. A session holds at most 20 prompts; more are denied unasked. Allowing a call is a real grant: read the command, and expect protected paths (`.git/`, `.claude/`) and commands prefixed with variables to show up here too, because `dontAsk` refused them outright.
- **Git inside the session** runs with `core.hooksPath=/dev/null` and `core.fsmonitor=false` pinned through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` (appended after any you already export), plus `GIT_EDITOR=true`. That covers subagents, `forge` and your verify commands too: **no git hooks run in daemon mode**, including your pre-commit and pre-push hooks and Git LFS's pre-push upload, so repos that depend on hooks should keep those checks in `commands.*`/`verify`, and LFS repos should not push from the daemon.
- **What the session may not change.** Forge always appends `--disallowedTools Edit(.forge/config.yml),Edit(.forge/trackers/**)` to `command`. Every `forge` call in the session also checks that those files are the ones a human started the daemon with, and refuses if they changed (`forge init write`, `forge migrate` and `forge config set` always refuse there). If they change while the daemon runs, by the session or by you, the supervisor stops it with an error in the dashboard and never restarts it on its own: review `git diff .forge/`, then press Start, which takes a fresh snapshot. docs/ARCHITECTURE.md "Daemon security" explains the layers.
- **`enabled`** means the daemon may run and starts with `forge dash`. `POST /api/daemon {"action":"stop"}` stops it until the next `start` or the next `forge dash`; to keep it off across restarts, set `enabled: false`.
- **`maxConcurrent`** (an integer from 1 to 16, default 3) caps how many job sessions run at once; the inbox session is not counted. A job with work beyond the cap waits for a slot, and an idle job session gives its slot up to a waiting job (it resumes its conversation the next time it has work). Each job session drives one job, so `runtime.maxParallelJobs` (how many jobs your own interactive session runs at once) does not apply to the pool. Spend scales with the number of live sessions: set `maxConcurrent: 1` for one job session at a time. The dashboard shows this key read-only.
- **`auth`** (`subscription`, the default, or `api-key`): which credential the sessions run on. claude prefers an `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) in its environment over the Claude login, and a headless session never asks, so a key exported in the shell that ran `forge dash` (often for some other tool) would quietly bill that API account, and its spend cap then fails every turn with `last turn failed: API Error: 400 … usage limits`. With `subscription`, both variables are dropped from the sessions' environment and they run on the login, like your own sessions. The first time `forge dash` starts a daemon-enabled repo from a terminal with a key set and no `auth` in this file, it asks once and writes the answer; started anywhere else (from `/forge dash`, a script), it assumes `subscription` and says so in its output. A session's log records an `auth` event whenever a key was present, with whether it was passed on; `forge doctor` reports the same.
- **`idleStopMinutes`**: a session with no turn in flight for this long is stopped. It stays wanted, and its next request resumes the same conversation. `null` never stops it. A job session also stops once its job is done, cancelled or failed and nothing is left for it.
- **Budget hold.** `pipeline.budget` limits are per job, so a budget stop is pending per request: a `resume`, `rework`, `answer` or `revise-spec` request whose job is at `waiting: budget` and still over a limit sends no turn. Once you raise or acknowledge the budget (`forge job budget <id> --set … | --ack`), the next tick sends it. `approve` is never held (approving a budget-parked job is the acknowledgement), nor are `cancel` and requests without a job.
- **Migration from `dashboard.launcher`** (config `schemaVersion` 1 → 2): a non-empty launcher moves to `daemon.command` (an existing `daemon.command` wins) and `dashboard.launcher` is removed; `enabled` is never set, so upgrading never turns the daemon on. A launcher was a shell template with `{prompt}`, run once per request; `forge config validate` and `forge doctor` reject a `{prompt}` command until you rewrite it in the form above (usually: take the default `command` and add your flags), because the daemon sends its turn on stdin and never through a shell. A launcher that ran some other agent CLI cannot be migrated: the daemon supervises only Claude Code's stream-json mode. The migration happens in memory on every read; `forge migrate` writes it to disk.

Files (gitignored, under `.forge/runtime/daemons/`): `<scope>.json` (session id, the last 20 ids it replaced in `pastSessionIds`, pids, the log's base offset; `forge job claim` reads these to let a daemon owner that provably let go yield without `--force`) and `<scope>.log` (every stdout event plus `forge-daemon`/`forge-stderr` lines; rotated to `<scope>.log.1` past 20 MiB), where the scope is `_inbox` or a job id. The session learns its scope only from `FORGE_DAEMON_SCOPE` in its environment. A `daemon.json` / `daemon.log` left by an older Forge is reaped and then ignored; you may delete it. `forge daemon status` lists the sessions and `forge daemon log <job>|--inbox [--lines N] [--follow]` prints one's log. docs/ARCHITECTURE.md "Daemon" covers the lifecycle and "Daemon security" the threat model.

## Repo-layer files

| Path | Purpose |
|---|---|
| `.forge/notes/learnings.md` | lessons every agent reads; keep short |
| `.forge/notes/<role>.md` | addendum for one role (`builder.md`, `spec-writer.md`, …) |
| `.forge/notes/experiments.md` | the retro's ledger of changes and their metrics |
| `.forge/reviewers/<lens>.md` | a repo checklist; overrides the built-in lens of the same name |
| `.forge/trackers/<name>.mjs` or `.ts` | a custom tracker adapter (see TRACKERS.md) |
| `.forge/evals/<task>/` | eval tasks (see IMPROVEMENT.md); `evals/runs/` holds results |
