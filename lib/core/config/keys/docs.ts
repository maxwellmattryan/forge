// Every config key's doc string: the comment docs/CONFIG.md's reference block shows beside its default (npm run docs:config).
// Data, not source comments: reference.ts walks defaults() and looks each dotted path up here. Only
// reference.ts imports it, so nothing at CLI start-up loads these strings.

export interface KeyDoc {
  /** The comment beside the key, without `#`; each `\n` starts a continuation line under it. */
  doc: string;
  /** Comment lines printed after the key's value (list-entry examples, notes on entry properties), each as `# <line>` at the key's indent. */
  more?: readonly string[];
  /** `flow` prints a map on one line; `block` prints a list of scalars one item per line. */
  layout?: 'flow' | 'block';
  /** The children are alike (one per role, command or complexity), so each needs no entry of its own. */
  uniform?: true;
}

/** Keyed by dotted path, in defaults() order. */
export const KEY_DOCS: Readonly<Record<string, KeyDoc>> = {
  schemaVersion: { doc: 'the config schema this file is written for: `forge migrate` writes it, and a Forge\nolder than it refuses the file ("update the plugin")' },

  project: { doc: 'the project every agent works on' },
  'project.name': { doc: 'display name' },
  'project.description': { doc: 'a one-line summary of the project (informational)' },
  'project.kinds': { doc: 'free-form tags (web-ui, rust, embedded, …); help pick lenses' },
  'project.instructions': {
    doc: 'files each agent reads first, if present: `default` for every role, or a role name\n(planner, spec-writer, builder, reviewer, …) whose list replaces it; a plain list is every role\'s',
    uniform: true,
  },
  'project.notes': { doc: 'one-paragraph context every agent should know' },

  git: { doc: 'the branches and remote jobs work against' },
  'git.base': { doc: 'PR target / integration branch' },
  'git.remote': { doc: 'the remote Forge fetches the base from and pushes job branches to' },
  'git.branchPrefix': { doc: 'job branches are <prefix><job-id>' },

  worktrees: { doc: 'one git worktree per job: where it lives, what it gets and when it goes' },
  'worktrees.root': { doc: 'outside the repo on purpose (bundlers, watchers, cargo workspaces)' },
  'worktrees.copy': { doc: 'untracked files/dirs copied from the main checkout, e.g. [CLAUDE.md, "packages/*/CLAUDE.md"]' },
  'worktrees.setup': { doc: 'commands run once in a new worktree, e.g. ["yarn install --frozen-lockfile"]' },
  'worktrees.seed': { doc: 'warm worktrees: clone untracked paths from a private seed instead of running setup\n(docs/CONFIG.md › Worktree seed); off while paths is empty' },
  'worktrees.seed.paths': { doc: 'untracked paths a new worktree clones from the seed instead of building, e.g. [node_modules]' },
  'worktrees.seed.key': { doc: 'files whose contents decide whether the seed fits, e.g. [package-lock.json]' },
  'worktrees.seed.setup': { doc: 'commands run instead of worktrees.setup when the seed was cloned, e.g. ["npm ls"]' },
  'worktrees.seed.warm': { doc: 'commands run in a fresh base worktree before it refreshes the seed, e.g. ["npm run typecheck"]' },
  'worktrees.cleanup': { doc: 'on-merge | manual' },
  'worktrees.cargo': { doc: 'Rust repos: where job worktrees build' },
  'worktrees.cargo.sharedTarget': { doc: 'one Cargo target dir for every job worktree' },
  'worktrees.cargo.targetDir': { doc: 'null → <worktrees.root>/.cargo-target · "main" → <repo>/target · or a path' },
  'worktrees.generated': {
    doc: 'committed paths/globs a command regenerates, e.g. ["dashboard/dist/**"]; matched\nlike verifyE2e.paths. When they conflict, forge integrate takes the base side,\nruns generatedBy, stages the output and finishes the merge or rebase itself',
  },
  'worktrees.generatedBy': {
    doc: 'the commands.* entry that regenerates them. It runs mid-merge or mid-rebase, so it\nmust not fail just because the output differs from git (a `git status` check would)',
  },

  commands: { doc: 'what `forge run <job> <name>` executes inside the worktree', uniform: true },
  'commands.dev': { doc: 'e.g. "yarn dev --port {port}"' },
  'commands.e2e': { doc: 'browser/e2e suite; `forge run <job> e2e`, and verify runs it per verifyE2e below' },

  commandEnv: { doc: 'what configured commands inherit: an allowlist of Forge\'s environment, under /bin/sh -c\n("Command environment")' },
  'commandEnv.inherit': { doc: 'more variable names commands get, e.g. [JAVA_HOME, "ANDROID_*"]; a * glob never\npasses a credential-like name, and declared secret sources never pass' },
  'commandEnv.loginShell': { doc: 'true runs commands as `$SHELL -lc`, so the login profile is sourced and can export\nwhat the allowlist dropped' },

  verify: {
    doc: 'the deterministic gate before review, in order; unset commands are skipped. A list\nentry such as [lint, test] is a group whose steps run at the same time ("Verify groups")',
  },

  verifyE2e: {
    doc: 'after every verify step passes, also run commands.e2e (nothing runs when it is unset,\nand nothing extra when e2e is already listed in verify)',
  },
  'verifyE2e.when': { doc: "ui: only when the job's diff touches `paths` · always · never" },
  'verifyE2e.paths': {
    doc: '`forge job scope` matching: exact path, `dir/` prefix, * ** ? globs; a slash-free\nglob also matches the basename. A list here replaces the default.',
  },

  verifyIntegrity: { doc: 'warn | block: block fails verify on deleted test files or added skip/focus markers' },

  verifySecrets: {
    doc: 'block | warn: block fails verify, and refuses commits and pr open, on a likely\ncredential ("Secret scanning"); warn only reports it. Text Forge sends is always refused',
  },

  ports: { doc: 'one per service/app component and per backing port: "Ports and endpoints"', layout: 'flow' },

  runtime: { doc: 'the agent runtime: how many jobs run, and each role\'s model and effort' },
  'runtime.provider': { doc: 'informational; the roster is provider-neutral markdown' },
  'runtime.host': { doc: 'the agent host Forge runs in (informational)' },
  'runtime.maxParallelJobs': { doc: 'jobs the orchestrator runs at once (1-16)' },
  'runtime.diversity': { doc: "warn when the approver or a lens shares the builder's model family (never blocks)" },
  'runtime.effort': {
    doc: 'low | medium | high | xhigh | max: the default reasoning effort for jobs (null: Claude Code\'s own setting); see "Effort"',
  },
  'runtime.efforts': { doc: 'per role; null falls through to effortByComplexity, then effort', uniform: true },
  'runtime.efforts.reviewer': { doc: 'default for lenses without their own effort' },
  'runtime.effortByComplexity': { doc: "by the spec's Complexity: header, for roles without their own", layout: 'flow', uniform: true },
  'runtime.models': { doc: 'per role; aliases (opus, sonnet, haiku, fable) or full model ids', uniform: true },
  'runtime.models.reviewer': { doc: 'default for lenses without their own model' },
  'runtime.models.verifier': { doc: "answers the repo's .forge/verifiers/ yes/no checks (docs/VERIFIERS.md)" },
  'runtime.modelByComplexity': { doc: 'the builder\'s model by the spec\'s Complexity: header; see "Builder model"', layout: 'flow', uniform: true },
  'runtime.reworkModel': { doc: 'the builder\'s model on a rework round that only addresses review findings; see "Builder model"' },

  tracker: { doc: 'where jobs come from and where their status is mirrored (docs/TRACKERS.md)' },
  'tracker.kind': { doc: 'local | github | none | <name of .forge/trackers/<name>.mjs or .ts>' },
  'tracker.local': { doc: 'the local tracker' },
  'tracker.local.path': { doc: 'the markdown backlog it reads and writes' },
  'tracker.github': { doc: 'the GitHub tracker' },
  'tracker.github.repo': { doc: 'owner/name; default: the gh-resolved repo of the checkout' },
  'tracker.github.ready': { doc: 'what counts as "ready" for /forge next' },
  'tracker.github.ready.labels': { doc: 'all must match' },
  'tracker.github.ready.excludeLabels': { doc: 'any one keeps an issue out' },
  'tracker.github.ready.assignee': { doc: 'e.g. "@me"' },
  'tracker.github.ready.milestone': { doc: 'only issues in this milestone' },
  'tracker.github.ready.projectStatus': { doc: 'e.g. "🔖 Todo" (needs a project; see below)' },
  'tracker.github.claim': { doc: 'what claiming an issue does' },
  'tracker.github.claim.assign': { doc: 'assign the issue to you when a job claims it' },
  'tracker.github.comments': { doc: 'collaborators | all: whose issue and PR comments reach agents (anyone can comment on public repos)' },
  'tracker.github.statusSync': { doc: 'none | labels | project | both' },
  'tracker.github.labels': { doc: 'status labels (statusSync: labels or both)' },
  'tracker.github.labels.prefix': { doc: 'labels mode: forge:in-progress, forge:review, …' },
  'tracker.github.project': { doc: 'the GitHub Project status is mirrored to (statusSync: project or both)' },
  'tracker.github.project.config': { doc: 'read owner/number/status field from here when present' },
  'tracker.github.project.owner': { doc: 'or set explicitly' },
  'tracker.github.project.number': { doc: "the project number, when the config file doesn't set it" },
  'tracker.github.project.statusField': { doc: 'the project field Forge sets' },
  'tracker.github.project.statusMap': {
    doc: 'Forge status → option name; unset keys are matched by meaning\nkeys: queued, in-progress, review, blocked, done, cancelled',
  },

  pipeline: { doc: 'how a job moves from request to PR' },
  'pipeline.plan': {
    doc: 'auto | always | never (auto: a planner when the request is over 600 characters or has 3+ list or heading lines)',
  },
  'pipeline.split': { doc: 'ask | auto | never (what a SPLIT plan does; see "Split gate" below)' },
  'pipeline.specApproval': { doc: 'always | large | never' },
  'pipeline.design': { doc: 'none | reference | mockup' },
  'pipeline.maxRounds': {
    doc: "build→review rounds before asking a human (eval jobs are graded instead); twice this while the security review isn't PASS",
  },
  'pipeline.maxTotalRounds': {
    doc: "the total-round ceiling: rounds of any kind, reworks included; past it each round needs a person's rework (null: twice maxRounds; see \"Total-round ceiling\")",
  },
  'pipeline.budget': {
    doc: 'per-job limits; null = unlimited. Over budget → waiting on "budget"',
    more: [
      "a person runs `forge job budget <id> --ack` in their own terminal (it asks them to type the job id), or presses Approve & continue on the budget gate in the dashboard, to grant one more full budget past the current use;",
      '`--set key=value` (or `key=value` in that Approve\'s note) overrides a limit for one job, the same way',
    ],
  },
  'pipeline.budget.tokens': { doc: 'job.usage.totalTokens' },
  'pipeline.budget.usd': { doc: 'estimated cost (job.usage.estCostUsd)' },
  'pipeline.budget.minutes': { doc: 'agent minutes: summed agent run time, never human waits' },
  'pipeline.budget.changedLines': { doc: 'committed lines added + deleted vs the base branch' },
  'pipeline.budget.verifyRetries': { doc: 'failed `forge verify` runs allowed per round beyond the first' },

  review: { doc: 'the review panel, and which lenses re-run' },
  'review.blockOn': { doc: 'severities that force another round; blocker and major are required, minor and nit optional' },
  'review.panel': {
    doc: 'lenses: built-in names or .forge/reviewers/<name>.md',
    more: [
      '  - { name: security, model: opus, when: "…", paths: ["lib/server/**", "lib/engine/trackers/**", package.json] }',
      '                         # paths: globs matched against the branch diff each round (see "How step reads the pipeline keys")',
      '  - { name: security, model: opus, effort: high }   # optional per-lens effort (see "Effort")',
      '  - { name: design, when: "user-visible UI changes" }',
      '  - { name: realtime, checklist: .forge/reviewers/realtime.md, when: "audio thread code" }',
      '  needsApp: true|false     # start commands.dev before the round and give this lens the URL;',
      '                         # defaults to true for ui, ux, accessibility and design',
      '  pathsOnly: true          # chosen only by always, a paths hit or carry, never by Suggested reviewers',
      '                         # or the Approach; needs non-empty paths',
      '  alwaysOnRework: true|false  # re-run on every rework round under onRework: narrow;',
      '                         # defaults to true for security (see "Rework panel")',
    ],
  },
  'review.onPrFeedback': { doc: 'changed | full | none (which lenses re-run after PR feedback; changed = the always: true lenses)' },
  'review.onRework': { doc: 'narrow | full: rounds 2+ re-run only the rework panel, or every lens (see "Rework panel")' },

  approver: { doc: 'what the approver never approves on its own' },
  'approver.alwaysEscalate': { doc: 'plain-language classes the approver must escalate', layout: 'block' },

  pr: { doc: 'the pull request each job opens' },
  'pr.enabled': { doc: 'false: no PRs; an approved job finishes on its branch' },
  'pr.draft': { doc: 'open every PR as a draft' },
  'pr.closeIssue': { doc: 'add "Closes #n" for GitHub-tracked jobs' },
  'pr.labels': { doc: 'labels added to every PR Forge opens' },
  'pr.reviewers': { doc: 'GitHub handles/teams to request' },
  'pr.conflicts': { doc: 'ask | fix | defer (see "Open PRs")' },
  'pr.updateStrategy': { doc: 'merge | rebase: how forge integrate brings a branch up to date with its base' },
  'pr.integrationReview': { doc: 'always | code-only: skip the integration review when only docs or generated files conflicted' },
  'pr.maxCiReworks': {
    doc: 'the CI rework cap: CI reworks forge sync starts in a row before a red head waits for a person (0: always a person; see "Open PRs")',
  },

  merge: { doc: 'whether and how Forge merges approved PRs' },
  'merge.auto': { doc: 'let Forge merge a PR whose recorded APPROVE covers its head, with no escalate-floor path, once CI passes at a settled head (see "Merge")' },
  'merge.method': { doc: 'squash | merge | rebase' },
  'merge.autoWhen': { doc: 'plain-language conditions, e.g. ["docs-only changes", "test-only changes"]' },
  'merge.requiredChecks': {
    doc: "the checks the root PR's merge needs, each a name or {name, app | workflow | creator} bound to its source; empty: the base branch's protection names them (see \"Merge\")",
  },

  aiAttribution: { doc: 'forbid | allow: whether commits, PRs, issues and comments may credit an AI (see README)' },

  release: { doc: 'how this (root) repo releases (see Release strategy)' },
  'release.interim': {
    doc: "canary | git-ref | local | sequential: what a consumer's PR points at while this (root) repo's change is unmerged (see Interim strategies)",
  },
  'release.versioning': { doc: 'semver | calver; null = undeclared (see Release strategy)' },
  'release.mechanism': { doc: 'release-please | cargo-release | changesets | tag | script: the tool that cuts a release; doctor checks it is installed' },
  'release.command': { doc: 'with mechanism: tag only, the one-line command a human runs to release (never run by Forge)' },
  'release.script': { doc: 'with mechanism: script only, the repo-relative release script forge release plan and run drive through the script protocol (see Release strategy)' },
  'release.registry': { doc: 'crates.io | npm | none' },
  'release.cadence': { doc: 'on-merge | scheduled | manual' },
  'release.publish': { doc: 'confirm | allow: whether forge release run asks on a terminal before a publish step (null: asks)' },

  resources: {
    doc: 'what agents should know exists, e.g.',
    more: [' - { name: App designs, kind: figma, url: "https://www.figma.com/design/…", use: "source of truth for UI" }', ' - { name: API docs, kind: docs, path: docs/api.md }'],
  },

  components: {
    doc: 'the parts of a monorepo (see Components), e.g.',
    more: [
      ' - { name: proto, path: crates/proto, kind: library }',
      ' - { name: api, path: services/api, kind: service, commands: { test: "go test ./...", dev: "go run . -port {port}" },',
      '     dependsOn: [{ component: proto, type: build }, { backing: postgres, type: runtime }], owners: ["@team-api"] }',
      ' - { name: web, path: ., kind: app, paths: ["web/**", "public/**"] }   # paths: globs for components that share a path',
    ],
  },

  repos: {
    doc: 'member repos of the project; the root repo is implicit (see Repos), e.g.',
    more: [' - { name: ui-kit, remote: "git@github.com:acme/ui-kit.git", defaultBranch: main }'],
  },

  checkout: {
    doc: 'steps forge focus applies to the focused job (see Checkout steps), e.g.',
    more: [' - { link: build/MyPlugin.vst3, to: ~/Library/Audio/Plug-Ins/VST3/MyPlugin.vst3 }', ' - { run: install-plugin, undo: uninstall-plugin }   # names commands.* entries'],
  },

  backing: {
    doc: 'databases, caches and queues jobs run against (see Backing services), e.g.',
    more: [
      ' - { name: postgres, isolation: per-job, image: "postgres:16", ports: [5432], env: { POSTGRES_PASSWORD: forge } }',
      ' - { name: queue, isolation: external, url: "amqp://mq.internal:5672" }',
    ],
  },

  secrets: {
    doc: 'named development credentials config sinks reach as {secret.NAME} (see Secret references), e.g.',
    more: [' DB_PASSWORD: { env: MYAPP_DB_PASSWORD }'],
  },

  downstream: { doc: "a changed library's linked consumers join the job verify-only (see Downstream verification)" },
  'downstream.enabled': { doc: 'false: no consumer repo joins a job' },
  'downstream.max': { doc: 'at most this many downstream repos per job' },
  'downstream.skip': { doc: 'repos names never added' },

  infra: { doc: "what agents may do to infrastructure; their briefs carry mode and allowed" },
  'infra.mode': { doc: 'human | plan-only | agent' },
  'infra.allowed': { doc: 'commands agents may run under plan-only/agent, e.g. ["terraform plan", "kubectl get"]' },
  'infra.notes': { doc: 'free-form notes on how infrastructure is run here (informational)' },

  usage: { doc: 'token and cost accounting' },
  'usage.track': { doc: "informational: agent runs' usage is recorded either way" },
  'usage.pricing': {
    doc: 'overrides for lib/integrations/claude/pricing.json: { models: { <id>: {input, output, cacheRead, cacheWrite} }, aliases: {…} }',
  },

  improve: { doc: 'retros and the experiment ledger (docs/IMPROVEMENT.md)' },
  'improve.retroEvery': { doc: 'a retro is due after this many finished jobs (with the foreman on, forge sync queues it)' },
  'improve.maxLearnings': { doc: 'cap on .forge/notes/learnings.md entries' },
  'improve.experiments': { doc: 'forge experiment evaluate (docs/IMPROVEMENT.md "Settling experiments")' },
  'improve.experiments.minJobs': { doc: 'after-jobs with a value needed before an entry is decided; fewer is pending' },
  'improve.experiments.maxJobs': { doc: 'after this many finished jobs an undecided entry is closed as inconclusive; at least minJobs' },

  evals: { doc: 'a run\'s variant is an overlay, never an edit here (see "Eval overlays" below)' },
  'evals.testPattern': { doc: "regex for test files: mining PRs into eval tasks, and verify's integrity report (null: a built-in default)" },
  'evals.recall': { doc: 'reviewer recall evals (docs/IMPROVEMENT.md "Reviewer recall evals")' },
  'evals.recall.paths': {
    doc: 'committed paths (spec-path tokens) that make decide ask for a reviewer recall eval, when the main checkout has fixtures',
  },

  dashboard: { doc: 'forge dash, the local dashboard' },
  'dashboard.port': { doc: 'the first port forge dash tries (--port overrides it)' },

  daemon: { doc: 'opt-in headless sessions supervised by `forge dash`: an inbox plus one per job (see "Daemon" below)' },
  'daemon.enabled': { doc: 'true: `forge dash` starts it, and POST /api/p/<project>/daemon may start it again after a stop' },
  'daemon.command': { doc: 'the claude command each session runs, split into words without a shell (see "Daemon" below)' },
  'daemon.allowedTools': {
    doc: 'refused if it names blanket git/gh, a scoped file rule or an MCP tool; bare Edit/Write are scoped to the job folders and worktrees at spawn (see "Daemon" below)',
    layout: 'block',
  },
  'daemon.maxConcurrent': { doc: 'job sessions at once (1-16), besides the inbox' },
  'daemon.idleStopMinutes': { doc: 'stop an idle session after this long (null: never); new work resumes it' },
  'daemon.turnTimeoutMinutes': { doc: 'stop a turn still running after this long and requeue its work (null: no limit)' },
  'daemon.auth': { doc: "what sessions run on: your Claude login, or api-key for an ANTHROPIC_API_KEY in forge dash's shell" },
  'daemon.jobBudget': {
    doc: 'with enabled: true, fills each of tokens, usd and minutes the job\'s budget leaves unset (null: off; see "Daemon" below)',
  },
  'daemon.jobBudget.tokens': { doc: 'total tokens per job' },
  'daemon.jobBudget.usd': { doc: 'estimated USD per job' },
  'daemon.dailyUsd': {
    doc: 'dollars per UTC day the inbox, office and chat sessions may spend, as the supervisor meters it; at the cap the session stops: start it again after midnight UTC, or raise the cap (null: no caps; see "Daemon" below)',
  },
  'daemon.dailyUsd.inbox': { doc: "the inbox session's daily cap in USD (null: none)" },
  'daemon.dailyUsd.office': { doc: 'the daily cap in USD on the office session and its gate runs, summed: at the cap no gate run starts (null: none)' },
  'daemon.dailyUsd.chat': { doc: "the daily cap in USD on every chat session of the project, summed: at the cap a chat refuses the owner's next message, and a running one stops after its reply (null: none)" },
  'daemon.keepAwake': {
    doc: 'auto: while the pool is started and an active mandate or a running job at an agent stage is in flight, the machine dashboard holds a sleep assertion; never: this project never does (see "Daemon" below)',
  },

  foreman: { doc: 'opt-in: forge dash decides parked gates in code, one forge:assistant process per gate (see "Foreman" below)' },
  'foreman.enabled': { doc: "true (with daemon.enabled): parked gates become `gate` requests that forge dash's gate runner decides" },
  'foreman.decides': {
    doc: "add repo-proposal to let it widen a job's repos; release (with gate:release out of reserved) to let it approve a release plan; milestone-approval to let it approve or revise a goal mandate's milestone draft\nthe gate classes it may decide; a class left out stays a plain human gate",
  },
  'foreman.reserved': {
    doc: 'whole-phrase, case-insensitive: a match keeps the gate with a human; gate:<class> keeps a whole class',
    layout: 'block',
  },
  'foreman.ship': { doc: 'propose | merge | release: merge counts as merge.auto for PRs the approver marks eligible; release does too, and lets a mandate run until released' },
  'foreman.model': { doc: "the office session's model when it directs work under mandates (inherit: daemon.command's)" },
  'foreman.effort': { doc: "the office session's effort (null: runtime.effort)" },
  'foreman.cadence': { doc: "1-1440: minutes between the Office's passes over its mandates" },
  'foreman.assistants': { doc: 'the forge:assistant that judges one gate, and the gate runs that start it' },
  'foreman.assistants.enabled': { doc: "the gate runner takes the Foreman's gate requests (false: every gate waits for a person)" },
  'foreman.assistants.parallel': { doc: '1-16: gate runs at once, outside daemon.maxConcurrent and the machine cap' },
  'foreman.assistants.model': { doc: 'the model of each gate run\'s forge:assistant; see "Foreman"' },
  'foreman.assistants.effort': { doc: "the assistant's effort; a job's effort beats it, and null falls through to effortByComplexity, then effort" },
  'foreman.surveyors': { doc: "sub-agents that summarise a mandate's board for the Foreman" },
  'foreman.surveyors.enabled': { doc: 'the Foreman spawns surveyors' },
  'foreman.surveyors.model': { doc: "the surveyors' model" },
  'foreman.surveyors.effort': { doc: "the surveyors' effort (null: runtime.effort)" },
  'foreman.mandate': { doc: 'what forge mandate new fills a contract term it is not given with (see "Mandates" below)' },
  'foreman.mandate.until': {
    doc: 'merge-ready | merged | released: where its work stops (merged needs ship: merge or release, else merge-ready applies; released needs ship: release, else merged or merge-ready applies)',
  },
  'foreman.mandate.maxJobs': { doc: '1-16: its jobs running at once' },
  'foreman.mandate.order': { doc: 'graph | priority | listed: how it orders its work (listed: scope.issues in order)' },
  'foreman.mandate.decides': { doc: 'the gate classes it delegates, intersected with the effective foreman.decides' },
  'foreman.mandate.budget': { doc: 'its spend caps' },
  'foreman.mandate.budget.usd': { doc: 'USD, more than 0 and at most 100000' },
  'foreman.mandate.budget.jobs': { doc: '1-1000: jobs it may start' },
  'foreman.mandate.stall': { doc: 'when its work counts as stalled' },
  'foreman.mandate.stall.cadences': { doc: "1-100: the Foreman's passes with no progress" },
  'foreman.mandate.stall.bounces': { doc: '1-100: gate bounces on one job' },
  'foreman.mandate.onUnfinishable': { doc: "park | cancel: what it does with a job it can't finish" },

  policy: { doc: 'enforced by the CLI, not a prompt (see "Protected paths" below)' },
  'policy.protectedPaths': { doc: '[] turns it off; a config without `policy` gets these' },

  retention: { doc: 'what Forge deletes and when; null keeps forever (see "Retention" below)' },
  'retention.jobsDays': { doc: '1-3650: forge sync and forge dash archive finished jobs this many days old' },
  'retention.logsDays': { doc: "1-3650: ...and delete daemon session logs this old whose session isn't running" },
  'retention.logMaxBytes': { doc: '1048576-1073741824: rotate a session log to <scope>.log.1 as soon as it reaches this size' },

  environments: { doc: 'job environments (see "Environments" below)' },
  'environments.maxRunning': { doc: '1-64: starting one more stops the least recently used, never the focused job; null = no cap' },

  outcomes: { doc: 'what forge sync watches after a merge (see "Outcomes" below)' },
  'outcomes.windowDays': { doc: '1-365: days after the merge that a revert, follow-up bug or churn counts' },

  scoring: { doc: 'post-merge judge scores for a sample of merged jobs (see "Scoring" below)' },
  'scoring.sample': { doc: "0-1: the share of merged jobs, outside mandates that score all or off, that forge sync queues for one judge run; 0 is off outside mandates" },
  'scoring.model': { doc: "the scoring judge's model; null falls through to runtime.models.judge" },

  notify: { doc: 'push notifications on gates, PRs, failures and budget stops (see "Notifications" below)' },
  'notify.webhooks': { doc: 'each: { url: https://…, events: [gate, pr-opened, …] (omitted = all), format: json | slack }' },
  'notify.command': { doc: 'e.g. ./scripts/page.sh {event} {job} {title} {url}; placeholders read env vars, never values' },

  budget: { doc: 'repo-wide spend caps per UTC day and month; null = unlimited (see "Repo budget" below)' },
  'budget.usdPerDay': { doc: 'estimated USD across every job per UTC day' },
  'budget.usdPerMonth': { doc: 'estimated USD across every job per UTC month' },
  'budget.tokensPerMonth': { doc: 'total tokens across every job per UTC month' },
  'budget.onExceeded': { doc: 'hold: park and refuse new work at the cap · warn: report it only' },
};
