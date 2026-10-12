// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT, paths, exists, resolveFrom } from './paths.mjs';
import { CONFIG_SCHEMA_VERSION, migrateConfig } from './schema.mjs';
import { FactoryError, deepMerge, readText } from './util.mjs';
import * as yaml from './yaml.mjs';

/** Every key the factory reads, with its default. docs/CONFIG.md documents each one. */
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
      branchPrefix: 'factory/',
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
    ports: { base: 4100, span: 100 },
    runtime: {
      provider: 'anthropic',
      host: 'claude-code',
      maxParallelJobs: 3,
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
      local: { path: '.factory/backlog.md' },
      github: {
        repo: null,
        ready: { labels: [], excludeLabels: [], assignee: null, milestone: null, projectStatus: null },
        claim: { assign: true },
        statusSync: 'none',
        labels: { prefix: 'factory:' },
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
      launcher: null,
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
    throw new FactoryError(`${p.config}: ${/** @type {Error} */ (e).message}`);
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
    problems.push(`config schemaVersion ${c.schemaVersion} is newer than this factory (${CONFIG_SCHEMA_VERSION}); update the plugin`);
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
  if (!Array.isArray(c.review.panel) || !c.review.panel.length) problems.push('review.panel needs at least one reviewer');
  for (const r of c.review.panel ?? []) {
    if (!r?.name) problems.push('every review.panel entry needs a name');
    else if (!reviewerChecklist(root, r.name, r.checklist))
      problems.push(`reviewer "${r.name}" has no checklist (looked in .factory/reviewers/ and the plugin's reviewers/)`);
  }
  for (const v of c.verify ?? []) if (!(v in c.commands)) problems.push(`verify step "${v}" is not a key in commands`);
  if (!Number.isInteger(c.pipeline.maxRounds) || c.pipeline.maxRounds < 1) problems.push('pipeline.maxRounds must be a positive integer');
  return problems;
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
    '# Software factory configuration. Every key is documented in docs/CONFIG.md of the factory plugin.\n' +
    '# Re-run `/factory init` to change answers interactively, or edit this file directly.\n';
  return header + yaml.stringify(config);
}
