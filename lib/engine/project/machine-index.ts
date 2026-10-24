// The machine index: the projects registered on this machine in `<FORGE_HOME>/projects.json`,
// never their config, commands or secrets. An entry is a name (from the directory, never config),
// the root's realpath and when it was added. Every function takes the index directory as `home`,
// so tests never touch the env. A file this Forge can't read (bad JSON, a bad entry, a newer
// version) is refused and never rewritten.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeError } from '#core/errors.ts';
import { checkoutRoot, exists, machinePaths, mainRoot, paths } from '#core/paths.ts';
import { AGENT_TEXT_MAX, readRegular, writeJsonPrivate } from '#core/os/fs.ts';
import { withLock } from '#core/os/lock.ts';
import { runSteps } from '#core/versions/steps.ts';
import { MACHINE_INDEX_VERSION, MACHINE_STEPS } from '#core/versions/machine.ts';

export interface MachineProject {
  name: string;
  /** The root repo's realpath. */
  path: string;
  /** ISO time it was registered. */
  addedAt: string;
}

export interface MachineIndex {
  schemaVersion: number;
  projects: MachineProject[];
}

/** `missing`: the path is gone or not a directory; `not-initialized`: it has no `.forge/config.yml`. */
export type ProjectStatus = 'ok' | 'missing' | 'not-initialized';

/** A project name: later a URL segment (`/api/p/:project/`), so no `/`, no leading `.` or `-`, at most 64 characters. */
export const PROJECT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ENTRY_KEYS = ['addedAt', 'name', 'path'];
const INDEX_KEYS = ['projects', 'schemaVersion'];

/** The root directory's basename made a valid name: lowercased, other characters `-`, leading non-alphanumerics dropped, at most 64. */
export function defaultProjectName(root: string): string {
  const name = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
  return name || 'project';
}

/** An absolute path that a later reader can carry in JSON lines, argv and URLs: no NUL, CR or LF. */
const safePath = (p: unknown): p is string => typeof p === 'string' && path.isAbsolute(p) && !/[\0\r\n]/.test(p);

const sameKeys = (o: object, keys: string[]): boolean => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && k.every((x, i) => x === keys[i]);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The index at `home`, upgraded through MACHINE_STEPS; an empty one when there is no file. Throws, naming the file, on anything else. */
export function readMachineIndex(home: string): MachineIndex {
  const file = machinePaths(home).projects;
  const bad = (why: string) => new ForgeError(`${file} ${why}; fix or remove it by hand (Forge never rewrites it)`);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { schemaVersion: MACHINE_INDEX_VERSION, projects: [] };
  const bytes = readRegular(file, AGENT_TEXT_MAX);
  if (typeof bytes === 'string') throw bad(`is ${bytes}`);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw bad('is not JSON');
  }
  if (!isObject(value) || !Array.isArray(value.projects) || !Object.keys(value).every((k) => INDEX_KEYS.includes(k))) throw bad('is not {schemaVersion, projects: [...]}');
  const from = value.schemaVersion ?? 1;
  if (!Number.isInteger(from) || (from as number) < 1) throw bad('has a schemaVersion that is not a positive integer');
  if ((from as number) > MACHINE_INDEX_VERSION) throw bad(`was written by a newer Forge (schemaVersion ${from}, this Forge reads up to ${MACHINE_INDEX_VERSION})`);
  const up = runSteps(MACHINE_STEPS, value, from as number) as { projects: unknown[] };
  const names = new Set<string>();
  const roots = new Set<string>();
  const projects = up.projects.map((e, i): MachineProject => {
    if (!isObject(e) || !sameKeys(e, ENTRY_KEYS)) throw bad(`has an entry at ${i} that is not {name, path, addedAt}`);
    if (typeof e.name !== 'string' || !PROJECT_NAME.test(e.name)) throw bad(`has an entry at ${i} whose name is not ${PROJECT_NAME}`);
    if (!safePath(e.path)) throw bad(`has an entry at ${i} whose path is not absolute or has a NUL or newline`);
    if (typeof e.addedAt !== 'string') throw bad(`has an entry at ${i} whose addedAt is not a string`);
    if (names.has(e.name)) throw bad(`has two entries named ${e.name}`);
    if (roots.has(e.path)) throw bad(`has two entries for ${JSON.stringify(e.path)}`);
    names.add(e.name);
    roots.add(e.path);
    return { name: e.name, path: e.path, addedAt: e.addedAt };
  });
  return { schemaVersion: MACHINE_INDEX_VERSION, projects };
}

/** `~` and `~/…` expanded, then resolved against `cwd`. */
function resolveArg(p: string, cwd: string): string {
  const home = p === '~' || p.startsWith('~/') || p.startsWith(`~${path.sep}`) ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(cwd, home);
}

const isDirectory = (p: string): boolean => {
  try {
    return fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() === true;
  } catch {
    return false;
  }
};

/** The main checkout of the git repo at `abs`, or not_a_repo. */
function checkoutOf(abs: string): string {
  if (!isDirectory(abs)) throw new ForgeError(`${abs} is not a directory`, 'not_a_repo');
  try {
    return checkoutRoot(abs);
  } catch (e) {
    if (e instanceof ForgeError && e.code === 'not_a_repo') throw new ForgeError(`${abs} is not inside a git repository`, 'not_a_repo');
    throw e;
  }
}

/**
 * The realpath of the project root `forge project add` registers: mainRoot() without a path, else
 * the main checkout of the repo at `p` (FORGE_ROOT ignored), so a worktree or a subdirectory resolves
 * to its root repo. It must have `.forge/config.yml`; a member repo has none and is found through its root.
 */
export function resolveProjectRoot(p: string | undefined, cwd: string = process.cwd()): string {
  const root = p === undefined ? mainRoot(cwd) : checkoutOf(resolveArg(p, cwd));
  if (!exists(paths(root).config)) throw new ForgeError(`${root} has no .forge/config.yml`, 'not_initialized', '/forge init');
  return fs.realpathSync(root);
}

/** One locked change: `home` and its locks dir made private, the index re-read inside the lock, written atomically at 0600. */
function update<T>(home: string, change: (index: MachineIndex) => { index: MachineIndex | null; result: T }): T {
  const mp = machinePaths(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    fs.mkdirSync(mp.locks, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  return withLock(path.join(mp.locks, 'projects'), () => {
    const { index, result } = change(readMachineIndex(home));
    if (index) writeJsonPrivate(mp.projects, index);
    return result;
  });
}

/**
 * Registers the realpath `root` (resolveProjectRoot's). The same path again is a no-op (`added:
 * false`, the file untouched, whatever the name); a name another path holds is refused.
 */
export function addProject(home: string, root: string, opts: { name?: string; now?: string } = {}): { added: boolean; project: MachineProject } {
  const name = opts.name ?? defaultProjectName(root);
  if (!PROJECT_NAME.test(name)) throw new ForgeError(`--name ${JSON.stringify(name).slice(0, 80)} must match ${PROJECT_NAME}`, 'usage', 'forge help project add');
  if (!safePath(root)) throw new ForgeError(`${JSON.stringify(root).slice(0, 200)} is not an absolute path without a NUL or newline, so it can't be registered`);
  const decide = (index: MachineIndex): { added: boolean; project: MachineProject } | null => {
    const same = index.projects.find((p) => p.path === root);
    if (same) return { added: false, project: same };
    const taken = index.projects.find((p) => p.name === name);
    if (taken) throw new ForgeError(`the name ${name} is already registered for ${taken.path}, so ${root} needs another`, 'failed', `forge project add ${JSON.stringify(root)} --name <name>`);
    return null;
  };
  // Read (and refuse a bad file) before creating anything, and return a no-op before writing.
  const early = decide(readMachineIndex(home));
  if (early) return early;
  return update(home, (index) => {
    const again = decide(index);
    if (again) return { index: null, result: again };
    const project: MachineProject = { name, path: root, addedAt: opts.now ?? new Date().toISOString() };
    return { index: { schemaVersion: MACHINE_INDEX_VERSION, projects: [...index.projects, project] }, result: { added: true, project } };
  });
}

/** Whether `remove`'s argument is a path rather than a name. */
const looksLikePath = (arg: string): boolean => path.isAbsolute(arg) || arg.includes('/') || arg.includes(path.sep) || arg.startsWith('.') || arg.startsWith('~');

/**
 * Drops one entry, matched by name or by path. An existing directory resolves to its main
 * checkout's realpath, as add does; a path that is gone matches on its resolved string. It never
 * touches the project's directory.
 */
export function removeProject(home: string, arg: string, cwd: string = process.cwd()): { removed: MachineProject } {
  let match: (p: MachineProject) => boolean;
  if (looksLikePath(arg)) {
    const abs = resolveArg(arg, cwd);
    let real = abs;
    if (isDirectory(abs)) {
      try {
        real = fs.realpathSync(checkoutOf(abs));
      } catch {
        real = fs.realpathSync(abs);
      }
    }
    match = (p) => p.path === real || p.path === abs;
  } else match = (p) => p.name === arg;
  const notFound = () => new ForgeError(`no registered project ${JSON.stringify(arg).slice(0, 200)}`, 'not_found', 'forge project list');
  if (!readMachineIndex(home).projects.some(match)) throw notFound();
  return update(home, (index) => {
    const removed = index.projects.find(match);
    if (!removed) throw notFound();
    return { index: { schemaVersion: MACHINE_INDEX_VERSION, projects: index.projects.filter((p) => p !== removed) }, result: { removed } };
  });
}

function statusOf(root: string): ProjectStatus {
  if (!isDirectory(root)) return 'missing';
  return exists(path.join(root, '.forge', 'config.yml')) ? 'ok' : 'not-initialized';
}

/** Every registered project with its status, sorted by name. Never writes: a missing project stays until `remove`. */
export function listProjects(home: string): { home: string; projects: (MachineProject & { status: ProjectStatus })[] } {
  const projects = readMachineIndex(home)
    .projects.map((p) => ({ ...p, status: statusOf(p.path) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { home, projects };
}
