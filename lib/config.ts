import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, paths, exists, resolveFrom } from './paths.ts';
import { componentProblems } from './components.ts';
import { downstreamProblems, releaseProblems, repoProblems } from './member-repos.ts';
import { backingProblems } from './backing-config.ts';
import { secretRefProblems } from './secret-refs-config.ts';
import { placeholderProblems } from './endpoints-config.ts';
import { checkoutProblems } from './checkout-config.ts';
import { notifyProblems } from './notify-config.ts';
import { globProblem, policyProblems } from './policy-check.ts';
import { COMPLEXITIES, CONFIG_SCHEMA_VERSION, DAEMON_AUTH, EFFORT_ROLES, EFFORTS, FOREMAN_SHIP, MODEL_RE, OFFICE_GATES, REPO_BUDGET_MODES, migrateConfig, reservedGateEntry } from './schema.ts';
import type { Config, Effort, EffortRole, EffortSource, LoadedConfig, VerifyEntry } from './types.ts';
import { ForgeError, deepMerge, isClaudeExecutable, readText, splitWords } from './util.ts';
export { globProblem };
import * as yaml from './yaml.ts';

/** Every key Forge reads, with its default. docs/CONFIG.md documents each one. */
export function defaults(): Config {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    project: {
      name: null,
      description: null,
      kinds: [],
      instructions: ['AGENTS.md', 'CLAUDE.md'],
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
        assistant: 'sonnet',
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
    },
    aiAttribution: 'forbid',
    release: { interim: 'local', versioning: null, mechanism: null, command: null, registry: null, cadence: null, publish: null },
    resources: [],
    components: [],
    repos: [],
    checkout: [],
    backing: [],
    secrets: {},
    // A changed library's linked consumers join the job as verify-only repos (lib/downstream.ts).
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
      recall: { paths: ['agents/', 'reviewers/', 'lib/brief.ts'] },
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
      // execution and arbitrary GitHub writes (docs/ARCHITECTURE.md "Daemon security").
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
      // With the daemon on, fills a job's spend limits when none of tokens, usd or minutes is set
      // anywhere (lib/budget.ts effectiveLimits); null turns it off.
      jobBudget: { tokens: 600000000, usd: 150 },
    },
    // Opt-in: the `_office` daemon session decides gates through forge:assistant sub-agents;
    // docs/ARCHITECTURE.md "Foreman". Whole-phrase, case-insensitive patterns: a match keeps the
    // gate with a human, and a false positive errs that way on purpose.
    foreman: {
      enabled: false,
      // Widening the repos a job pushes to, and publishing a release, are opt-in: an owner adds
      // repo-proposal or release deliberately (release also needs gate:release out of `reserved`).
      decides: OFFICE_GATES.filter((g) => g !== 'repo-proposal' && g !== 'release'),
      reserved: [...DEFAULT_RESERVED],
      ship: 'propose',
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

/** budget.*: USD caps null or a number >= 0, tokensPerMonth null or an integer >= 0, onExceeded hold|warn. */
function repoBudgetProblems(c: any): string[] {
  const b = c.budget;
  if (b === undefined) return [];
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return [`budget must be a map (got ${JSON.stringify(b)})`];
  const problems: string[] = [];
  for (const key of ['usdPerDay', 'usdPerMonth']) {
    const v = b[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`budget.${key} must be null or a number >= 0 (got ${JSON.stringify(v)})`);
  }
  const t = b.tokensPerMonth;
  if (t !== null && t !== undefined && (!Number.isInteger(t) || t < 0)) problems.push(`budget.tokensPerMonth must be null or an integer >= 0 (got ${JSON.stringify(t)})`);
  if (b.onExceeded !== undefined && !(REPO_BUDGET_MODES as readonly unknown[]).includes(b.onExceeded)) {
    problems.push(`budget.onExceeded must be one of ${REPO_BUDGET_MODES.join(', ')} (got ${JSON.stringify(b.onExceeded)})`);
  }
  return problems;
}

/** retention.jobsDays and retention.logsDays: 1 day to 10 years. */
export const RETENTION_DAYS = { min: 1, max: 3650 } as const;
/** retention.logMaxBytes: 1 MiB to 1 GiB. */
const LOG_MAX_BYTES = { min: 1_048_576, max: 1_073_741_824 } as const;

/** retention.*: each key null or an integer in its range. */
function retentionProblems(c: any): string[] {
  const r = c.retention;
  if (r === undefined) return [];
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return [`retention must be a map (got ${JSON.stringify(r)})`];
  const problems: string[] = [];
  const check = (key: string, range: { min: number; max: number }) => {
    const v = r[key];
    if (v === null || v === undefined) return;
    if (!Number.isInteger(v) || v < range.min || v > range.max) problems.push(`retention.${key} must be null or an integer from ${range.min} to ${range.max} (got ${JSON.stringify(v)})`);
  };
  check('jobsDays', RETENTION_DAYS);
  check('logsDays', RETENTION_DAYS);
  check('logMaxBytes', LOG_MAX_BYTES);
  return problems;
}

/** environments.maxRunning: running job environments at once. */
const MAX_RUNNING = { min: 1, max: 64 } as const;

/** environments.*: maxRunning null or an integer from 1 to 64. */
function environmentsProblems(c: any): string[] {
  const e = c.environments;
  if (e === undefined) return [];
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return [`environments must be a map (got ${JSON.stringify(e)})`];
  const v = e.maxRunning;
  if (v === null || v === undefined) return [];
  if (!Number.isInteger(v) || v < MAX_RUNNING.min || v > MAX_RUNNING.max) return [`environments.maxRunning must be null or an integer from ${MAX_RUNNING.min} to ${MAX_RUNNING.max} (got ${JSON.stringify(v)})`];
  return [];
}

/** outcomes.windowDays: a day to a year. */
const OUTCOME_WINDOW_DAYS = { min: 1, max: 365 } as const;

/** outcomes.windowDays: an integer in its range. */
function outcomesProblems(c: any): string[] {
  const o = c.outcomes;
  if (o === undefined) return [];
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [`outcomes must be a map (got ${JSON.stringify(o)})`];
  const v = o.windowDays;
  if (v === undefined) return [];
  const { min, max } = OUTCOME_WINDOW_DAYS;
  return !Number.isInteger(v) || v < min || v > max ? [`outcomes.windowDays must be an integer from ${min} to ${max} (got ${JSON.stringify(v)})`] : [];
}

/** scoring.sample a number from 0 to 1, scoring.model null or a model MODEL_RE accepts. */
function scoringProblems(c: any): string[] {
  const s = c.scoring;
  if (s === undefined) return [];
  if (s === null || typeof s !== 'object' || Array.isArray(s)) return [`scoring must be a map (got ${JSON.stringify(s)})`];
  const problems: string[] = [];
  const v = s.sample;
  if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) problems.push(`scoring.sample must be a number from 0 to 1 (got ${JSON.stringify(v)})`);
  const m = s.model;
  if (m !== undefined && m !== null && !validModel(m)) problems.push(`scoring.model must be a model alias or id (letters, digits and . _ : - [ ]) or null (got ${JSON.stringify(m)})`);
  return problems;
}

/** foreman.reserved's default: topics that always stay with a human. */
const DEFAULT_RESERVED = [
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

/** foreman.ship merge (with the foreman on) counts as merge.auto, for the approver brief and step PR4 only. */
export function autoMerge(config: Config): boolean {
  return config.merge?.auto === true || (config.foreman?.enabled === true && config.foreman?.ship === 'merge');
}

/**
 * `opts.text`: config.yml's contents already read (null: absent), so a caller that verified
 * those bytes parses the same ones.
 */
export function loadConfig(root: string, opts: { text?: string | null } = {}): LoadedConfig {
  const p = paths(root);
  const base = defaults();
  const text = 'text' in opts ? opts.text : exists(p.config) ? readText(p.config) : null;
  if (text === null || text === undefined) return { config: base, initialized: false, path: p.config };
  let raw: any;
  try {
    raw = yaml.parse(text) ?? {};
  } catch (e) {
    throw new ForgeError(`${p.config}: ${(e as Error).message}`, 'config_invalid');
  }
  const migrated = migrateConfig(raw);
  const config = deepMerge(base, migrated.config);
  if (Array.isArray(migrated.config?.review?.panel)) config.review.panel = migrated.config.review.panel;
  return { config, initialized: true, path: p.config, migratedFrom: migrated.from };
}

/**
 * Returns human-readable problems; an empty list means the config is usable.
 */
export function validateConfig(c: any, root: string): string[] {
  const problems: string[] = [];
  const oneOf = (key: string, value: any, allowed: any[]) => {
    if (!allowed.includes(value)) problems.push(`${key} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
  };
  if (c.schemaVersion > CONFIG_SCHEMA_VERSION)
    problems.push(`config schemaVersion ${c.schemaVersion} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update the plugin`);
  oneOf('tracker.kind', c.tracker.kind, ['local', 'github', 'none', ...customTrackers(root)]);
  oneOf('tracker.github.statusSync', c.tracker.github.statusSync, ['none', 'labels', 'project', 'both']);
  oneOf('pipeline.plan', c.pipeline.plan, ['auto', 'always', 'never']);
  oneOf('pipeline.split', c.pipeline.split, ['ask', 'auto', 'never']);
  oneOf('pipeline.specApproval', c.pipeline.specApproval, ['always', 'large', 'never']);
  oneOf('pipeline.design', c.pipeline.design, ['none', 'reference', 'mockup']);
  oneOf('pr.conflicts', c.pr.conflicts, ['ask', 'fix', 'defer']);
  oneOf('pr.updateStrategy', c.pr.updateStrategy, ['merge', 'rebase']);
  oneOf('pr.integrationReview', c.pr.integrationReview, ['always', 'code-only']);
  oneOf('merge.method', c.merge.method, ['squash', 'merge', 'rebase']);
  oneOf('infra.mode', c.infra.mode, ['human', 'plan-only', 'agent']);
  oneOf('worktrees.cleanup', c.worktrees.cleanup, ['on-merge', 'manual']);
  oneOf('aiAttribution', c.aiAttribution, ['forbid', 'allow']);
  problems.push(...releaseProblems(c.release, 'release'));
  if (c.runtime?.diversity !== undefined && typeof c.runtime.diversity !== 'boolean')
    problems.push(`runtime.diversity must be true or false (got ${JSON.stringify(c.runtime.diversity)})`);
  oneOf('verifyIntegrity', c.verifyIntegrity, ['warn', 'block']);
  oneOf('verifySecrets', c.verifySecrets, ['block', 'warn']);
  if (!Array.isArray(c.review.panel) || !c.review.panel.length) problems.push('review.panel needs at least one reviewer');
  for (const r of c.review.panel ?? []) {
    if (!r?.name) {
      problems.push('every review.panel entry needs a name');
      continue;
    }
    if (!reviewerChecklist(root, r.name, r.checklist))
      problems.push(`reviewer "${r.name}" has no checklist (looked in .forge/reviewers/ and the plugin's reviewers/)`);
    if (r.needsApp !== undefined && typeof r.needsApp !== 'boolean')
      problems.push(`review.panel "${r.name}".needsApp must be true or false (got ${JSON.stringify(r.needsApp)})`);
    if (r.alwaysOnRework !== undefined && typeof r.alwaysOnRework !== 'boolean')
      problems.push(`review.panel "${r.name}".alwaysOnRework must be true or false (got ${JSON.stringify(r.alwaysOnRework)})`);
    if (r.paths !== undefined) problems.push(...panelPathsProblems(r.name, r.paths));
    problems.push(...pathsOnlyProblems(r));
  }
  oneOf('verifyE2e.when', c.verifyE2e?.when, ['ui', 'always', 'never']);
  const e2ePaths = c.verifyE2e?.paths;
  if (!Array.isArray(e2ePaths) || e2ePaths.some((p: any) => typeof p !== 'string' || !p.trim()))
    problems.push(`verifyE2e.paths must be a list of non-empty strings (got ${JSON.stringify(e2ePaths)})`);
  problems.push(...generatedProblems(c));
  problems.push(...verifyProblems(c));
  problems.push(...effortProblems(c));
  problems.push(...modelProblems(c));
  if (c.review?.onRework !== undefined) oneOf('review.onRework', c.review.onRework, ['narrow', 'full']);
  if (!Number.isInteger(c.pipeline.maxRounds) || c.pipeline.maxRounds < 1) problems.push('pipeline.maxRounds must be a positive integer');
  const total = c.pipeline.maxTotalRounds;
  if (total !== null && total !== undefined && !(Number.isInteger(total) && total >= 1))
    problems.push(`pipeline.maxTotalRounds must be null or a positive integer (got ${JSON.stringify(total)})`);
  const ci = c.pr.maxCiReworks;
  if (ci !== undefined && !(Number.isInteger(ci) && ci >= 0)) problems.push(`pr.maxCiReworks must be an integer >= 0 (got ${JSON.stringify(ci)})`);
  for (const [k, v] of Object.entries(c.pipeline.budget ?? {})) {
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`pipeline.budget.${k} must be null or a non-negative number (got ${JSON.stringify(v)})`);
    else if (k === 'verifyRetries' && !Number.isInteger(v)) problems.push(`pipeline.budget.verifyRetries must be null or a non-negative integer (got ${v})`);
  }
  problems.push(...daemonProblems(c, root));
  problems.push(...foremanProblems(c));
  problems.push(...policyProblems(c));
  problems.push(...retentionProblems(c));
  problems.push(...environmentsProblems(c));
  problems.push(...outcomesProblems(c));
  problems.push(...scoringProblems(c));
  problems.push(...notifyProblems(c));
  problems.push(...componentProblems(c));
  problems.push(...repoProblems(c, root));
  problems.push(...checkoutProblems(c));
  problems.push(...backingProblems(c));
  problems.push(...secretRefProblems(c));
  problems.push(...placeholderProblems(c));
  problems.push(...downstreamProblems(c));
  problems.push(...repoBudgetProblems(c));
  problems.push(...improveProblems(c));
  return problems;
}

/** improve.experiments and evals.recall: the settlement thresholds and the recall gate's paths. */
function improveProblems(c: any): string[] {
  const problems: string[] = [];
  const exp = c.improve?.experiments;
  const positive = (k: 'minJobs' | 'maxJobs') => {
    const v = exp?.[k];
    if (Number.isInteger(v) && v >= 1) return true;
    problems.push(`improve.experiments.${k} must be a positive integer (got ${JSON.stringify(v)})`);
    return false;
  };
  if (!exp || typeof exp !== 'object' || Array.isArray(exp)) problems.push(`improve.experiments must be a map with minJobs and maxJobs (got ${JSON.stringify(exp)})`);
  else if (positive('minJobs') && positive('maxJobs') && exp.maxJobs < exp.minJobs)
    problems.push(`improve.experiments.maxJobs (${exp.maxJobs}) must be at least minJobs (${exp.minJobs})`);
  const paths = c.evals?.recall?.paths;
  if (!Array.isArray(paths) || paths.some((p: unknown) => typeof p !== 'string' || !p.trim()))
    problems.push(`evals.recall.paths must be a list of non-empty strings (got ${JSON.stringify(paths)?.slice(0, 80)})`);
  return problems;
}

/** foreman.*: at run time an unknown `decides` class is ignored and an invalid `reserved` fails closed. */
export function foremanProblems(c: any): string[] {
  const f = c.foreman;
  if (f === undefined) return [];
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return [`foreman must be a map (got ${JSON.stringify(f)})`];
  const problems: string[] = [];
  if (f.enabled !== undefined && typeof f.enabled !== 'boolean') problems.push(`foreman.enabled must be true or false (got ${JSON.stringify(f.enabled)})`);
  if (!Array.isArray(f.decides)) problems.push(`foreman.decides must be a list of gate classes (got ${JSON.stringify(f.decides)})`);
  else
    for (const g of f.decides)
      if (!(OFFICE_GATES as readonly unknown[]).includes(g)) problems.push(`foreman.decides entry ${JSON.stringify(g)} is not a gate class (${OFFICE_GATES.join(' | ')})`);
  if (!Array.isArray(f.reserved) || f.reserved.some((p: unknown) => typeof p !== 'string' || !p.trim()))
    problems.push(`foreman.reserved must be a list of non-empty strings (got ${JSON.stringify(f.reserved)}); until fixed, every gate stays with a human`);
  else
    for (const p of f.reserved as string[]) {
      if (reservedGateEntry(p) !== 'invalid') continue;
      const t = p.trim();
      const exact = /^gate:/.test(t) && !/\s/.test(t);
      problems.push(
        `foreman.reserved entry ${JSON.stringify(t)} ${exact ? 'names no gate class' : 'is a mis-written class reservation'} (write exactly gate:<class>, lowercase with no spaces, the class one of ${OFFICE_GATES.join(' | ')}); until fixed, every gate stays with a human`,
      );
    }
  if (!(FOREMAN_SHIP as readonly unknown[]).includes(f.ship)) problems.push(`foreman.ship must be one of ${FOREMAN_SHIP.join(' | ')} (got ${JSON.stringify(f.ship)})`);
  return problems;
}

/**
 * Why `verify` can't be run as written: not a list, an entry that is neither a step name nor a
 * non-empty list of step names (a nested list included), or a step listed twice. A name with no
 * command is not a shape problem: verify reports that step skipped.
 */
export function verifyShapeProblems(verify: unknown): string[] {
  if (!Array.isArray(verify)) return [`verify must be a list of step names or lists of step names (got ${JSON.stringify(verify)})`];
  const isName = (n: unknown): n is string => typeof n === 'string' && n.trim() !== '';
  const problems: string[] = [];
  const seen = new Set<string>();
  const twice = new Set<string>();
  verify.forEach((entry: unknown, i) => {
    const names = isName(entry) ? [entry] : Array.isArray(entry) && entry.length && entry.every(isName) ? entry : null;
    if (!names) {
      problems.push(`verify entry ${i + 1} must be a step name or a non-empty list of step names (got ${JSON.stringify(entry)})`);
      return;
    }
    for (const n of names) {
      if (seen.has(n) && !twice.has(n)) {
        twice.add(n);
        problems.push(`verify step "${n}" is listed more than once`);
      }
      seen.add(n);
    }
  });
  return problems;
}

/** Shape problems, then every step name (inside groups too) that is not a key in `commands`. */
function verifyProblems(c: any): string[] {
  const commands = c.commands && typeof c.commands === 'object' ? c.commands : {};
  const unknown = [...new Set(verifySteps(c.verify))].filter((n) => !Object.hasOwn(commands, n));
  return [...verifyShapeProblems(c.verify), ...unknown.map((n) => `verify step "${n}" is not a key in commands`)];
}

/** `verify` as groups run in order; a plain step name is a group of one. Throws on the first shape problem. */
export function verifyGroups(verify: unknown): string[][] {
  const [problem] = verifyShapeProblems(verify);
  if (problem) throw new ForgeError(`verify: ${problem}`);
  return (verify as VerifyEntry[]).map((e) => (typeof e === 'string' ? [e] : [...e]));
}

/** Every step name in `verify`, groups flattened, ignoring anything malformed: for "is X listed" checks. */
export function verifySteps(verify: unknown): string[] {
  if (!Array.isArray(verify)) return [];
  return verify.flatMap((e: unknown) => (typeof e === 'string' ? [e] : Array.isArray(e) ? e.filter((n): n is string => typeof n === 'string') : []));
}

/**
 * A panel entry's `paths`: the same rules as `worktrees.generated`, so a glob can't read as an
 * option, pathspec magic or an exclusion, or point outside the repo. Each message names the lens.
 */
export function panelPathsProblems(name: string, paths: unknown): string[] {
  const key = `review.panel ${JSON.stringify(String(name))}.paths`;
  if (!Array.isArray(paths)) return [`${key} must be a list of paths or globs (got ${JSON.stringify(paths)})`];
  return paths.map((g) => globProblem(g, key)).filter((p): p is string => p !== null);
}

/** A panel entry's `pathsOnly`: a boolean, and only on an entry with paths to hit. */
export function pathsOnlyProblems(r: { name?: unknown; pathsOnly?: unknown; paths?: unknown }): string[] {
  if (r.pathsOnly === undefined) return [];
  const key = `review.panel ${JSON.stringify(String(r.name ?? ''))}.pathsOnly`;
  if (typeof r.pathsOnly !== 'boolean') return [`${key} must be true or false (got ${JSON.stringify(r.pathsOnly)})`];
  const hasPaths = Array.isArray(r.paths) && r.paths.some((p) => typeof p === 'string' && p.trim());
  return r.pathsOnly && !hasPaths ? [`${key} needs non-empty paths: a pathsOnly lens with none would never run`] : [];
}

/**
 * runtime.modelByComplexity and runtime.reworkModel: a map with known keys, and each non-null value
 * a model MODEL_RE accepts. resolveModel treats anything else as unset, so these only report.
 */
export function modelProblems(c: any): string[] {
  const problems: string[] = [];
  const bad = (key: string, v: unknown) => `${key} must be a model alias or id (letters, digits and . _ : - [ ]) or null (got ${JSON.stringify(v)})`;
  const m = c.runtime?.modelByComplexity;
  if (m !== undefined && m !== null) {
    if (typeof m !== 'object' || Array.isArray(m)) problems.push(`runtime.modelByComplexity must be a map (got ${JSON.stringify(m)})`);
    else
      for (const [k, v] of Object.entries(m)) {
        if (!(COMPLEXITIES as readonly string[]).includes(k)) problems.push(`runtime.modelByComplexity.${k} must be ${COMPLEXITIES.slice(0, -1).join(', ')} or ${COMPLEXITIES.at(-1)}`);
        else if (v !== null && !validModel(v)) problems.push(bad(`runtime.modelByComplexity.${k}`, v));
      }
  }
  const r = c.runtime?.reworkModel;
  if (r !== undefined && r !== null && !validModel(r)) problems.push(bad('runtime.reworkModel', r));
  return problems;
}

/**
 * runtime.efforts, runtime.effortByComplexity and a panel entry's `effort`. Not daemonProblems:
 * none of them reaches a session's argv (sessions resolve with no role), and resolveEffort treats
 * an invalid value as unset anyway.
 */
function effortProblems(c: any): string[] {
  const problems: string[] = [];
  const levels = `${EFFORTS.join(' | ')}, or null`;
  const isMap = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const map = (key: string, keys: readonly string[], unknownKey: (k: string) => string) => {
    const m = c.runtime?.[key];
    if (m === undefined || m === null) return;
    if (!isMap(m)) return problems.push(`runtime.${key} must be a map (got ${JSON.stringify(m)})`);
    for (const [k, v] of Object.entries(m)) {
      if (!keys.includes(k)) problems.push(unknownKey(k));
      else if (v !== null && !validEffort(v)) problems.push(`runtime.${key}.${k} must be one of ${levels} (got ${JSON.stringify(v)})`);
    }
  };
  map('efforts', EFFORT_ROLES, (k) => `runtime.efforts.${k} is not a role (${EFFORT_ROLES.join(' | ')})`);
  map('effortByComplexity', COMPLEXITIES, (k) => `runtime.effortByComplexity.${k} must be ${COMPLEXITIES.slice(0, -1).join(', ')} or ${COMPLEXITIES.at(-1)}`);
  for (const r of Array.isArray(c.review?.panel) ? c.review.panel : []) {
    if (!isMap(r) || r.effort === undefined || r.effort === null || validEffort(r.effort)) continue;
    problems.push(`review.panel entry ${JSON.stringify(String(r.name ?? ''))}: effort must be one of ${levels} (got ${JSON.stringify(r.effort)})`);
  }
  return problems;
}

/** `worktrees.generated` and `generatedBy`: each glob usable, and a configured command to rebuild them. */
function generatedProblems(c: any): string[] {
  const gen = c.worktrees?.generated;
  if (gen === undefined) return [];
  if (!Array.isArray(gen)) return [`worktrees.generated must be a list of paths or globs (got ${JSON.stringify(gen)})`];
  const problems = gen.map((g: unknown) => globProblem(g)).filter((p): p is string => p !== null);
  const by = c.worktrees?.generatedBy;
  if (gen.length && (typeof by !== 'string' || !Object.hasOwn(c.commands ?? {}, by) || c.commands[by] == null))
    problems.push(`worktrees.generatedBy must name a configured command (commands.${typeof by === 'string' ? by : '<name>'} is not set)`);
  return problems;
}

/**
 * Checked whether or not the daemon is enabled, so a migrated launcher surfaces in
 * `forge config validate` / `forge doctor`. Every message starts with `daemon.`,
 * `dashboard.launcher` or `runtime.effort`: each one blocks a session start. runtime.effort is
 * here because it becomes a word of every session's argv, so an invalid one fails closed.
 * When `root` is given, an absolute executable inside it is refused too.
 */
export function daemonProblems(c: any, root?: string): string[] {
  const problems: string[] = [];
  const d = c.daemon ?? {};
  if (c.dashboard && typeof c.dashboard === 'object' && 'launcher' in c.dashboard)
    problems.push('dashboard.launcher was replaced by daemon.command in config schemaVersion 2; run `forge migrate` and see docs/CONFIG.md "Daemon"');
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') problems.push(`daemon.enabled must be true or false (got ${JSON.stringify(d.enabled)})`);
  let words: string[] | null = null;
  try {
    words = typeof d.command === 'string' ? splitWords(d.command, 'daemon.command') : null;
  } catch (e) {
    problems.push((e as Error).message);
  }
  if (typeof d.command !== 'string' || !d.command.trim()) problems.push('daemon.command must be a non-empty command template');
  else if (!words) {
    // Already reported: the template doesn't split.
  } else if (d.command.includes('{prompt}'))
    problems.push('daemon.command contains {prompt}: that is a dashboard.launcher shell template, and the daemon sends its turn on stdin instead; rewrite it as described in docs/CONFIG.md "Daemon"');
  else if (!isClaudeExecutable(words[0] ?? '') || (root && insideRepo(root, words[0])))
    problems.push(`daemon.command must run claude: its first word must be claude (on PATH) or an absolute path to claude outside the repo (got ${JSON.stringify(words[0] ?? '')})`);
  else if (!words.includes('{session}')) problems.push('daemon.command must contain {session} as its own word so the daemon can pin and resume its session id');
  const tools = d.allowedTools;
  if (!Array.isArray(tools)) problems.push(`daemon.allowedTools must be a list of tool names (got ${JSON.stringify(tools)})`);
  else {
    const bad = tools.filter((t: any) => typeof t !== 'string' || !t.trim() || t.includes(','));
    if (bad.length) problems.push(`daemon.allowedTools entries must be non-empty strings without commas (got ${bad.map((t: any) => JSON.stringify(t)).join(', ')})`);
    if (!tools.includes('Agent')) problems.push('daemon.allowedTools must include Agent: the orchestrator runs every role as a subagent');
    const broad = tools.filter((t: any) => typeof t === 'string' && broadBash(t));
    if (broad.length)
      problems.push(
        `daemon.allowedTools must not include ${broad.map((t: any) => JSON.stringify(t)).join(', ')}: those reach arbitrary code execution, file writes or GitHub writes in an unattended session; use the scoped forms and \`forge git\` (docs/CONFIG.md "Daemon")`,
      );
  }
  if (words) problems.push(...wideningFlags(words));
  const max = d.maxConcurrent;
  if (!(Number.isInteger(max) && max >= 1 && max <= 16)) problems.push(`daemon.maxConcurrent must be an integer from 1 to 16 (got ${JSON.stringify(max)})`);
  const idle = d.idleStopMinutes;
  if (idle !== null && !(typeof idle === 'number' && Number.isFinite(idle) && idle > 0))
    problems.push(`daemon.idleStopMinutes must be null or a positive number (got ${JSON.stringify(idle)})`);
  const turn = d.turnTimeoutMinutes;
  if (turn !== null && !(typeof turn === 'number' && Number.isFinite(turn) && turn > 0))
    problems.push(`daemon.turnTimeoutMinutes must be null or a positive number (got ${JSON.stringify(turn)})`);
  if (!DAEMON_AUTH.includes(d.auth)) problems.push(`daemon.auth must be one of ${DAEMON_AUTH.join(' | ')} (got ${JSON.stringify(d.auth)})`);
  problems.push(...jobBudgetProblems(d.jobBudget));
  const effort = c.runtime?.effort ?? null;
  if (effort !== null && !validEffort(effort))
    problems.push(`runtime.effort must be one of ${EFFORTS.join(' | ')}, or null (got ${JSON.stringify(effort)})`);
  return problems;
}

const JOB_BUDGET_KEYS = ['tokens', 'usd', 'minutes'];

/** daemon.jobBudget: null, or a map of tokens (an integer), usd and minutes, each null or a number >= 0. */
function jobBudgetProblems(b: unknown): string[] {
  if (b === null || b === undefined) return [];
  if (typeof b !== 'object' || Array.isArray(b)) return [`daemon.jobBudget must be null or a map of ${JOB_BUDGET_KEYS.join(', ')} (got ${JSON.stringify(b)})`];
  const problems: string[] = [];
  for (const [k, v] of Object.entries(b)) {
    if (!JOB_BUDGET_KEYS.includes(k)) problems.push(`daemon.jobBudget.${k} is not a key (use ${JOB_BUDGET_KEYS.join(', ')})`);
    else if (v === null) continue;
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`daemon.jobBudget.${k} must be null or a number >= 0 (got ${JSON.stringify(v)})`);
    else if (k === 'tokens' && !Number.isInteger(v)) problems.push(`daemon.jobBudget.tokens must be null or an integer >= 0 (got ${v})`);
  }
  return problems;
}

/** Carries the supervisor's trustDigest into the daemon session's environment. */
export const TRUST_ENV = 'FORGE_DAEMON_TRUST';

/**
 * Fingerprint of what decides the code `forge` runs from the main checkout: the checkout's
 * realpath, `.forge/config.yml` (commands run through a shell; daemon.* starts sessions), the
 * secret scanner's allowlist `.forge/secrets-allow.txt` (a session that could edit it could allow
 * its own leak), the custom tracker modules imported from `.forge/trackers/` and the verifiers in
 * `.forge/verifiers/`, which gate the pipeline. An unreadable entry hashes as a
 * marker rather than throwing, so a tampered file can't turn the check into a crash.
 * `configBytes` is config.yml as already read (null: absent).
 */
export function trustDigest(root: string, configBytes?: Buffer | null): string {
  const h = crypto.createHash('sha256');
  const add = (label: string, data: string | Buffer) => h.update(`${label}\0${Buffer.byteLength(data)}\0`).update(data);
  let real = path.resolve(root);
  try {
    real = fs.realpathSync(root);
  } catch {}
  add('root', real);
  const p = paths(root);
  const file = (label: string, f: string) => {
    try {
      add(label, fs.readFileSync(f));
    } catch (e) {
      add(label, `!${(e as any).code ?? 'unreadable'}`);
    }
  };
  if (configBytes === undefined) file('config', p.config);
  else add('config', configBytes ?? '!ENOENT');
  file('secrets-allow', path.join(p.dir, 'secrets-allow.txt'));
  // Verifiers gate the pipeline: a session that could weaken a block verifier could pass its own work.
  for (const [label, base] of [['trackers', p.trackers], ['verifiers', p.verifiers]] as const) {
    for (const { rel, link, dir } of walk(base)) {
      const f = path.join(base, rel);
      if (link) {
        try {
          add(`link ${label === 'trackers' ? '' : 'verifiers/'}${rel}`, fs.readlinkSync(f));
        } catch {}
      } else if (!dir) file(`${label}/${rel}`, f);
    }
  }
  return h.digest('hex');
}

/** Symlinks under `.forge/trackers/`, which a daemon session refuses. */
export function trackerSymlinks(root: string): string[] {
  return symlinksUnder(paths(root).trackers);
}

/** Paths under dir that are symlinks. */
function symlinksUnder(dir: string): string[] {
  return walk(dir).filter((e) => e.link).map((e) => e.rel);
}

/**
 * Every entry under `dir`, sorted, without following symlinks (`readdir`'s recursive mode
 * follows them, so a link loop never ends).
 */
function walk(dir: string, prefix = ''): { rel: string; link: boolean; dir: boolean }[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((e) => {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const me = { rel, link: e.isSymbolicLink(), dir: e.isDirectory() };
      return me.dir ? [me, ...walk(dir, rel)] : [me];
    });
}

/**
 * In a daemon session (FORGE_DAEMON=1), every `forge` call must see the files the supervisor
 * fingerprinted when a human started it. The session can write files in this checkout, so
 * without this an agent misled by tracker text could rewrite `commands.*` and have
 * `forge verify` run them, or edit `daemon.*` for the next spawn. Fails closed. config.yml is
 * read once and `configText` returned, so the caller parses exactly the bytes that were checked.
 */
export function daemonTrust(root: string, env: NodeJS.ProcessEnv = process.env): { problem: string | null; configText?: string | null } {
  if (env.FORGE_DAEMON !== '1') return { problem: null };
  const refuse = (why: string) => ({ problem: `forge refuses to run in this daemon session: ${why}` });
  const want = env[TRUST_ENV];
  if (typeof want !== 'string' || !/^[0-9a-f]{64}$/.test(want))
    return refuse(`${TRUST_ENV} is missing, so it can't check that .forge/config.yml is the one a human started the daemon with`);
  // A symlink's target can change without the link changing, so the digest couldn't pin it.
  const links = trackerSymlinks(root);
  if (links.length) return refuse(`.forge/trackers/ contains symlinks (${links.join(', ')}), which the daemon can't pin; a human replaces them with files`);
  let bytes: Buffer | null = null;
  try {
    bytes = fs.readFileSync(paths(root).config);
  } catch (e) {
    if ((e as any).code !== 'ENOENT') return refuse(`.forge/config.yml is unreadable (${(e as any).code})`);
  }
  if (trustDigest(root, bytes) !== want)
    return refuse(
      '.forge/config.yml, .forge/secrets-allow.txt, .forge/trackers/ or .forge/verifiers/ changed since a human started the daemon (or this is another checkout). Only a human may change what Forge executes: stop here and leave the change for them to review.',
    );
  return { problem: null, configText: bytes === null ? null : bytes.toString('utf8') };
}

// Bash rules that on their own reach code execution (`git -c`, `git rebase --exec`, `git grep -O`,
// config-defined drivers), file writes into .git (`--output` on the diff family, `git mv`; either can rewrite
// .git/config) or arbitrary GitHub writes (`gh api`). Known forms, not an exhaustive list.
const BROAD_BASH = [
  /^\*?$/,
  /^(git|gh)$/,
  /^git -/,
  /^git (config|grep|submodule|bisect|difftool|mergetool|filter-branch)\b/,
  // `git mv a x/../.git/config` reports "invalid path" yet still renames the file and exits 0.
  /^git (diff|log|show|range-diff|whatchanged|format-patch|mv)\b/,
  /^git rebase(?! --(continue|abort|skip)\b)/,
  /^gh (api|extension|alias|auth|secret|codespace)\b/,
];

function broadBash(tool: string): boolean {
  const m = /^Bash(?:\((.*)\))?$/.exec(tool.trim());
  if (!m) return false;
  const spec = (m[1] ?? '').trim().replace(/(:\*|\s*\*)$/, '').trim();
  return BROAD_BASH.some((re) => re.test(spec));
}

/**
 * Modes that never approve more than allowedTools lists without a human: `default` asks one in the
 * dashboard (`manual` is the name claude now lists for it), `dontAsk` refuses. `auto` is left out:
 * only a human in the dashboard may put a session there (lib/daemon.ts PERMISSION_MODES).
 */
const SAFE_PERMISSION_MODES = ['dontAsk', 'default', 'manual', 'plan'];

/**
 * Claude flags that widen what the unattended session may do beyond `daemon.allowedTools`:
 * skip or relax permission checks, load extra settings/hooks/MCP tools/plugins/agents, grant more
 * directories, or bypass the allowedTools list with a literal one.
 */
function wideningFlags(words: string[]): string[] {
  const problems: string[] = [];
  const why = 'it widens the unattended session\'s permissions beyond daemon.allowedTools (docs/CONFIG.md "Daemon")';
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (!w.startsWith('--')) continue;
    const eq = w.indexOf('=');
    const flag = eq > 0 ? w.slice(0, eq) : w;
    const value = eq > 0 ? w.slice(eq + 1) : words[i + 1];
    if (['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--settings', '--mcp-config', '--add-dir', '--permission-prompt-tool', '--agents'].includes(flag))
      problems.push(`daemon.command must not pass ${flag}: ${why}`);
    else if (flag === '--permission-mode' && !SAFE_PERMISSION_MODES.includes(value ?? ''))
      problems.push(`daemon.command must not pass --permission-mode ${value ?? ''}: ${why}; use default or manual (ask a human in the dashboard) or dontAsk (refuse)`);
    else if (flag === '--plugin-dir' && value !== '{pluginRoot}') problems.push(`daemon.command must not pass --plugin-dir ${value ?? ''}: only {pluginRoot} may be loaded, since ${why}`);
    else if ((flag === '--allowedTools' || flag === '--allowed-tools') && value !== '{allowedTools}')
      problems.push(`daemon.command must pass ${flag} {allowedTools}, not a literal list, so daemon.allowedTools is validated`);
    // claude reads these flags' values variadically: a bare word after the value becomes one more
    // tool or plugin dir. {session} expands to --session-id/--resume, so it may follow.
    if (['--allowedTools', '--allowed-tools', '--plugin-dir'].includes(flag)) {
      const next = words[i + (eq > 0 ? 1 : 2)];
      if (next !== undefined && !next.startsWith('-') && next !== '{session}')
        problems.push(`daemon.command must not put ${JSON.stringify(next)} after ${flag}'s value: claude would read it as another value`);
    }
  }
  return problems;
}

function insideRepo(root: string, file: string): boolean {
  if (!path.isAbsolute(file)) return false;
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(root), real(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function customTrackers(root: string): string[] {
  const dir = paths(root).trackers;
  if (!exists(dir)) return [];
  // A .d.ts is a declaration, not an adapter; a name with both .mjs and .ts is listed once.
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.mjs') || (f.endsWith('.ts') && !f.endsWith('.d.ts'))).map((f) => f.replace(/\.(mjs|ts)$/, ''));
  return [...new Set(names)];
}

/**
 * Repo-local checklists override the plugin catalog so teams can tune a lens without forking.
 */
export function reviewerChecklist(root: string, name: string, explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolveFrom(root, explicit));
  candidates.push(path.join(paths(root).reviewers, `${name}.md`));
  candidates.push(path.join(PLUGIN_ROOT, 'reviewers', `${name}.md`));
  return candidates.find(exists) ?? null;
}

const APP_LENSES = ['ui', 'ux', 'accessibility', 'design'];

/** Whether a lens reviews the running app: the panel entry's needsApp, else the built-in name default. */
export function lensNeedsApp(config: Config, lens: string): boolean {
  const entry = (config.review.panel ?? []).find((r) => r?.name === lens);
  return typeof entry?.needsApp === 'boolean' ? entry.needsApp : APP_LENSES.includes(lens);
}

// A repo that wrote its own panel before v21 has no way to know its security lens could be
// narrowed, so the name default keeps it re-running; `alwaysOnRework: false` opts out.
const REWORK_ALWAYS_LENSES = ['security'];

/** Whether a lens re-runs on every rework round: the panel entry's alwaysOnRework, else the name default. */
export function lensAlwaysOnRework(config: Config, lens: string): boolean {
  const entry = (config.review.panel ?? []).find((r) => r?.name === lens);
  return typeof entry?.alwaysOnRework === 'boolean' ? entry.alwaysOnRework : REWORK_ALWAYS_LENSES.includes(lens);
}

export function modelFor(config: Config, role: string): string {
  return config.runtime.models[role] ?? config.runtime.models.reviewer ?? 'inherit';
}

/** `v` when it is a string MODEL_RE accepts (at most 200 characters), else null. */
export function validModel(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 200 && MODEL_RE.test(v) ? v : null;
}

/**
 * The one place a spawn's model is picked: step's spawn action, its `start --model` and the
 * roster all read it. Reviewers take their lens's panel `model`, then runtime.models.reviewer.
 * The builder takes the first valid of: runtime.reworkModel on a rework round whose only inputs
 * are review findings, runtime.modelByComplexity[job.complexity], runtime.models.builder, inherit.
 * The judge on a real (non-eval) job is the post-merge scorer: scoring.model, then runtime.models.judge.
 */
export function resolveModel(config: Config, job: { complexity?: unknown; round?: unknown; kind?: unknown } | null, role: string, rework: readonly string[] = []): string {
  if (role === 'judge' && job && job.kind !== 'eval') {
    return validModel(config.scoring?.model) ?? config.runtime.models.judge ?? 'inherit';
  }
  if (role.startsWith('reviewer:')) {
    const lens = role.slice('reviewer:'.length);
    return config.review.panel.find((p) => p.name === lens)?.model ?? config.runtime.models.reviewer ?? 'inherit';
  }
  if (role === 'builder') {
    const runtime: Partial<Config['runtime']> = config.runtime ?? {};
    const round = job?.round;
    // Only a pure review rework: a failed verify, feedback or an answer may need the stronger model.
    const reviewOnly = typeof round === 'number' && round >= 2 && rework.length === 1 && rework[0] === 'review';
    const fromRework = reviewOnly ? validModel(runtime.reworkModel) : null;
    if (fromRework) return fromRework;
    const complexity = (COMPLEXITIES as readonly unknown[]).includes(job?.complexity) ? (job!.complexity as string) : null;
    const byComplexity: Record<string, unknown> | null | undefined = runtime.modelByComplexity;
    const fromComplexity = complexity && byComplexity && typeof byComplexity === 'object' ? validModel(byComplexity[complexity]) : null;
    if (fromComplexity) return fromComplexity;
    return validModel(runtime.models?.builder) ?? 'inherit';
  }
  return config.runtime.models[role] ?? 'inherit';
}

/** `v` when it is one of EFFORTS, else null: anything else read from job.json or config counts as unset. */
export function validEffort(v: unknown): Effort | null {
  return (EFFORTS as readonly unknown[]).includes(v) ? (v as Effort) : null;
}

/** One level above `level` in EFFORTS order; max stays max. */
function bumpEffort(level: Effort): Effort {
  return EFFORTS[Math.min(EFFORTS.indexOf(level) + 1, EFFORTS.length - 1)];
}

/**
 * The one place effort levels combine: the daemon's argv, `forge job step`, the brief, the roster
 * and /api/state all call it, so they can never disagree. A null level passes nothing.
 * First valid of: job.effort, the lens's panel `effort` (reviewers), runtime.efforts.<base role>,
 * runtime.effortByComplexity[job.complexity], runtime.effort. With no `role` (a daemon session runs
 * the orchestrator) only the job and runtime.effort layers apply. A builder on a rework round
 * (round >= 2) gets one level more unless the human set the job's own effort.
 */
export function resolveEffort(
  config: Config,
  job?: { effort?: unknown; complexity?: unknown; round?: unknown } | null,
  role?: string | null,
): { level: Effort | null; source: EffortSource; rework?: true } {
  const own = validEffort(job?.effort);
  if (own) return { level: own, source: 'job' };
  let found: { level: Effort | null; source: EffortSource } | null = null;
  const base = role ? role.split(':')[0] : null;
  if (role && base) {
    const runtime: Partial<Config['runtime']> = config.runtime ?? {};
    const lens = base === 'reviewer' && role.startsWith('reviewer:') ? role.slice('reviewer:'.length) : null;
    const panel = lens && Array.isArray(config.review?.panel) ? config.review.panel.find((p) => p?.name === lens) : undefined;
    const fromPanel = validEffort(panel?.effort);
    const efforts: Record<string, unknown> | undefined = runtime.efforts;
    const fromRole = efforts && typeof efforts === 'object' && Object.hasOwn(efforts, base) ? validEffort(efforts[base]) : null;
    const complexity = (COMPLEXITIES as readonly unknown[]).includes(job?.complexity) ? (job!.complexity as string) : null;
    const byComplexity: Record<string, unknown> | undefined = runtime.effortByComplexity;
    const fromComplexity = complexity && byComplexity && typeof byComplexity === 'object' ? validEffort(byComplexity[complexity]) : null;
    if (fromPanel) found = { level: fromPanel, source: 'panel' };
    else if (fromRole) found = { level: fromRole, source: 'role' };
    else if (fromComplexity) found = { level: fromComplexity, source: 'complexity' };
  }
  if (!found) {
    const fallback = validEffort(config.runtime?.effort);
    found = fallback ? { level: fallback, source: 'config' } : { level: null, source: 'none' };
  }
  const round = job?.round;
  if (base === 'builder' && found.level && typeof round === 'number' && round >= 2) return { level: bumpEffort(found.level), source: found.source, rework: true };
  return found;
}

export function worktreeRoot(root: string, config: Config): string {
  return resolveFrom(root, config.worktrees.root.replace('{repo}', path.basename(root)));
}

/**
 * Whether `wt` is, as a string, the worktree path Forge computes for job `id`: `<worktreesRoot>/<id>`
 * as configured (what `forge worktree create` stores) or under the root's resolved path (a root
 * reached through a symlink). job.json's `worktree` is agent-writable, so anything else, even a value
 * that resolves to the same directory, is not trusted where a shell or an editor would read it.
 */
export function isOwnWorktreePath(root: string, config: Config, id: string, wt: unknown): boolean {
  if (typeof wt !== 'string' || !wt) return false;
  const configured = worktreeRoot(root, config);
  if (wt === path.join(configured, id)) return true;
  try {
    return wt === path.join(fs.realpathSync(configured), id);
  } catch {
    return false;
  }
}

export function stringifyConfig(config: Config): string {
  const header =
    '# Forge configuration. Every key is documented in docs/CONFIG.md of the Forge plugin.\n' +
    '# Re-run `/forge init` to change answers interactively, or edit this file directly.\n';
  return header + yaml.stringify(config);
}
