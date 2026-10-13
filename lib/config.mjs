// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, paths, exists, resolveFrom } from './paths.mjs';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from './schema.mjs';
import { ForgeError, deepMerge, isClaudeExecutable, readText, splitWords } from './util.mjs';
import * as yaml from './yaml.mjs';

/** Every key Forge reads, with its default. docs/CONFIG.md documents each one. */
export function defaults() {
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
    ports: { base: 4100, span: 100 },
    runtime: {
      provider: 'anthropic',
      host: 'claude-code',
      maxParallelJobs: 3,
      // Warn (never block) when the approver or a lens shares the builder's model family.
      diversity: false,
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
      },
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
      specApproval: 'always',
      design: 'none',
      maxRounds: 3,
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
    },
    merge: {
      auto: false,
      method: 'squash',
      autoWhen: [],
    },
    aiAttribution: 'forbid',
    resources: [],
    services: [],
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
    },
    evals: {
      testPattern: null,
    },
    dashboard: {
      port: 7400,
    },
    // Opt-in headless orchestrator supervised by `forge dash`; docs/CONFIG.md "Daemon".
    daemon: {
      enabled: false,
      command:
        'claude -p --input-format stream-json --output-format stream-json --verbose --plugin-dir {pluginRoot} {session} --permission-mode dontAsk --allowedTools {allowedTools}',
      // Only the git/gh forms the skill and agents name. Everything else goes through `forge`:
      // checks, pushes, PRs, tracker writes, history reads (`forge git`, since diff/log/show take
      // --output) and finishing a merge or rebase (`forge integrate --continue`). Blanket git/gh
      // would reach code execution and arbitrary GitHub writes (docs/ARCHITECTURE.md "Daemon security").
      allowedTools: [
        'Agent',
        'Skill',
        'Read',
        'Glob',
        'Grep',
        'Edit',
        'Write',
        'Bash(forge:*)',
        'Bash(git status:*)',
        'Bash(git rev-parse:*)',
        'Bash(git add:*)',
        'Bash(git rm:*)',
        'Bash(git commit:*)',
        'Bash(git merge --abort:*)',
        'Bash(git rebase --abort:*)',
        'Bash(gh pr view:*)',
        'Bash(gh pr list:*)',
        'Bash(gh pr checks:*)',
        'Bash(gh run view:*)',
      ],
      maxConcurrent: 1,
      idleStopMinutes: 30,
    },
  };
}

/** @param {string} root */
export function loadConfig(root) {
  const p = paths(root);
  const base = defaults();
  if (!exists(p.config)) return { config: base, initialized: false, path: p.config };
  let raw;
  try {
    raw = yaml.parse(readText(p.config)) ?? {};
  } catch (e) {
    throw new ForgeError(`${p.config}: ${/** @type {Error} */ (e).message}`);
  }
  const migrated = migrateConfig(raw);
  const config = deepMerge(base, migrated.config);
  if (Array.isArray(migrated.config?.review?.panel)) config.review.panel = migrated.config.review.panel;
  return { config, initialized: true, path: p.config, migratedFrom: migrated.from };
}

/**
 * Returns human-readable problems; an empty list means the config is usable.
 * @param {any} c @param {string} root
 */
export function validateConfig(c, root) {
  const problems = [];
  const oneOf = (/** @type {string} */ key, /** @type {any} */ value, /** @type {any[]} */ allowed) => {
    if (!allowed.includes(value)) problems.push(`${key} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
  };
  if (c.schemaVersion > CONFIG_SCHEMA_VERSION)
    problems.push(`config schemaVersion ${c.schemaVersion} is newer than this Forge (${CONFIG_SCHEMA_VERSION}); update the plugin`);
  oneOf('tracker.kind', c.tracker.kind, ['local', 'github', 'none', ...customTrackers(root)]);
  oneOf('tracker.github.statusSync', c.tracker.github.statusSync, ['none', 'labels', 'project', 'both']);
  oneOf('pipeline.plan', c.pipeline.plan, ['auto', 'always', 'never']);
  oneOf('pipeline.specApproval', c.pipeline.specApproval, ['always', 'large', 'never']);
  oneOf('pipeline.design', c.pipeline.design, ['none', 'reference', 'mockup']);
  oneOf('pr.conflicts', c.pr.conflicts, ['ask', 'fix', 'defer']);
  oneOf('pr.updateStrategy', c.pr.updateStrategy, ['merge', 'rebase']);
  oneOf('merge.method', c.merge.method, ['squash', 'merge', 'rebase']);
  oneOf('infra.mode', c.infra.mode, ['human', 'plan-only', 'agent']);
  oneOf('worktrees.cleanup', c.worktrees.cleanup, ['on-merge', 'manual']);
  oneOf('aiAttribution', c.aiAttribution, ['forbid', 'allow']);
  if (c.runtime?.diversity !== undefined && typeof c.runtime.diversity !== 'boolean')
    problems.push(`runtime.diversity must be true or false (got ${JSON.stringify(c.runtime.diversity)})`);
  oneOf('verifyIntegrity', c.verifyIntegrity, ['warn', 'block']);
  if (!Array.isArray(c.review.panel) || !c.review.panel.length) problems.push('review.panel needs at least one reviewer');
  for (const r of c.review.panel ?? []) {
    if (!r?.name) problems.push('every review.panel entry needs a name');
    else if (!reviewerChecklist(root, r.name, r.checklist))
      problems.push(`reviewer "${r.name}" has no checklist (looked in .forge/reviewers/ and the plugin's reviewers/)`);
  }
  oneOf('verifyE2e.when', c.verifyE2e?.when, ['ui', 'always', 'never']);
  const e2ePaths = c.verifyE2e?.paths;
  if (!Array.isArray(e2ePaths) || e2ePaths.some((p) => typeof p !== 'string' || !p.trim()))
    problems.push(`verifyE2e.paths must be a list of non-empty strings (got ${JSON.stringify(e2ePaths)})`);
  for (const v of c.verify ?? []) if (!(v in c.commands)) problems.push(`verify step "${v}" is not a key in commands`);
  if (!Number.isInteger(c.pipeline.maxRounds) || c.pipeline.maxRounds < 1) problems.push('pipeline.maxRounds must be a positive integer');
  for (const [k, v] of Object.entries(c.pipeline.budget ?? {})) {
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`pipeline.budget.${k} must be null or a non-negative number (got ${JSON.stringify(v)})`);
    else if (k === 'verifyRetries' && !Number.isInteger(v)) problems.push(`pipeline.budget.verifyRetries must be null or a non-negative integer (got ${v})`);
  }
  problems.push(...daemonProblems(c, root));
  return problems;
}

/**
 * Checked whether or not the daemon is enabled, so a migrated launcher surfaces in
 * `forge config validate` / `forge doctor`. Every message starts with `daemon.` or
 * `dashboard.launcher`, which is how the server picks out the ones that block a start.
 * @param {any} c @param {string} [root] when given, an absolute executable inside it is refused too
 */
export function daemonProblems(c, root) {
  const problems = [];
  const d = c.daemon ?? {};
  if (c.dashboard && typeof c.dashboard === 'object' && 'launcher' in c.dashboard)
    problems.push('dashboard.launcher was replaced by daemon.command in config schemaVersion 2; run `forge migrate` and see docs/CONFIG.md "Daemon"');
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') problems.push(`daemon.enabled must be true or false (got ${JSON.stringify(d.enabled)})`);
  /** @type {string[]|null} */
  let words = null;
  try {
    words = typeof d.command === 'string' ? splitWords(d.command, 'daemon.command') : null;
  } catch (e) {
    problems.push(/** @type {Error} */ (e).message);
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
    const bad = tools.filter((t) => typeof t !== 'string' || !t.trim() || t.includes(','));
    if (bad.length) problems.push(`daemon.allowedTools entries must be non-empty strings without commas (got ${bad.map((t) => JSON.stringify(t)).join(', ')})`);
    if (!tools.includes('Agent')) problems.push('daemon.allowedTools must include Agent: the orchestrator runs every role as a subagent');
    const broad = tools.filter((t) => typeof t === 'string' && broadBash(t));
    if (broad.length)
      problems.push(
        `daemon.allowedTools must not include ${broad.map((t) => JSON.stringify(t)).join(', ')}: those reach arbitrary code execution, file writes or GitHub writes in an unattended session; use the scoped forms and \`forge git\` (docs/CONFIG.md "Daemon")`,
      );
  }
  if (words) problems.push(...wideningFlags(words));
  if (d.maxConcurrent !== 1) problems.push(`daemon.maxConcurrent must be 1: this version supervises one session (got ${JSON.stringify(d.maxConcurrent)})`);
  const idle = d.idleStopMinutes;
  if (idle !== null && !(typeof idle === 'number' && Number.isFinite(idle) && idle > 0))
    problems.push(`daemon.idleStopMinutes must be null or a positive number (got ${JSON.stringify(idle)})`);
  return problems;
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

/** @param {string} tool */
function broadBash(tool) {
  const m = /^Bash(?:\((.*)\))?$/.exec(tool.trim());
  if (!m) return false;
  const spec = (m[1] ?? '').trim().replace(/(:\*|\s*\*)$/, '').trim();
  return BROAD_BASH.some((re) => re.test(spec));
}

/** Modes that never approve more than allowedTools lists. */
const SAFE_PERMISSION_MODES = ['dontAsk', 'default', 'plan'];

/**
 * Claude flags that widen what the unattended session may do beyond `daemon.allowedTools`:
 * skip or relax permission checks, load extra settings/hooks/MCP tools/plugins/agents, grant more
 * directories, or bypass the allowedTools list with a literal one.
 * @param {string[]} words
 */
function wideningFlags(words) {
  const problems = [];
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
      problems.push(`daemon.command must not pass --permission-mode ${value ?? ''}: ${why}; use dontAsk`);
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

/** @param {string} root @param {string} file */
function insideRepo(root, file) {
  if (!path.isAbsolute(file)) return false;
  const real = (/** @type {string} */ p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const rel = path.relative(real(root), real(file));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @param {string} root */
function customTrackers(root) {
  const dir = paths(root).trackers;
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).map((f) => f.replace(/\.mjs$/, ''));
}

/**
 * Repo-local checklists override the plugin catalog so teams can tune a lens without forking.
 * @param {string} root @param {string} name @param {string} [explicit]
 */
export function reviewerChecklist(root, name, explicit) {
  const candidates = [];
  if (explicit) candidates.push(resolveFrom(root, explicit));
  candidates.push(path.join(paths(root).reviewers, `${name}.md`));
  candidates.push(path.join(PLUGIN_ROOT, 'reviewers', `${name}.md`));
  return candidates.find(exists) ?? null;
}

/** @param {any} config @param {string} role */
export function modelFor(config, role) {
  return config.runtime.models[role] ?? config.runtime.models.reviewer ?? 'inherit';
}

/** @param {string} root @param {any} config */
export function worktreeRoot(root, config) {
  return resolveFrom(root, config.worktrees.root.replace('{repo}', path.basename(root)));
}

/** @param {any} config */
export function stringifyConfig(config) {
  const header =
    '# Forge configuration. Every key is documented in docs/CONFIG.md of the Forge plugin.\n' +
    '# Re-run `/forge init` to change answers interactively, or edit this file directly.\n';
  return header + yaml.stringify(config);
}
