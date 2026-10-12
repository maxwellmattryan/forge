// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForgeError, run } from './util.mjs';

/**
 * Forge state always lives in the primary checkout, even when the CLI runs inside a job
 * worktree, so every session and the dashboard see the same jobs.
 * @param {string} [cwd]
 */
export function mainRoot(cwd = process.cwd()) {
  if (process.env.FORGE_ROOT) return path.resolve(process.env.FORGE_ROOT);
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, allowFail: true });
  if (!common.ok) throw new ForgeError('not inside a git repository (set FORGE_ROOT to override)');
  const dir = common.stdout.trim();
  if (path.basename(dir) === '.git') return path.dirname(dir);
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  if (top.ok) return top.stdout.trim();
  throw new ForgeError(`cannot determine the main checkout from ${dir}`);
}

/** @param {string} [cwd] */
export function forgeDir(cwd) {
  return path.join(mainRoot(cwd), '.forge');
}

/** @param {string} root */
export function paths(root) {
  const dir = path.join(root, '.forge');
  return {
    root,
    repoName: path.basename(root),
    dir,
    config: path.join(dir, 'config.yml'),
    jobs: path.join(dir, 'jobs'),
    locks: path.join(dir, 'locks'),
    runtime: path.join(dir, 'runtime'),
    backlog: path.join(dir, 'backlog.md'),
    notes: path.join(dir, 'notes'),
    reviewers: path.join(dir, 'reviewers'),
    trackers: path.join(dir, 'trackers'),
    /** @param {string} id */
    job: (id) => path.join(dir, 'jobs', id),
  };
}

/** @param {string} root @param {string} p */
export function resolveFrom(root, p) {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

/** @param {string} p */
export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
