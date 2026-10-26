// Loading `.forge/config.yml` over the defaults, and the small readers of a loaded config. The
// defaults, validation, model and effort resolution, and daemon trust live in config-*.ts; their
// names are re-exported here so the many importers of config.ts keep working.
import fs from 'node:fs';
import path from 'node:path';
import { defaults } from './keys/defaults.ts';
import { paths, exists, resolveFrom } from '../paths.ts';
import { FOREMAN_SHIP, migrateConfig } from '../job/schema.ts';
import { deepMerge } from '../shape.ts';
import type { Config, LoadedConfig } from '../types.ts';
import { ForgeError } from '../errors.ts';
import { readText } from '../os/fs.ts';
import * as yaml from '../format/yaml.ts';

// Re-exported, as jobs.ts re-exports jobDir from paths.ts: importers keep one place to import from.
export { defaults } from './keys/defaults.ts';
export { modelProblems, modelFor, validModel, resolveModel, validEffort, resolveEffort } from './models.ts';
export { daemonProblems, PROTECTED, TRUST_ENV, trustDigest, trackerSymlinks, daemonTrust } from './trust.ts';
export { allInstructionFiles } from './validators/instructions.ts';
export { RETENTION_DAYS, validateConfig, foremanProblems, verifyShapeProblems, verifyGroups, verifySteps, panelPathsProblems, pathsOnlyProblems, reviewerChecklist } from './validate.ts';
export { globProblem } from './validators/policy-check.ts';

/**
 * Whether foreman.ship reaches `level`: the levels are ordered (FOREMAN_SHIP), so release includes merge.
 * It reads ship alone; the callers decide whether the foreman must be on.
 */
export function shipAllows(config: Config, level: 'merge' | 'release'): boolean {
  const at = (FOREMAN_SHIP as readonly unknown[]).indexOf(config.foreman?.ship);
  return at >= 0 && at >= FOREMAN_SHIP.indexOf(level);
}

/** foreman.ship merge or release (with the foreman on) counts as merge.auto, for the approver brief and step PR4 only. */
export function autoMerge(config: Config): boolean {
  return config.merge?.auto === true || (config.foreman?.enabled === true && shipAllows(config, 'merge'));
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
  let config: Config;
  try {
    config = deepMerge(base, migrated.config);
  } catch (e) {
    throw new ForgeError(`${p.config}: ${(e as Error).message}`, 'config_invalid');
  }
  if (Array.isArray(migrated.config?.review?.panel)) config.review.panel = migrated.config.review.panel;
  return { config, initialized: true, path: p.config, migratedFrom: migrated.from };
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
