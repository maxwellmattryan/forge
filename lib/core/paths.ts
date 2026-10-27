// Where things live on disk: the main checkout's root, the `.forge/` layout, job dirs and the
// plugin's own root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git } from '#integrations/git/runner.ts';
import { ForgeError } from './errors.ts';

/**
 * Forge state always lives in the primary checkout, even when the CLI runs inside a job
 * worktree, so every session and the dashboard see the same jobs.
 */
export function mainRoot(cwd: string = process.cwd()): string {
  return process.env.FORGE_ROOT ? path.resolve(process.env.FORGE_ROOT) : checkoutRoot(cwd);
}

/** The main checkout of the git repo at `cwd`, ignoring `FORGE_ROOT`: a worktree or subdirectory resolves to its root repo. */
export function checkoutRoot(cwd: string): string {
  const common = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { allowFail: true });
  if (!common.ok) throw new ForgeError('not inside a git repository (set FORGE_ROOT to override)', 'not_a_repo');
  const dir = common.stdout.trim();
  if (path.basename(dir) === '.git') return path.dirname(dir);
  const top = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true });
  if (top.ok) return top.stdout.trim();
  throw new ForgeError(`cannot determine the main checkout from ${dir}`);
}

/** Where everything under `.forge/` lives for the checkout at `root`. */
export interface ForgePaths {
  root: string;
  repoName: string;
  dir: string;
  config: string;
  jobs: string;
  /** Archive records of finished jobs (lib/core/job/archive.ts); gitignored like jobs/. */
  archive: string;
  locks: string;
  runtime: string;
  /** The CLI copies of each job's job.json and events.jsonl, which Forge reads (jobRecordDir). */
  records: string;
  /** The Office's mandates (lib/office/mandates/), one `<id>.md` each: runtime state, outside every session's write roots. */
  mandates: string;
  /** The owner's chats with the Foreman (lib/office/chat/), one `<id>/` each: written only by the dashboard server. */
  chats: string;
  backlog: string;
  notes: string;
  reviewers: string;
  trackers: string;
  /** Repo-local verifiers: read from the main checkout only. */
  verifiers: string;
  /** Machine-local settings (member repo clone paths); gitignored, never written by Forge. */
  local: string;
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
    archive: path.join(dir, 'archive'),
    locks: path.join(dir, 'locks'),
    runtime: path.join(dir, 'runtime'),
    records: path.join(dir, 'runtime', 'job-records'),
    mandates: path.join(dir, 'runtime', 'mandates'),
    chats: path.join(dir, 'runtime', 'chats'),
    backlog: path.join(dir, 'backlog.md'),
    notes: path.join(dir, 'notes'),
    reviewers: path.join(dir, 'reviewers'),
    trackers: path.join(dir, 'trackers'),
    verifiers: path.join(dir, 'verifiers'),
    local: path.join(dir, 'local.yml'),
    job: (id: string) => path.join(dir, 'jobs', id),
  };
}

/**
 * The machine index directory: `FORGE_HOME` when set and non-empty (a relative value resolves
 * against the cwd), else `~/.forge`. It sits outside every repo and holds no project policy.
 */
export function forgeHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.FORGE_HOME ? path.resolve(env.FORGE_HOME) : path.join(os.homedir(), '.forge');
}

/** Where the machine index's files live. */
export interface MachinePaths {
  dir: string;
  /** The registered projects and the machine settings (lib/engine/project/machine-index.ts). */
  projects: string;
  locks: string;
  /** The machine dashboard's runtime record (lib/engine/ops/dashboard-record.ts): `{pid, url, startedAt}`, never the token. */
  dashboard: string;
  /** The machine dashboard's runtime files (0700): the login service's log and the uptime record (lib/engine/project/login-service.ts). */
  runtime: string;
}

export function machinePaths(home: string = forgeHome()): MachinePaths {
  return { dir: home, projects: path.join(home, 'projects.json'), locks: path.join(home, 'locks'), dashboard: path.join(home, 'dashboard.json'), runtime: path.join(home, 'runtime') };
}

export function jobDir(root: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) throw new ForgeError(`invalid job id "${id}"`);
  return paths(root).job(id);
}

/**
 * `.forge/runtime/job-records/<id>`: the CLI copy of a job's job.json and events.jsonl. A session's
 * file tools can't reach `.forge/runtime/` (Claude Code's deny rules and hooks/write-guard.ts), so
 * the copy is what Forge reads; the job folder's files are a mirror for agents to read. Jobs created
 * before the copy existed have none and keep reading their job folder.
 */
export function jobRecordDir(root: string, id: string): string {
  jobDir(root, id);
  return path.join(paths(root).records, id);
}

const isDir = (p: string): boolean => fs.lstatSync(p, { throwIfNoEntry: false })?.isDirectory() === true;

/** The job file Forge reads: the CLI copy's when the job has one, else the job folder's. */
export function stateFile(root: string, id: string, name: 'job.json' | 'events.jsonl'): string {
  const rec = jobRecordDir(root, id);
  return isDir(rec) ? path.join(rec, name) : path.join(jobDir(root, id), name);
}

/** Every copy of a job file a store write updates, the CLI copy first. */
export function jobFiles(root: string, id: string, name: 'job.json' | 'events.jsonl'): string[] {
  const rec = jobRecordDir(root, id);
  const folder = path.join(jobDir(root, id), name);
  return isDir(rec) ? [path.join(rec, name), folder] : [folder];
}

/** Whether `.forge/runtime/` and `job-records/` are real directories, never symlinks a recursive delete would follow. */
function recordsSafe(root: string): boolean {
  const p = paths(root);
  return isDir(p.runtime) && isDir(p.records);
}

/** An empty CLI copy for a job being created, replacing any stale one left without a job folder. */
export function resetJobRecord(root: string, id: string): void {
  const dir = jobRecordDir(root, id);
  fs.mkdirSync(paths(root).records, { recursive: true });
  if (!recordsSafe(root)) throw new ForgeError(`${paths(root).records} is not a directory (a symlink?); refusing to write job records there`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir);
}

/** Removes a job's CLI copy, with its job folder (delete, archive). */
export function removeJobRecord(root: string, id: string): void {
  if (recordsSafe(root)) fs.rmSync(jobRecordDir(root, id), { recursive: true, force: true });
}

/** `<jobDir>/links/<key>`: the member name, or `_root` (a repo name cannot start with `_`). */
export function linkDir(root: string, id: string, repo: string | null): string {
  return path.join(jobDir(root, id), 'links', repo ?? '_root');
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

export const PLUGIN_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where `npm run dev`'s watching Vite build lands and `forge dash --dev` serves from. node_modules/
 * is already gitignored and outside dashboard/, so neither git, the build stamp, Tailwind's @source
 * nor svelte-check ever sees it; `npm ci` wiping it is fine for a cache.
 */
export const DEV_DIST_DIR: string = path.join(PLUGIN_ROOT, 'node_modules', '.cache', 'forge', 'dashboard-dev');

/** How a checkout without dashboard/dist/ builds it: the server's 503, doctor's warning and the tests' skip reason all name it. */
export const BUILD_DASHBOARD = 'npm ci && npm run build:dashboard';

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
