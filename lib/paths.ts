import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ForgeError, run } from './util.ts';

/**
 * Forge state always lives in the primary checkout, even when the CLI runs inside a job
 * worktree, so every session and the dashboard see the same jobs.
 */
export function mainRoot(cwd: string = process.cwd()): string {
  if (process.env.FORGE_ROOT) return path.resolve(process.env.FORGE_ROOT);
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, allowFail: true });
  if (!common.ok) throw new ForgeError('not inside a git repository (set FORGE_ROOT to override)');
  const dir = common.stdout.trim();
  if (path.basename(dir) === '.git') return path.dirname(dir);
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd, allowFail: true });
  if (top.ok) return top.stdout.trim();
  throw new ForgeError(`cannot determine the main checkout from ${dir}`);
}

export function forgeDir(cwd?: string): string {
  return path.join(mainRoot(cwd), '.forge');
}

/** Where everything under `.forge/` lives for the checkout at `root`. */
export interface ForgePaths {
  root: string;
  repoName: string;
  dir: string;
  config: string;
  jobs: string;
  locks: string;
  runtime: string;
  backlog: string;
  notes: string;
  reviewers: string;
  trackers: string;
  job: (id: string) => string;
}

export function paths(root: string): ForgePaths {
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
    job: (id: string) => path.join(dir, 'jobs', id),
  };
}

export function resolveFrom(root: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(root, p);
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export const PLUGIN_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** realpath of the deepest existing ancestor, with the rest re-appended: where `p` would land. */
export function landing(p: string): string {
  let dir = p;
  const rest: string[] = [];
  while (!fs.existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) break;
    rest.unshift(path.basename(dir));
    dir = up;
  }
  return path.join(fs.realpathSync(dir), ...rest);
}

/**
 * Paths relative to the worktree (relative inputs resolve against it). The parent is resolved
 * through symlinks, so a linked directory can't lead outside; the entry itself is not, since git
 * stages a symlink as a link. Anything outside the worktree or in a `.git` is refused.
 */
export function resolveWorktreePaths(worktree: string, paths: string[]): string[] {
  const top = fs.realpathSync(worktree);
  return paths.map((p) => {
    if (!p || p.includes('\0')) throw new ForgeError(`invalid path ${JSON.stringify(p)}`);
    const abs = path.resolve(top, p);
    const real = abs === top ? top : path.join(landing(path.dirname(abs)), path.basename(abs));
    const rel = path.relative(top, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new ForgeError(`${JSON.stringify(p)} is outside the job's worktree ${top}`);
    if (rel.split(path.sep).some((seg) => seg.toLowerCase() === '.git')) throw new ForgeError(`${JSON.stringify(p)} is inside .git`);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  });
}
