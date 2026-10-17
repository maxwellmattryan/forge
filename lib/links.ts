// Local links: while a multi-repo job is in progress, a consumer repo builds against the dependency's
// job worktree instead of its released version (docs/CONFIG.md "Components", ARCHITECTURE.md "Job
// repos"). Links are declared once on `dependsOn` edges and recomputed from config and the job's repos
// before every command; nothing is stored in job.json, and every rendered file lives in the job dir,
// never in a worktree, so an override cannot reach a commit by accident (integrity.ts catches one on purpose).
// Must not import worktree.ts or integrity.ts: both import this module.

import fs from 'node:fs';
import path from 'node:path';
import { LINK_ECOSYSTEMS, isInsidePath, isLinkName, isLinkSource } from './components.ts';
import { isOwnWorktreePath, worktreeRoot } from './config.ts';
import { memberEntry, memberWorktreePath, trustedMemberWorktree } from './job-repos.ts';
import { jobDir } from './jobs.ts';
import type { Config, Job, LinkEcosystem } from './types.ts';
import { run } from './util.ts';

/** A well-formed link from config: declaredLinks. A null repo is the root repo. */
export interface DeclaredLink {
  consumer: string;
  consumerRepo: string | null;
  dependency: string;
  dependencyRepo: string | null;
  ecosystem: LinkEcosystem;
  name: string;
  /** cargo only: the `[patch]` source, `crates-io` by default. */
  source: string | null;
  /** The directory in the dependency's repo. */
  relPath: string;
}

/** One entry of `forge job links`: resolveLinks. */
export interface ResolvedLink {
  consumer: string;
  consumerRepo: string | null;
  dependency: string;
  dependencyRepo: string | null;
  ecosystem: LinkEcosystem;
  name: string;
  source: string | null;
  dir: string | null;
  active: boolean;
  reason: string | null;
}

/** What applyLinks rendered for one consumer repo. */
export interface AppliedLinks {
  /** The shims' directory, put first on PATH; null when no shim was written (or on Windows). */
  binDir: string | null;
  env: Record<string, string>;
  /** The active links, `<ecosystem>:<name>`. */
  labels: string[];
  /** The ecosystems whose tracked lockfiles the command may rewrite. */
  lockfiles: LockEcosystem[];
  /** The consumer's worktree, set when `lockfiles` is non-empty. */
  worktree: string | null;
}

export type LockEcosystem = 'cargo' | 'npm';

const isMap = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const repoOf = (c: { repo?: string | null }): string | null => (typeof c.repo === 'string' ? c.repo : null);

/** Every well-formed link in config, in config order; invalid entries are skipped, as projectGraph does. */
export function declaredLinks(config: Pick<Config, 'components'>): DeclaredLink[] {
  const list = Array.isArray(config.components) ? config.components : [];
  const byName = new Map<string, any[]>();
  for (const c of list) if (isMap(c) && typeof c.name === 'string') byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const out: DeclaredLink[] = [];
  for (const c of list) {
    if (!isMap(c) || typeof c.name !== 'string' || !Array.isArray(c.dependsOn)) continue;
    if (c.repo !== undefined && c.repo !== null && typeof c.repo !== 'string') continue;
    for (const d of c.dependsOn) {
      if (!isMap(d) || d.backing !== undefined || typeof d.component !== 'string' || !isMap(d.link)) continue;
      const l = d.link;
      if (!(LINK_ECOSYSTEMS as readonly unknown[]).includes(l.ecosystem) || !isLinkName(l.ecosystem, l.name)) continue;
      const source = l.source ?? null;
      if (source !== null && (l.ecosystem !== 'cargo' || !isLinkSource(source))) continue;
      const targets = byName.get(d.component) ?? [];
      if (targets.length !== 1) continue;
      const dep = targets[0];
      if (dep.repo !== undefined && dep.repo !== null && typeof dep.repo !== 'string') continue;
      if (repoOf(c) === repoOf(dep)) continue;
      const relPath = l.path ?? dep.path;
      if (!isInsidePath(relPath)) continue;
      out.push({
        consumer: c.name,
        consumerRepo: repoOf(c),
        dependency: dep.name,
        dependencyRepo: repoOf(dep),
        ecosystem: l.ecosystem,
        name: l.name,
        source: l.ecosystem === 'cargo' ? (source ?? 'crates-io') : null,
        relPath,
      });
    }
  }
  return out;
}

/** A repo's trusted worktree for the job, or why there is none. */
function repoWorktree(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, repo: string | null): { worktree: string } | { reason: string } {
  const label = repo ?? path.basename(root);
  const none = { reason: `repo ${label} has no worktree yet; run: forge worktree create ${job.id}` };
  const forged = { reason: `repo ${label}'s stored worktree is not the path Forge computes` };
  if (repo === null) {
    if (!job.worktree || !isDir(job.worktree)) return none;
    return isOwnWorktreePath(root, config, job.id, job.worktree) ? { worktree: job.worktree } : forged;
  }
  const entry = memberEntry(job, repo);
  if (!entry) return { reason: `repo ${label} is not on the job` };
  const trusted = trustedMemberWorktree(root, config, job, repo);
  if (trusted) return { worktree: trusted };
  return !entry.worktree || !isDir(entry.worktree) ? none : forged;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `child` resolves inside `parent`: a symlinked link dir must not lead out of the worktree. */
function resolvesInside(parent: string, child: string): boolean {
  try {
    const rel = path.relative(fs.realpathSync.native(parent), fs.realpathSync.native(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

const sortKey = (l: { consumerRepo: string | null; ecosystem: string; name: string }): string => `${l.consumerRepo === null ? '0' : `1${l.consumerRepo}`}\0${l.ecosystem}\0${l.name}`;

/**
 * Every declared link for the job, active or not. Worktrees are recomputed (isOwnWorktreePath,
 * trustedMemberWorktree), never read from job.json alone, so a forged worktree never reaches `dir`.
 */
export function resolveLinks(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>): ResolvedLink[] {
  const cache = new Map<string | null, ReturnType<typeof repoWorktree>>();
  const wt = (repo: string | null) => {
    if (!cache.has(repo)) cache.set(repo, repoWorktree(root, config, job, repo));
    return cache.get(repo)!;
  };
  const out = declaredLinks(config).map((d): ResolvedLink => {
    const base = { consumer: d.consumer, consumerRepo: d.consumerRepo, dependency: d.dependency, dependencyRepo: d.dependencyRepo, ecosystem: d.ecosystem, name: d.name, source: d.source };
    const consumer = wt(d.consumerRepo);
    if ('reason' in consumer) return { ...base, dir: null, active: false, reason: consumer.reason };
    const dependency = wt(d.dependencyRepo);
    if ('reason' in dependency) return { ...base, dir: null, active: false, reason: dependency.reason };
    const dir = path.join(dependency.worktree, d.relPath);
    if (!isDir(dir) || !resolvesInside(dependency.worktree, dir))
      return { ...base, dir: null, active: false, reason: `${d.relPath} does not exist in repo ${d.dependencyRepo ?? path.basename(root)}'s worktree` };
    return { ...base, dir, active: true, reason: null };
  });
  return out.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
}

/** `s` as one single-quoted sh word, always quoted. */
export const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

const HEADER = (jobId: string) => `# Written by Forge for job ${jobId}: never commit this`;

/**
 * The cargo `--config` file: one `[patch."<source>"]` table per source with `"<name>" = { path = "<dir>" }`.
 * JSON strings are TOML basic strings, so quotes, backslashes and control characters stay escaped.
 */
export function renderCargoConfig(jobId: string, links: { source: string | null; name: string; dir: string }[]): string {
  const bySource = new Map<string, Map<string, string>>();
  for (const l of links) {
    const src = l.source ?? 'crates-io';
    if (!bySource.has(src)) bySource.set(src, new Map());
    const names = bySource.get(src)!;
    if (!names.has(l.name)) names.set(l.name, l.dir);
  }
  const lines = [HEADER(jobId)];
  for (const src of [...bySource.keys()].sort()) {
    lines.push('', `[patch.${JSON.stringify(src)}]`);
    const names = bySource.get(src)!;
    for (const n of [...names.keys()].sort()) lines.push(`${JSON.stringify(n)} = { path = ${JSON.stringify(names.get(n))} }`);
  }
  return `${lines.join('\n')}\n`;
}

/** cmake's link arguments: `-D…=<dir>` per active link, `-U…` per declared inactive one, by name. */
export function cmakeArgs(links: { name: string; dir: string | null }[]): string[] {
  const byName = new Map<string, string | null>();
  for (const l of links) if (!byName.has(l.name) || (byName.get(l.name) === null && l.dir !== null)) byName.set(l.name, l.dir);
  return [...byName.keys()].sort().map((n) => {
    const v = `FETCHCONTENT_SOURCE_DIR_${n.toUpperCase()}`;
    const dir = byName.get(n);
    return dir === null ? `-U${v}` : `-D${v}=${dir}`;
  });
}

/**
 * The start of every shim: find the real tool by walking $PATH, skipping the shim's own directory
 * (and empty entries, which mean the cwd). `set -f` keeps a PATH entry from globbing.
 */
function shimHead(jobId: string, tool: string, binDir: string): string {
  return [
    '#!/bin/sh',
    HEADER(jobId),
    `self=${shQuote(binDir)}`,
    'real=',
    'set -f',
    "oldifs=$IFS; IFS=':'",
    'for d in $PATH; do',
    '  [ -n "$d" ] || continue',
    '  [ "$d" = "$self" ] && continue',
    `  if [ -f "$d/${tool}" ] && [ -x "$d/${tool}" ]; then real="$d/${tool}"; break; fi`,
    'done',
    'IFS=$oldifs',
    'set +f',
    `if [ -z "$real" ]; then echo 'forge links: ${tool} not found on PATH' >&2; exit 127; fi`,
    '',
  ].join('\n');
}

/** `bin/cargo`: the real cargo with `--config <file>`, a leading `+toolchain` kept first. */
export function cargoShim(jobId: string, binDir: string, file: string): string {
  const cfg = shQuote(file);
  return `${shimHead(jobId, 'cargo', binDir)}case "$1" in\n  +*) tc=$1; shift; exec "$real" "$tc" --config ${cfg} "$@" ;;\nesac\nexec "$real" --config ${cfg} "$@"\n`;
}

/** The cmake modes that take no cache arguments: these run unchanged. */
const CMAKE_PASSTHROUGH = ['--build', '--install', '--open', '-E', '-P', '--workflow', '--find-package', '--help', '-h', '--version', '--system-information'];

/** `bin/cmake`: a configure gets the link args first; any other mode runs unchanged. */
export function cmakeShim(jobId: string, binDir: string, args: string[]): string {
  return `${shimHead(jobId, 'cmake', binDir)}for a in "$@"; do\n  case "$a" in\n    ${CMAKE_PASSTHROUGH.join('|')}) exec "$real" "$@" ;;\n  esac\ndone\nexec "$real" ${args.map(shQuote).join(' ')} "$@"\n`;
}

const NPM_INSTALLS = ['install', 'i', 'in', 'add', 'ci', 'clean-install', 'ic', 'install-clean', 'update', 'up', 'upgrade'];

/** `bin/npm`: after an install that passes, installs the dependency dirs as symlinks without saving. */
export function npmShim(jobId: string, binDir: string, dirs: string[]): string {
  return [
    shimHead(jobId, 'npm', binDir),
    'cmd=',
    'for a in "$@"; do',
    '  case "$a" in -*) ;; *) cmd=$a; break ;; esac',
    'done',
    'case "$cmd" in',
    `  ${NPM_INSTALLS.join('|')})`,
    '    "$real" "$@" || exit $?',
    `    exec "$real" install --no-save --no-audit --no-fund --install-links=false ${dirs.map(shQuote).join(' ')} ;;`,
    'esac',
    'exec "$real" "$@"',
    '',
  ].join('\n');
}

/** The PATH line the shell runs before the command, after the login profile. */
export const pathPrelude = (binDir: string): string => `PATH=${shQuote(binDir)}:"$PATH"; export PATH\n`;

/** `<jobDir>/links/<key>`: the member name, or `_root` (a repo name cannot start with `_`). */
export function linkDir(root: string, id: string, repo: string | null): string {
  return path.join(jobDir(root, id), 'links', repo ?? '_root');
}

/** Makes `dir` a real directory: a planted symlink or file there is replaced, never followed. */
function realDir(dir: string): void {
  try {
    const st = fs.lstatSync(dir);
    if (st.isDirectory()) return;
    fs.rmSync(dir, { force: true, recursive: true });
  } catch {}
  fs.mkdirSync(dir);
}

/**
 * Whether a file's `st.mode` already carries `wanted`. Windows keeps only a read-only flag, so Node
 * reports 0o666 or 0o444 whatever chmod was given: compare the owner write bit there, or every call
 * would rewrite an unchanged file.
 */
export function sameMode(actual: number, wanted: number, platform: NodeJS.Platform = process.platform): boolean {
  const bits = platform === 'win32' ? 0o200 : 0o777;
  return (actual & bits) === (wanted & bits);
}

/** Writes `content` (temp file plus rename) only when the file differs; a symlink or FIFO there is replaced. */
function writeIfChanged(file: string, content: string, mode: number): void {
  try {
    const st = fs.lstatSync(file);
    if (st.isFile() && sameMode(st.mode, mode) && fs.readFileSync(file, 'utf8') === content) return;
  } catch {}
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

/** Removes every entry of `dir` not in `keep` (a missing dir is fine). */
function prune(dir: string, keep: Set<string>): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) if (!keep.has(n)) fs.rmSync(path.join(dir, n), { force: true, recursive: true });
}

/**
 * Renders `consumerRepo`'s links into `<jobDir>/links/<key>/` and returns what the command needs, or
 * null when the repo declares none (its dir is removed). Every file is rewritten from config on each
 * call, so a stale or planted shim never survives to the next command.
 */
export function applyLinks(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, consumerRepo: string | null, platform: NodeJS.Platform = process.platform): AppliedLinks | null {
  const mine = resolveLinks(root, config, job).filter((l) => l.consumerRepo === consumerRepo);
  const dir = linkDir(root, job.id, consumerRepo);
  if (!mine.length) {
    fs.rmSync(dir, { force: true, recursive: true });
    return null;
  }
  const active = mine.filter((l): l is ResolvedLink & { dir: string } => l.active && l.dir !== null);
  const of = (e: LinkEcosystem) => active.filter((l) => l.ecosystem === e);
  const shims = platform !== 'win32';
  const binDir = path.join(dir, 'bin');
  const files = new Map<string, string>();
  const bins = new Map<string, string>();
  const env: Record<string, string> = {};
  if (of('cargo').length) {
    const file = path.join(dir, 'cargo-links.toml');
    files.set('cargo-links.toml', renderCargoConfig(job.id, of('cargo')));
    env.FORGE_CARGO_CONFIG = file;
    if (shims) bins.set('cargo', cargoShim(job.id, binDir, file));
  }
  const cmake = mine.filter((l) => l.ecosystem === 'cmake');
  if (cmake.length) {
    const args = cmakeArgs(cmake.map((l) => ({ name: l.name, dir: l.active ? l.dir : null })));
    env.FORGE_CMAKE_ARGS = args.map(shQuote).join(' ');
    if (shims) bins.set('cmake', cmakeShim(job.id, binDir, args));
  }
  if (of('npm').length) {
    const dirs = [...new Map(of('npm').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((l) => [l.name, l.dir])).values()];
    if (shims) bins.set('npm', npmShim(job.id, binDir, dirs));
  }
  fs.mkdirSync(path.dirname(path.dirname(dir)), { recursive: true });
  realDir(path.dirname(dir));
  realDir(dir);
  for (const [n, c] of files) writeIfChanged(path.join(dir, n), c, 0o644);
  if (bins.size) {
    realDir(binDir);
    for (const [n, c] of bins) writeIfChanged(path.join(binDir, n), c, 0o755);
    prune(binDir, new Set(bins.keys()));
  }
  prune(dir, new Set([...files.keys(), ...(bins.size ? ['bin'] : [])]));
  const labels = [...new Set(active.map((l) => `${l.ecosystem}:${l.name}`))].sort();
  const lockfiles = (['cargo', 'npm'] as const).filter((e) => of(e).length);
  const consumerWt = repoWorktree(root, config, job, consumerRepo);
  return {
    binDir: bins.size ? binDir : null,
    env,
    labels,
    lockfiles: 'worktree' in consumerWt ? [...lockfiles] : [],
    worktree: lockfiles.length && 'worktree' in consumerWt ? consumerWt.worktree : null,
  };
}

/** The ecosystems with active links for `consumerRepo` and its worktree, for verify's per-repo lockfile snapshot. */
export function consumerLockfiles(root: string, config: Config, job: Pick<Job, 'id' | 'worktree' | 'repos'>, consumerRepo: string | null): { worktree: string; ecosystems: LockEcosystem[] } | null {
  const active = resolveLinks(root, config, job).filter((l) => l.consumerRepo === consumerRepo && l.active);
  const ecosystems = (['cargo', 'npm'] as const).filter((e) => active.some((l) => l.ecosystem === e));
  if (!ecosystems.length) return null;
  const wt = repoWorktree(root, config, job, consumerRepo);
  return 'worktree' in wt ? { worktree: wt.worktree, ecosystems: [...ecosystems] } : null;
}

const LOCKFILE_NAMES: Record<LockEcosystem, string[]> = { cargo: ['Cargo.lock'], npm: ['package-lock.json', 'npm-shrinkwrap.json'] };

/** The bytes of tracked lockfiles at one moment: snapshotLockfiles. */
export interface LockSnapshot {
  worktree: string;
  files: { rel: string; bytes: Buffer }[];
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  return env;
}

/** The bytes of every tracked lockfile of `ecosystems` in `worktree` that is a regular file now. */
export function snapshotLockfiles(worktree: string, ecosystems: LockEcosystem[]): LockSnapshot {
  const specs = ecosystems.flatMap((e) => LOCKFILE_NAMES[e]).map((n) => `:(glob)**/${n}`);
  const files: LockSnapshot['files'] = [];
  if (!specs.length) return { worktree, files };
  const r = run('git', ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--', ...specs], { cwd: worktree, allowFail: true, env: gitEnv() });
  for (const rel of r.ok ? r.stdout.split('\0').filter(Boolean) : []) {
    const file = path.join(worktree, rel);
    try {
      if (!fs.lstatSync(file).isFile()) continue;
      files.push({ rel, bytes: fs.readFileSync(file) });
    } catch {}
  }
  return { worktree, files };
}

/** Writes back every snapshot file whose bytes changed or that went missing; returns their paths. */
export function restoreLockfiles(snapshot: LockSnapshot): string[] {
  const restored: string[] = [];
  for (const f of snapshot.files) {
    const file = path.join(snapshot.worktree, f.rel);
    try {
      const st = fs.lstatSync(file);
      if (st.isFile() && fs.readFileSync(file).equals(f.bytes)) continue;
      if (!st.isFile()) fs.rmSync(file, { force: true, recursive: true });
    } catch {}
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, f.bytes);
    restored.push(f.rel);
  }
  return restored;
}

/** Deletes `<jobDir>/links/<repo>/`, when a member leaves the job. */
export function removeLinkDir(root: string, id: string, repo: string): void {
  fs.rmSync(linkDir(root, id, repo), { force: true, recursive: true });
}

/**
 * Absolute paths that never belong in a commit (integrity R1): the root's and every member's
 * worktrees root and the job dirs, in native and `/` form. Members whose clone does not resolve are skipped.
 */
export function linkLeakPaths(root: string, config: Config): string[] {
  const dirs = [worktreeRoot(root, config), path.join(root, '.forge', 'jobs')];
  for (const r of Array.isArray(config.repos) ? config.repos : []) {
    try {
      dirs.push(path.dirname(memberWorktreePath(root, config, r.name, 'x')));
    } catch {}
  }
  const out = new Set<string>();
  for (const d of dirs) {
    for (const p of [d, safeRealpath(d)]) {
      if (!p || p.length < 2) continue;
      out.add(p);
      out.add(p.replace(/\\/g, '/'));
    }
  }
  return [...out];
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return null;
  }
}
