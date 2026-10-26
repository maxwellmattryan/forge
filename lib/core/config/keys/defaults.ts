// Every config key Forge reads, with its default: what loadConfig merges a repo's config.yml over.
// `load.ts` re-exports it, and each key's doc string is in `docs.ts` beside it.
import { CONFIG_SCHEMA_VERSION, EFFORT_ROLES, OFFICE_GATES } from '../../job/schema.ts';
import { INSTRUCTIONS_RULE } from '../validators/instructions.ts';
import type { Config, Effort, EffortRole } from '../../types.ts';

/** foreman.reserved's default: topics that always stay with a human. */
export const DEFAULT_RESERVED = [
  'credential',
  'credentials',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'auth',
  'authentication',
  'authorization',
  'oauth',
  'permission',
  'permissions',
  'security',
  'CI',
  'CI/CD',
  'workflow',
  'workflows',
  'GitHub Actions',
  'payment',
  'payments',
  'PII',
  'crypto',
  'cryptography',
  'encryption',
  // A whole gate class, never text: publishing can't be undone, so a release stays a human's call
  // until a project moves it to `decides` (docs/CONFIG.md "Foreman").
  'gate:release',
] as const;

/** Every key Forge reads, with its default. docs/CONFIG.md documents each one. */
export function defaults(): Config {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: {
      name: null,
      description: null,
      kinds: [],
      instructions: { default: ['AGENTS.md', 'CLAUDE.md'] },
      notes: null,
    },
    git: {
      base: 'main',
      remote: 'origin',
      branchPrefix: 'forge/',
    },
    worktrees: {
      root: '../{repo}.worktrees',
      copy: [],
      setup: [],
      // Off while paths is empty: a new worktree clones these from a private seed instead of running setup.
      seed: { paths: [], key: [], setup: [], warm: [] },
      cleanup: 'on-merge',
      cargo: { sharedTarget: false, targetDir: null },
      // Committed paths a command regenerates: `forge integrate` rebuilds them instead of asking the integrator.
      generated: [],
      generatedBy: 'build',
    },
    commands: {
      setup: null,
      build: null,
      test: null,
      lint: null,
      format: null,
      typecheck: null,
      dev: null,
      e2e: null,
    },
    // Configured commands get an allowlisted environment and /bin/sh -c; these widen it.
    commandEnv: { inherit: [], loginShell: false },
    verify: ['build', 'lint', 'test'],
    // After the verify steps pass, run commands.e2e when the diff touches UI paths (or always/never).
    verifyE2e: {
      when: 'ui',
      paths: ['*.html', '*.css', '*.scss', '*.sass', '*.less', '*.svelte', '*.vue', '*.jsx', '*.tsx', '*.astro'],
    },
    verifyIntegrity: 'warn',
    // block fails verify (and refuses commits and pr open) on a likely credential; warn reports it.
    verifySecrets: 'block',
    ports: { base: 4100, span: 100 },
    runtime: {
      provider: 'anthropic',
      host: 'claude-code',
      maxParallelJobs: 3,
      // Warn (never block) when the approver or a lens shares the builder's model family.
      diversity: false,
      // null passes no --effort, so Claude Code's own setting applies; a job's effort overrides it.
      effort: null,
      // Per role (null falls through to effortByComplexity, then effort); a job's effort beats both.
      efforts: Object.fromEntries(EFFORT_ROLES.map((r) => [r, null])) as Record<EffortRole, Effort | null>,
      effortByComplexity: { low: null, medium: null, high: null },
      models: {
        orchestrator: 'inherit',
        planner: 'opus',
        'spec-writer': 'opus',
        designer: 'sonnet',
        builder: 'opus',
        reviewer: 'sonnet',
        approver: 'opus',
        integrator: 'sonnet',
        retro: 'opus',
        judge: 'opus',
        // A cheap yes/no answer per verifier; not in EFFORT_ROLES, so it takes runtime.effort.
        verifier: 'haiku',
      },
      // The builder only (resolveModel): null falls through to runtime.models.builder.
      modelByComplexity: { low: null, medium: null, high: null },
      reworkModel: null,
    },
    tracker: {
      kind: 'local',
      local: { path: '.forge/backlog.md' },
      github: {
        repo: null,
        ready: { labels: [], excludeLabels: [], assignee: null, milestone: null, projectStatus: null },
        claim: { assign: true },
        comments: 'collaborators',
        statusSync: 'none',
        labels: { prefix: 'forge:' },
        project: {
          config: '.github/project-config.yml',
          owner: null,
          number: null,
          statusField: 'Status',
          statusMap: {},
        },
      },
    },
    pipeline: {
      plan: 'auto',
      split: 'ask',
      specApproval: 'always',
      design: 'none',
      maxRounds: 3,
      // Every round counts, whoever opened it; past it only a person's rework opens another (B7).
      // null means twice the job's maxRounds.
      maxTotalRounds: null,
      // null means unlimited; a job's `budget.limits` overrides any key.
      budget: { tokens: null, usd: null, minutes: null, changedLines: null, verifyRetries: 2 },
    },
    review: {
      blockOn: ['blocker', 'major'],
      panel: [
        { name: 'code', always: true },
        { name: 'tests', always: true },
        { name: 'security', model: 'opus', when: 'input handling, auth, secrets, network, dependencies, file or process access' },
      ],
      onPrFeedback: 'changed',
      // Rounds 2+ re-run only the rework panel; round 1 and PR reworks are unaffected.
      onRework: 'narrow',
    },
    approver: {
      alwaysEscalate: [
        'changes to CI/CD, deploy, release or infrastructure config',
        'database or data migrations',
        'new or upgraded dependencies',
        'public API or protocol breaking changes',
        'anything touching credentials, auth or permissions',
      ],
    },
    pr: {
      enabled: true,
      draft: false,
      closeIssue: true,
      labels: [],
      reviewers: [],
      conflicts: 'ask',
      updateStrategy: 'merge',
      integrationReview: 'code-only',
      // Consecutive CI reworks forge sync starts before a red head waits for a person.
      maxCiReworks: 3,
    },
    merge: {
      auto: false,
      method: 'squash',
      autoWhen: [],
      // Empty: the base branch's protection names the required checks (docs/CONFIG.md "Merge").
      requiredChecks: [],
    },
    aiAttribution: 'forbid',
    release: { interim: 'local', versioning: null, mechanism: null, command: null, registry: null, cadence: null, publish: null },
    resources: [],
    components: [],
    repos: [],
    checkout: [],
    backing: [],
    secrets: {},
    // A changed library's linked consumers join the job as verify-only repos (lib/engine/project/downstream.ts).
    downstream: { enabled: true, max: 5, skip: [] },
    infra: {
      mode: 'human',
      allowed: [],
      notes: null,
    },
    usage: {
      track: true,
      pricing: {},
    },
    improve: {
      retroEvery: 10,
      maxLearnings: 30,
      // minJobs 5 and maxJobs 10 match retroEvery: each retro settles what the one before it opened.
      experiments: { minJobs: 5, maxJobs: 10 },
    },
    evals: {
      testPattern: null,
      // A change to these decides how reviewers behave, so the decide gate asks for a recall eval.
      recall: { paths: ['agents/', 'reviewers/', 'lib/engine/pipeline/brief.ts'] },
    },
    dashboard: {
      port: 7400,
    },
    // Opt-in headless orchestrator supervised by `forge dash`; docs/CONFIG.md "Daemon".
    daemon: {
      enabled: false,
      command:
        'claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir {pluginRoot} {session} --permission-mode default --allowedTools {allowedTools}',
      // Only the git/gh forms the skill and agents name. Everything else goes through `forge`:
      // checks, pushes, PRs, tracker writes, history reads (`forge git`, since diff/log/show take
      // --output), finishing a merge or rebase (`forge integrate --continue`) and commits, which go
      // through `forge git add|commit <job>` because the session's cwd is the main checkout, where a
      // bare `git add`/`git commit` would land on the base branch. Blanket git/gh would reach code
      // execution and arbitrary GitHub writes (docs/architecture/daemon-security.md).
      allowedTools: [
        'Agent',
        'Skill',
        'Read',
        'Glob',
        'Grep',
        'Edit',
        'Write',
        'Bash(forge:*)',
        'Bash(git rev-parse:*)',
        'Bash(git merge --abort:*)',
        'Bash(git rebase --abort:*)',
        'Bash(gh pr view:*)',
        'Bash(gh pr list:*)',
        'Bash(gh pr checks:*)',
        'Bash(gh run view:*)',
      ],
      // Matches runtime.maxParallelJobs; each job session drives one job.
      maxConcurrent: 3,
      idleStopMinutes: 30,
      // A turn still running after this long is stopped and its work requeued; null never stops one.
      turnTimeoutMinutes: 60,
      // Sessions run on the Claude login. An ANTHROPIC_API_KEY exported in the shell that ran
      // `forge dash` is dropped from their environment unless this is api-key, because claude
      // would silently bill it instead of the subscription.
      auth: 'subscription',
      // With the daemon on, fills each of a job's tokens, usd and minutes limits that config and the
      // job's own overrides leave unset (lib/engine/metrics/budget.ts effectiveLimits); null turns it off.
      jobBudget: { tokens: 600000000, usd: 150 },
      // Dollars per UTC day the inbox and office sessions may spend, metered from claude's own cost report;
      // above the heaviest day observed here (office $38.66, inbox about $15). null (or a null key): no cap.
      dailyUsd: { inbox: 25, office: 60 },
      // While this project's pool is started and has an active mandate or a running job at an agent
      // stage, the machine dashboard holds one sleep assertion (lib/server/uptime.ts).
      keepAwake: 'auto',
    },
    // Opt-in: the `_office` daemon session decides gates through forge:assistant sub-agents;
    // docs/architecture/foreman.md. Whole-phrase, case-insensitive patterns: a match keeps the
    // gate with a human, and a false positive errs that way on purpose.
    foreman: {
      enabled: false,
      // Widening the repos a job pushes to, publishing a release and filing a milestone are opt-in: an
      // owner adds repo-proposal, release or milestone-approval deliberately (release also needs
      // gate:release out of `reserved`).
      decides: OFFICE_GATES.filter((g) => g !== 'repo-proposal' && g !== 'release' && g !== 'milestone-approval'),
      reserved: [...DEFAULT_RESERVED],
      ship: 'propose',
      // The director loop's own model, effort and pace (#538 reads them).
      model: 'inherit',
      effort: null,
      cadence: 10,
      // forge job assist reads model and effort; assistant routing (#537) reads enabled and sessions.
      assistants: { enabled: true, sessions: 1, model: 'sonnet', effort: null },
      surveyors: { enabled: false, model: 'haiku', effort: null },
      // What `forge mandate new` fills a term it isn't given with. The default decides is intersected
      // with the effective foreman classes there, so it never causes a refusal.
      mandate: {
        until: 'merge-ready',
        maxJobs: 2,
        order: 'graph',
        decides: ['spec-approval', 'split-approval', 'conflicts'],
        budget: { usd: 150, jobs: 5 },
        stall: { cadences: 3, bounces: 3 },
        onUnfinishable: 'park',
      },
    },
    // Enforced by the CLI at forge git add|commit, verify and pr open; docs/CONFIG.md "Protected paths".
    policy: {
      protectedPaths: [
        { paths: ['.github/workflows/**', '.gitlab-ci.yml', 'Jenkinsfile', '.circleci/**'], action: 'escalate', reason: 'CI/CD configuration' },
        { paths: ['Dockerfile*', '**/*.tf'], action: 'escalate', reason: 'infrastructure' },
        { paths: ['**/migrations/**'], action: 'escalate', reason: 'database migrations' },
        { paths: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock'], action: 'escalate', reason: 'dependency lockfile' },
        { paths: ['**/.env*'], action: 'escalate', reason: 'environment files can hold credentials' },
        { paths: ['**/*.pem'], action: 'refuse', reason: 'private keys and certificates are never committed by Forge' },
        { paths: ['.forge/config.yml', '.forge/secrets-allow.txt', '.forge/trackers/**', '.forge/ci/**'], action: 'refuse', reason: "Forge's own policy changes only by a human on the base branch" },
        // Last, so rules 1-7 keep their numbers.
        { ...INSTRUCTIONS_RULE, paths: [...INSTRUCTIONS_RULE.paths] },
      ],
    },
    // Off by default: nothing is archived, deleted or rotated mid-session until a human sets a key;
    // docs/CONFIG.md "Retention".
    retention: {
      jobsDays: null,
      logsDays: null,
      logMaxBytes: null,
    },
    // No cap by default: a start never stops another job's environment; docs/CONFIG.md "Environments".
    environments: {
      maxRunning: null,
    },
    // How long after a merge forge sync watches for a revert, follow-up bugs and churn;
    // docs/CONFIG.md "Outcomes".
    outcomes: {
      windowDays: 14,
    },
    // Off by default: sample 0 queues no post-merge score run; docs/CONFIG.md "Scoring".
    scoring: {
      sample: 0,
      model: null,
    },
    // Off by default: with no webhook and no command Forge spawns nothing and sends nothing;
    // docs/CONFIG.md "Notifications".
    notify: {
      webhooks: [],
      command: null,
    },
    // Repo-wide spend caps per UTC day and month, unlimited by default; separate from the per-job
    // pipeline.budget. docs/CONFIG.md "Repo budget".
    budget: {
      usdPerDay: null,
      usdPerMonth: null,
      tokensPerMonth: null,
      onExceeded: 'hold',
    },
  };
}
